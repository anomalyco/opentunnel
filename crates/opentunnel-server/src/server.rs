//! Wires the service together and runs the listeners.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;
use tracing::{debug, error, info, warn};

use crate::acme::{Acme, AcmeConfig};
use crate::admin::TokenAdmin;
use crate::analytics::Analytics;
use crate::clock::Clock;
use crate::cluster::{self, Cluster};
use crate::config::{Config, DnsKind, HttpMode, IssuerKind};
use crate::dns::DnsProvider;
use crate::http::{self, App, Stats};
use crate::issuer::{Issuer, LocalCa};
use crate::jobs::{self, Jobs, ServerCertificates};
use crate::net::{self, AcceptErrors};
use crate::relay;
use crate::service::Service;
use crate::store::Store;
use crate::tls;
use crate::website::Website;

/// What one public connection may cost, for the connection limit: a bridge is ~50 KB in production.
const CONNECTION_MEMORY: u64 = 64 * 1024;
/// The most public connections handled at once, whatever the memory.
const MAX_CONNECTIONS: usize = 60_000;
/// API TLS handshakes at once. A handshake is ~0.1 ms of CPU (the key exchange and signature) plus a round trip
/// to the client, so this keeps the core busy while a reconnect storm cannot queue tens of thousands of them.
const MAX_HANDSHAKES: usize = 256;
/// How long a new API connection waits for a handshake slot. Beyond it the connection is closed, so its client
/// retries after its backoff (which grows on each failure) instead of timing out in a queue that only grows: a
/// storm then drains at the rate the machine can attach.
const HANDSHAKE_QUEUE_TIMEOUT: Duration = Duration::from_secs(1);
/// A handshake gives its slot up after this long, while it waits for a slow client to finish.
const HANDSHAKE_SLOT_HOLD: Duration = Duration::from_secs(1);
/// At shutdown, after the drain, how long HTTP connections get to finish their requests.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(10);

pub struct Server {
    pub app: Arc<App>,
    pub jobs: Arc<Jobs>,
    pub certificates: Arc<ServerCertificates>,
    pub resolver: Arc<tls::ServerCertificate>,
    /// The other machines, with `INTERNAL_LISTEN`.
    pub cluster: Option<Arc<Cluster>>,
    pub config: Config,
    /// The local CA's certificate, when that is the issuer.
    pub local_ca: Option<String>,
    handshakes: Semaphore,
}

/// An HTTP client for ACME, Cloudflare, analytics and the Worker, trusting Mozilla's roots plus `extra`.
pub fn http_client(extra: Option<&std::path::Path>) -> Result<reqwest::Client> {
    let mut roots: Vec<reqwest::Certificate> = webpki_root_certs::TLS_SERVER_ROOT_CERTS
        .iter()
        .filter_map(|certificate| reqwest::Certificate::from_der(certificate).ok())
        .collect();
    if let Some(path) = extra {
        let pem = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
        roots.extend(reqwest::Certificate::from_pem_bundle(&pem)?);
    }
    Ok(reqwest::Client::builder()
        .tls_certs_only(roots)
        .user_agent(concat!("opentunnel-server/", env!("CARGO_PKG_VERSION")))
        .build()?)
}

impl Server {
    pub async fn build(config: Config, clock: Clock) -> Result<Self> {
        let url = config
            .database_url
            .as_deref()
            .filter(|url| !url.is_empty())
            .context("DATABASE_URL is not set")?;
        let store = Store::connect(url, config.database_pool_size)?;
        // Nothing listens until the database answers, so health checks fail and Fly routes elsewhere. A machine
        // that cannot reach it for STARTUP_DB_TIMEOUT_MS exits non-zero so Fly restarts it (`[[restart]]`).
        let limit = Some(config.startup_db_timeout_ms)
            .filter(|ms| *ms > 0)
            .map(Duration::from_millis);
        if let Err(error) = store.wait_ready(limit).await {
            error!(error = %format!("{error:#}"), "the database is not available, exiting");
            return Err(error);
        }
        Self::with_store(config, clock, store).await
    }

    pub async fn with_store(config: Config, clock: Clock, store: Store) -> Result<Self> {
        let http = http_client(config.acme_ca_bundle.as_deref())?;
        let analytics = match &config.analytics_url {
            Some(url) if !url.is_empty() => Analytics::http(
                clock.clone(),
                http.clone(),
                url.clone(),
                config.analytics_token.clone(),
            )
            .with_region(config.region.clone()),
            _ => Analytics::disabled(clock.clone()),
        };
        let service = Service::new(
            config.domain.clone(),
            store.clone(),
            clock.clone(),
            analytics,
        );
        service.set_timeouts(config.timeouts());
        service.set_limits(Arc::new(crate::limits::Limits::from_config(
            &config,
            store.clone(),
            clock.clone(),
        )?));
        service.set_bridge_limits(config.bridge_limits());

        let (issuer, local_ca) = match config.issuer {
            IssuerKind::Local => {
                warn!("using the INSECURE local test CA to sign certificates");
                let ca = LocalCa::load(&store, config.local_ca_validity_days).await?;
                let pem = ca.certificate_pem().to_owned();
                (Issuer::Local(ca), Some(pem))
            }
            IssuerKind::Acme => {
                let dns = match config.dns_provider {
                    DnsKind::Cloudflare => config
                        .cloudflare_api_token
                        .clone()
                        .filter(|token| !token.is_empty() && !config.cloudflare_zone_id.is_empty())
                        .map(|token| DnsProvider::Cloudflare {
                            http: http.clone(),
                            api: config.cloudflare_api_url.trim_end_matches('/').to_owned(),
                            zone_id: config.cloudflare_zone_id.clone(),
                            token,
                        }),
                    DnsKind::Exec => Some(DnsProvider::Exec {
                        hook: config
                            .dns_hook
                            .clone()
                            .filter(|hook| !hook.as_os_str().is_empty())
                            .context("DNS_HOOK is required with DNS_PROVIDER=exec")?,
                    }),
                    DnsKind::Challtestsrv => Some(DnsProvider::ChallTestSrv {
                        http: http.clone(),
                        url: config.challtestsrv_url.trim_end_matches('/').to_owned(),
                    }),
                };
                let poll = Duration::from_millis(config.acme_poll_interval_ms);
                let acme = Acme::new(
                    AcmeConfig {
                        directory: config.acme_url.clone(),
                        email: config.acme_email.clone(),
                        eab_kid: config
                            .acme_eab_kid
                            .clone()
                            .filter(|value| !value.is_empty()),
                        eab_hmac_key: config
                            .acme_eab_hmac_key
                            .clone()
                            .filter(|value| !value.is_empty()),
                        account_key_jwk: config.acme_account_key_jwk.clone(),
                        dns_propagation_timeout: Duration::from_millis(
                            config.acme_dns_propagation_timeout_ms,
                        ),
                        authorization_poll: poll,
                        order_poll: poll.mul_f32(0.6),
                    },
                    http.clone(),
                    dns,
                );
                (Issuer::Acme(acme), None)
            }
        };

        let resolver = Arc::new(tls::ServerCertificate::default());
        let certificates = Arc::new(ServerCertificates {
            service: service.clone(),
            name: config.domain.to_ascii_lowercase(),
            resolver: resolver.clone(),
        });
        let jobs = Jobs::new(
            service.clone(),
            Arc::new(issuer),
            config.issuance_concurrency,
            config.issuance_retry_delay_ms,
            Some(certificates.clone()),
        );

        let website = if config.website_dir.is_dir() {
            let website = Website::load(&config.website_dir)?;
            info!(files = website.len(), dir = %config.website_dir.display(), "loaded the website");
            website
        } else {
            warn!(dir = %config.website_dir.display(), "no website directory; only the API is served");
            Website::default()
        };

        let stats = Arc::new(Stats::default());
        let cluster = match config.internal_listen.as_str() {
            "" | "off" => None,
            _ => {
                let cluster = Arc::new(Cluster::new(
                    config
                        .machine_id
                        .clone()
                        .filter(|id| !id.is_empty())
                        .unwrap_or_else(|| jobs.owner.clone()),
                    config.region.clone(),
                    config.internal_token.clone().unwrap_or_default(),
                    clock.clone(),
                    stats.clone(),
                    config.mesh(),
                )?);
                service.set_cluster(cluster.clone());
                Some(cluster)
            }
        };
        let admin = config
            .admin_token
            .as_deref()
            .filter(|token| !token.is_empty())
            .map(|token| {
                Arc::new(TokenAdmin {
                    token_hash: crate::crypto::hash_token(token),
                }) as Arc<dyn http::Admin>
            });

        let app = Arc::new(App {
            service,
            website,
            admin,
            stats,
            shutdown: http::Shutdown::default(),
        });
        Ok(Self {
            app,
            jobs,
            certificates,
            resolver,
            cluster,
            config,
            local_ca,
            handshakes: Semaphore::new(MAX_HANDSHAKES),
        })
    }

    /// Loads or requests the domain's certificate and starts the background tasks.
    pub async fn start_background(&self) -> Result<Vec<tokio::task::JoinHandle<()>>> {
        let mut tasks = Vec::new();
        let service = self.app.service.clone();
        match (&self.config.tls_cert_file, &self.config.tls_key_file) {
            (Some(certificate), Some(key)) => {
                let chain = std::fs::read_to_string(certificate)
                    .with_context(|| format!("reading {}", certificate.display()))?;
                let key = std::fs::read_to_string(key)
                    .with_context(|| format!("reading {}", key.display()))?;
                self.resolver.install(&chain, &key)?;
                info!("serving the configured certificate for the API domain");
            }
            _ => {
                self.certificates.load().await?;
                tasks.push(tokio::spawn(self.certificates.clone().run()));
            }
        }
        match service
            .resume_orphaned_issuance(jobs::ORPHAN_GRACE_MS)
            .await
        {
            Ok(0) => {}
            Ok(resumed) => info!(resumed, "resumed certificate issuance without a job"),
            Err(error) => warn!(%error, "resuming certificate issuance failed"),
        }
        if let Some(cluster) = &self.cluster {
            tasks.extend(cluster.start(&service));
        }
        tasks.push(tokio::spawn(self.jobs.clone().run()));
        tasks.push(tokio::spawn(jobs::run_alarms(service.clone())));
        tasks.push(tokio::spawn(jobs::run_sweeper(service.clone())));
        tasks.push(tokio::spawn(crate::metrics::run_monitor(
            service.store.clone(),
            service.clock.clone(),
        )));
        tasks.push(tokio::spawn(jobs::run_reconcile(service)));
        tasks.push(tokio::spawn(jobs::run_dns_sweeper(self.jobs.clone())));
        Ok(tasks)
    }

    /// Accepts public TLS connections until the listener fails.
    pub async fn serve_tls(self: Arc<Self>, listener: TcpListener) -> Result<()> {
        let acceptor = tls::acceptor(self.resolver.clone());
        let limit = max_connections();
        info!(limit, "public connection limit");
        let slots = Arc::new(Semaphore::new(limit));
        let mut errors = AcceptErrors::new("accept failed");
        loop {
            let (stream, peer) = match listener.accept().await {
                Ok(accepted) => accepted,
                Err(error) => {
                    errors.failed(error).await;
                    continue;
                }
            };
            net::tune(&stream);
            // Closed rather than left waiting: a stalled accept loop would leave every new connection in the
            // kernel's queue, the healthy ones too.
            let Ok(slot) = slots.clone().try_acquire_owned() else {
                crate::metrics::connection_shed("connections");
                continue;
            };
            let server = self.clone();
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                let _slot = slot;
                server.connection(stream, peer, acceptor).await;
            });
        }
    }

    async fn connection(
        &self,
        stream: TcpStream,
        peer: SocketAddr,
        acceptor: tokio_rustls::TlsAcceptor,
    ) {
        let accepted = match relay::accept(stream, peer, self.config.proxy_protocol).await {
            Ok(accepted) => accepted,
            Err(error) => {
                crate::metrics::visitor(crate::metrics::hello_outcome(&error));
                debug!(%error, %peer, "TCP connection rejected");
                return;
            }
        };
        let domain = &self.app.service.domain;
        if accepted.sni == *domain {
            let Ok(Ok(slot)) =
                tokio::time::timeout(HANDSHAKE_QUEUE_TIMEOUT, self.handshakes.acquire()).await
            else {
                crate::metrics::connection_shed("handshakes");
                debug!(%peer, "API connection shed: too many TLS handshakes waiting");
                return;
            };
            let mut slot = Some(slot);
            let stream = tls::Replay::new(accepted.initial, accepted.stream);
            let accept = tokio::time::timeout(Duration::from_secs(10), acceptor.accept(stream));
            tokio::pin!(accept);
            // The work is done as soon as the ClientHello (already read) is processed; the rest is waiting for the
            // client, which must not hold a slot for long.
            let result = tokio::select! {
                result = &mut accept => result,
                () = tokio::time::sleep(HANDSHAKE_SLOT_HOLD) => {
                    slot = None;
                    accept.await
                }
            };
            drop(slot);
            let tls = match result {
                Ok(Ok(tls)) => tls,
                Ok(Err(error)) => {
                    crate::metrics::api_handshake("failed");
                    debug!(%error, "TLS handshake failed");
                    return;
                }
                Err(_) => {
                    crate::metrics::api_handshake("timeout");
                    debug!("TLS handshake timed out");
                    return;
                }
            };
            crate::metrics::api_handshake("ok");
            Box::pin(http::serve_connection(self.app.clone(), tls, accepted.peer)).await;
            return;
        }
        http::count(&self.app.stats.tunnel_connections);
        let _open = crate::metrics::visitor_open();
        let origin = relay::Origin::Public {
            cluster: self.cluster.as_ref(),
        };
        if let Err(error) = Box::pin(relay::route_tunnel(&self.app.service, accepted, origin)).await
        {
            debug!(%error, %peer, "TCP connection rejected");
        }
    }

    /// Binds the internal listener (with `INTERNAL_LISTEN`) and records the address other machines use.
    pub async fn bind_internal(&self) -> Result<Option<TcpListener>> {
        let Some(cluster) = &self.cluster else {
            return Ok(None);
        };
        let configured = self.config.internal_listen.as_str();
        let mut address = tokio::net::lookup_host(configured)
            .await
            .with_context(|| format!("INTERNAL_LISTEN {configured}"))?
            .next()
            .with_context(|| format!("INTERNAL_LISTEN {configured} has no address"))?;
        // On Fly, the private network only: never every interface.
        if address.ip().is_unspecified()
            && let Some(private) = self.config.private_ip
        {
            address.set_ip(private);
        }
        let listener = net::listen(address).with_context(|| format!("binding {address}"))?;
        let bound = listener.local_addr()?;
        let advertised = match &self.config.internal_address {
            Some(advertised) if !advertised.is_empty() => advertised.clone(),
            _ if bound.ip().is_unspecified() => {
                let loopback: std::net::IpAddr = if bound.is_ipv6() {
                    std::net::Ipv6Addr::LOCALHOST.into()
                } else {
                    std::net::Ipv4Addr::LOCALHOST.into()
                };
                SocketAddr::new(loopback, bound.port()).to_string()
            }
            _ => bound.to_string(),
        };
        cluster.set_address(advertised);
        info!(address = %bound, advertised = %cluster.address(), "listening for other machines");
        Ok(Some(listener))
    }

    pub async fn serve_internal(self: Arc<Self>, listener: TcpListener) {
        if let Some(cluster) = &self.cluster {
            cluster::serve_internal(listener, self.app.service.clone(), cluster.clone()).await;
        }
    }

    /// What the metrics endpoint samples from the service when scraped.
    pub fn metrics_sampler(&self) -> crate::metrics::Sampler {
        let service = self.app.service.clone();
        Arc::new(move || {
            let (pool_size, pool_idle) = service.store.pool_connections();
            crate::metrics::Sample {
                bridges: service.bridge_count(),
                pool_size,
                pool_idle,
                expiring_certificates: service
                    .expiring_certificates(service.now() + crate::metrics::EXPIRING_WITHIN_MS),
            }
        })
    }

    pub async fn serve_http(self: Arc<Self>, listener: TcpListener) -> Result<()> {
        let mut errors = AcceptErrors::new("HTTP accept failed");
        loop {
            let (stream, peer) = match listener.accept().await {
                Ok(accepted) => accepted,
                Err(error) => {
                    errors.failed(error).await;
                    continue;
                }
            };
            net::tune(&stream);
            let app = self.app.clone();
            let domain = self.config.domain.clone();
            let mode = self.config.http_mode;
            tokio::spawn(async move {
                match mode {
                    HttpMode::Serve => http::serve_connection(app, stream, peer).await,
                    HttpMode::Redirect => http::serve_redirect(domain, stream).await,
                }
            });
        }
    }

    /// Binds the listeners, runs until SIGTERM or Ctrl-C, then tells bridges to reconnect.
    pub async fn run(self) -> Result<()> {
        let tls_listener = net::listen(self.config.tls_listen)
            .with_context(|| format!("binding {}", self.config.tls_listen))?;
        info!(address = %self.config.tls_listen, domain = %self.config.domain, "listening for TLS");
        let http_listener = match self.config.http_listen.as_str() {
            "" | "off" => None,
            address => {
                let address: SocketAddr = address.parse().context("HTTP_LISTEN")?;
                let listener =
                    net::listen(address).with_context(|| format!("binding {address}"))?;
                info!(%address, mode = ?self.config.http_mode, "listening for HTTP");
                Some(listener)
            }
        };
        let internal_listener = self.bind_internal().await?;
        // Bound as configured (every interface on Fly): Fly's scraper does not reach the 6PN address. Nothing in
        // the metrics is secret or per tenant.
        let metrics_listener = crate::metrics::bind(&self.config.metrics_listen).await?;
        self.start_background().await?;
        if let Some(listener) = metrics_listener {
            tokio::spawn(crate::metrics::serve(listener, self.metrics_sampler()));
        }
        let server = Arc::new(self);
        let service = server.app.service.clone();
        let self_jobs = server.jobs.clone();
        let tls = tokio::spawn(server.clone().serve_tls(tls_listener));
        let http = http_listener.map(|listener| tokio::spawn(server.clone().serve_http(listener)));
        let internal =
            internal_listener.map(|listener| tokio::spawn(server.clone().serve_internal(listener)));
        shutdown_signal().await;
        // The proxy may keep sending new connections here for a few seconds (it does not know yet, or the machine
        // is being moved without being cordoned first), so the listeners stay open and the API keeps answering
        // while bridges move to other machines. Closing the listener at once fails those connections, which
        // Cloudflare reports as 525.
        let drain = Duration::from_millis(server.config.shutdown_drain_ms);
        info!(
            drain_ms = server.config.shutdown_drain_ms,
            "shutting down; asking bridges to reconnect"
        );
        // Issuance attempts end now, each deleting its challenge records, rather than be cut off at exit.
        self_jobs.stop();
        // Other machines stop forwarding here before the bridges move to them.
        if let Some(cluster) = &server.cluster {
            cluster.shutdown().await;
        }
        tokio::spawn({
            let service = service.clone();
            async move { service.drain().await }
        });
        server.app.shutdown.drain();
        tokio::select! {
            () = tokio::time::sleep(drain) => {}
            () = shutdown_signal() => info!("second shutdown signal; not waiting for the drain"),
        }
        tls.abort();
        if let Some(http) = http {
            http.abort();
        }
        let open = server.app.shutdown.open_connections();
        if !server.app.shutdown.close(CLOSE_TIMEOUT).await {
            warn!(open, "HTTP connections still open at shutdown");
        }
        self_jobs.release().await;
        if let Some(internal) = internal {
            internal.abort();
        }
        if let Some(cluster) = &server.cluster {
            cluster.mesh.halt(false);
        }
        info!("shut down");
        Ok(())
    }
}

/// Public connections handled at once: as many as three quarters of the memory hold, at most `MAX_CONNECTIONS`.
/// Beyond it new ones are closed at once, before memory runs out; Fly's `hard_limit` (fly.toml) stops sooner.
fn max_connections() -> usize {
    let memory = net::memory_limit().unwrap_or(2 << 30);
    usize::try_from(memory / 4 * 3 / CONNECTION_MEMORY)
        .unwrap_or(MAX_CONNECTIONS)
        .clamp(1_000, MAX_CONNECTIONS)
}

async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("SIGTERM handler installs");
        tokio::select! {
            _ = ctrl_c => {}
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = ctrl_c.await;
    }
}
