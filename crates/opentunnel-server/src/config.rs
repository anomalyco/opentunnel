//! Configuration, from flags or the environment (Fly secrets and `[env]`).

use std::net::SocketAddr;
use std::path::PathBuf;

use clap::{Args, ValueEnum};

#[derive(Debug, Clone, Args)]
pub struct Config {
    /// The API domain; tunnels are `<id>.<domain>`.
    #[arg(long, env = "OPENTUNNEL_DOMAIN", default_value = "opentunnel.xyz")]
    pub domain: String,

    /// Public TLS: SNI routing for tunnels, and the API and website for the domain.
    #[arg(long, env = "TLS_LISTEN", default_value = "0.0.0.0:8443")]
    pub tls_listen: SocketAddr,

    /// Plain HTTP: health checks and redirects to HTTPS (or the whole app with `--http-mode serve`). `off`
    /// disables it.
    #[arg(long, env = "HTTP_LISTEN", default_value = "0.0.0.0:8080")]
    pub http_listen: String,

    #[arg(long, env = "HTTP_MODE", value_enum, default_value = "redirect")]
    pub http_mode: HttpMode,

    /// Expect a PROXY protocol (v1 or v2) header on every TLS connection, as Fly's `proxy_proto` handler sends.
    #[arg(long, env = "PROXY_PROTOCOL", default_value_t = false)]
    pub proxy_protocol: bool,

    /// MySQL (PlanetScale), e.g. `mysql://user:password@host/opentunnel?ssl-mode=VERIFY_IDENTITY`. TLS is
    /// required except for a database on loopback.
    #[arg(long, env = "DATABASE_URL", hide_env_values = true)]
    pub database_url: Option<String>,

    /// Connections per machine. Every attach and API call holds one for a round trip to the database, which is
    /// slow from regions far from it, so reconnect bursts need room.
    #[arg(long, env = "DATABASE_POOL_SIZE", default_value_t = 50)]
    pub database_pool_size: u32,

    /// At startup, how long to keep retrying an unreachable database before exiting with an error, so the
    /// platform restarts the machine. 0 waits forever. Only startup: a running server rides out outages.
    #[arg(long, env = "STARTUP_DB_TIMEOUT_MS", default_value_t = 120_000)]
    pub startup_db_timeout_ms: u64,

    /// The built website (`vite build` output).
    #[arg(long, env = "WEBSITE_DIR", default_value = "/app/website")]
    pub website_dir: PathBuf,

    /// Serve this certificate chain for the domain instead of issuing one.
    #[arg(long, env = "TLS_CERT_FILE", requires = "tls_key_file")]
    pub tls_cert_file: Option<PathBuf>,

    #[arg(long, env = "TLS_KEY_FILE", requires = "tls_cert_file")]
    pub tls_key_file: Option<PathBuf>,

    /// Who signs certificates. `local` is an INSECURE built-in CA for development and tests.
    #[arg(long, env = "ISSUER", value_enum, default_value = "acme")]
    pub issuer: IssuerKind,

    /// Where to write the local test CA's certificate, for clients to trust.
    #[arg(long, env = "LOCAL_CA_FILE")]
    pub local_ca_file: Option<PathBuf>,

    #[arg(long, env = "LOCAL_CA_VALIDITY_DAYS", default_value_t = 90)]
    pub local_ca_validity_days: u32,

    #[arg(
        long,
        env = "ACME_URL",
        default_value = "https://acme.zerossl.com/v2/DV90"
    )]
    pub acme_url: String,

    #[arg(long, env = "ACME_EMAIL", default_value = "acme@opentunnel.xyz")]
    pub acme_email: String,

    #[arg(long, env = "ACME_EAB_KID", hide_env_values = true)]
    pub acme_eab_kid: Option<String>,

    #[arg(long, env = "ACME_EAB_HMAC_KEY", hide_env_values = true)]
    pub acme_eab_hmac_key: Option<String>,

    /// The ACME account key, a P-256 private JWK (the Worker's secret, so the ZeroSSL account stays the same).
    #[arg(long, env = "ACME_ACCOUNT_KEY_JWK", hide_env_values = true)]
    pub acme_account_key_jwk: Option<String>,

    /// Extra PEM roots to trust for the ACME server (Pebble's).
    #[arg(long, env = "ACME_CA_BUNDLE")]
    pub acme_ca_bundle: Option<PathBuf>,

    #[arg(
        long,
        env = "ACME_DNS_PROPAGATION_TIMEOUT_MS",
        default_value_t = 10_000
    )]
    pub acme_dns_propagation_timeout_ms: u64,

    #[arg(long, env = "ACME_POLL_INTERVAL_MS", default_value_t = 5_000)]
    pub acme_poll_interval_ms: u64,

    #[arg(long, env = "DNS_PROVIDER", value_enum, default_value = "cloudflare")]
    pub dns_provider: DnsKind,

    /// The executable run with `--dns-provider exec`: `<hook> create|delete <name> <value>`.
    #[arg(long, env = "DNS_HOOK")]
    pub dns_hook: Option<PathBuf>,

    #[arg(
        long,
        env = "CLOUDFLARE_ZONE_ID",
        default_value = "43d8e5cf1c0ccc8c3868125be74a5e68"
    )]
    pub cloudflare_zone_id: String,

    /// DNS edit on the zone, only for DNS-01 challenges.
    #[arg(long, env = "CLOUDFLARE_API_TOKEN", hide_env_values = true)]
    pub cloudflare_api_token: Option<String>,

    #[arg(
        long,
        env = "CLOUDFLARE_API_URL",
        default_value = "https://api.cloudflare.com/client/v4"
    )]
    pub cloudflare_api_url: String,

    /// pebble-challtestsrv's management API, with `--dns-provider challtestsrv`.
    #[arg(
        long,
        env = "CHALLTESTSRV_URL",
        default_value = "http://127.0.0.1:8055"
    )]
    pub challtestsrv_url: String,

    #[arg(long, env = "ISSUANCE_CONCURRENCY", default_value_t = 4)]
    pub issuance_concurrency: usize,

    #[arg(long, env = "ISSUANCE_RETRY_DELAY_MS", default_value_t = 15_000)]
    pub issuance_retry_delay_ms: u64,

    /// The platform event stream's HTTP endpoint; analytics are off without it.
    #[arg(long, env = "ANALYTICS_URL")]
    pub analytics_url: Option<String>,

    #[arg(long, env = "ANALYTICS_TOKEN", hide_env_values = true)]
    pub analytics_token: Option<String>,

    /// Bearer secret for this server's /api/admin/*; the endpoints are off without it.
    #[arg(long, env = "ADMIN_TOKEN", hide_env_values = true)]
    pub admin_token: Option<String>,

    /// Running as one of many machines: the internal listener for forwarded visitors and control between
    /// machines, e.g. `[::]:9000` (bound to `FLY_PRIVATE_IP` on Fly, so only the private network reaches it).
    /// `off` (the default) runs a single machine without the mesh.
    #[arg(long, env = "INTERNAL_LISTEN", default_value = "off")]
    pub internal_listen: String,

    /// Where other machines reach this one's internal listener; defaults to `[FLY_PRIVATE_IP]:<port>`, else the
    /// bound address.
    #[arg(long, env = "INTERNAL_ADDRESS")]
    pub internal_address: Option<String>,

    /// The secret shared by all machines, required with `INTERNAL_LISTEN`.
    #[arg(long, env = "INTERNAL_TOKEN", hide_env_values = true)]
    pub internal_token: Option<String>,

    /// This machine's name in the mesh and on job leases (random when unset).
    #[arg(long, env = "FLY_MACHINE_ID")]
    pub machine_id: Option<String>,

    #[arg(long, env = "FLY_REGION", default_value = "local")]
    pub region: String,

    /// The machine's private network (6PN) address, set by Fly.
    #[arg(long, env = "FLY_PRIVATE_IP")]
    pub private_ip: Option<std::net::IpAddr>,

    /// The Fly app, set by Fly: peers are found as `<FLY_APP_NAME>.internal` unless `MESH_DNS` says otherwise.
    #[arg(long, env = "FLY_APP_NAME")]
    pub fly_app_name: Option<String>,

    /// A DNS name whose addresses are the other machines (at this machine's internal port); `off` disables it.
    /// Defaults to `<FLY_APP_NAME>.internal`.
    #[arg(long, env = "MESH_DNS")]
    pub mesh_dns: Option<String>,

    /// Other machines' internal addresses (`host:port`, comma-separated), in addition to `MESH_DNS`.
    #[arg(long, env = "MESH_PEERS", value_delimiter = ',')]
    pub mesh_peers: Vec<String>,

    /// How often the peers' DNS name is resolved again.
    #[arg(long, env = "MESH_DISCOVERY_MS", default_value_t = 5_000)]
    pub mesh_discovery_ms: u64,

    /// How often a mesh link sends a ping when it has nothing else to send.
    #[arg(long, env = "MESH_PING_MS", default_value_t = 1_000)]
    pub mesh_ping_ms: u64,

    /// A peer that sent nothing for this long is down: its link is closed and its bridges dropped.
    #[arg(long, env = "MESH_DEAD_MS", default_value_t = 5_000)]
    pub mesh_dead_ms: u64,

    /// A peer's mesh address must be the one its connection comes from (and, on Fly, what
    /// `<machine>.vm.<app>.internal` resolves to). Only for unusual networks; forwards go to that address.
    #[arg(long, env = "MESH_VERIFY_ADDRESS", default_value_t = true, action = clap::ArgAction::Set)]
    pub mesh_verify_address: bool,

    /// A tunnel connection with no traffic in either direction for this long is closed.
    #[arg(long, env = "CONNECTION_IDLE_TIMEOUT_MS", default_value_t = 900_000)]
    pub connection_idle_timeout_ms: u64,

    /// Once either direction of a tunnel connection has ended, the other is closed after this long without
    /// traffic.
    #[arg(long, env = "HALF_CLOSE_TIMEOUT_MS", default_value_t = 60_000)]
    pub half_close_timeout_ms: u64,

    /// Tunnels one client address may create: this many an hour on average (cluster-wide, counted in the
    /// database; IPv6 addresses by /64). 0 disables the limit.
    #[arg(long, env = "CREATE_RATE_PER_HOUR", default_value_t = 30)]
    pub create_rate_per_hour: u32,

    /// ... and this many at once.
    #[arg(long, env = "CREATE_RATE_BURST", default_value_t = 10)]
    pub create_rate_burst: u32,

    /// New certificates (a bind with a new CSR) one tunnel may request: this many a day on average. Binding the
    /// CSR it already has, and renewals, do not count. 0 disables the limit.
    #[arg(long, env = "ISSUANCE_RATE_PER_DAY", default_value_t = 5)]
    pub issuance_rate_per_day: u32,

    /// ... and this many at once.
    #[arg(long, env = "ISSUANCE_RATE_BURST", default_value_t = 5)]
    pub issuance_rate_burst: u32,

    /// While more certificate jobs than this are pending (cluster-wide), creating tunnels and requesting new
    /// certificates answer 503 instead of queueing more. 0 disables it.
    #[arg(long, env = "ISSUANCE_BACKLOG_LIMIT", default_value_t = 200)]
    pub issuance_backlog_limit: u64,

    /// Proxies whose `CF-Connecting-IP` header names the client (CIDRs, comma-separated). Defaults to
    /// Cloudflare's published ranges; `off` trusts no header. Requests from anywhere else are counted by their own
    /// address, whatever headers they send.
    #[arg(long, env = "TRUSTED_PROXY_RANGES", value_delimiter = ',')]
    pub trusted_proxy_ranges: Vec<String>,

    /// Public connections one bridge carries at once; a client advertising a lower `max_conns` gets that.
    #[arg(long, env = "MAX_CONNS_PER_BRIDGE", default_value_t = 256)]
    pub max_conns_per_bridge: usize,

    /// Public connections one tunnel carries at once on this machine, over all its bridges.
    #[arg(long, env = "MAX_CONNS_PER_TUNNEL", default_value_t = 1024)]
    pub max_conns_per_tunnel: usize,

    /// Bytes of connection data this machine holds in memory at once, both directions and all bridges
    /// together, on top of each bridge's and connection's own budget.
    #[arg(long, env = "BUFFERED_BYTES_LIMIT", default_value_t = 256 * 1024 * 1024)]
    pub buffered_bytes_limit: usize,

    /// Serves Prometheus metrics at `/metrics`, e.g. `[::]:9091` (Fly's scraper; no `[[services]]` entry exposes
    /// it). `off` (the default) disables it.
    #[arg(long, env = "METRICS_LISTEN", default_value = "off")]
    pub metrics_listen: String,

    /// After SIGTERM, how long the server keeps accepting connections (and serving the API) while bridges move
    /// to other machines; the proxy may still send new connections here for a few seconds.
    #[arg(long, env = "SHUTDOWN_DRAIN_MS", default_value_t = 10_000)]
    pub shutdown_drain_ms: u64,

    /// `json` lines (on Fly) or human-readable `text`.
    #[arg(long, env = "LOG_FORMAT", value_enum, default_value = "text")]
    pub log_format: crate::logging::LogFormat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum HttpMode {
    Redirect,
    Serve,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum IssuerKind {
    Acme,
    Local,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum DnsKind {
    Cloudflare,
    /// An executable (`DNS_HOOK`) that creates and deletes the records, for self-hosted servers.
    Exec,
    Challtestsrv,
}

impl Config {
    pub fn mesh(&self) -> crate::mesh::MeshConfig {
        let ms = |value: u64| std::time::Duration::from_millis(value.max(1));
        let dns = match self.mesh_dns.as_deref() {
            Some("" | "off") => None,
            Some(name) => Some(name.to_owned()),
            None => self
                .fly_app_name
                .as_deref()
                .filter(|app| !app.is_empty())
                .map(|app| format!("{app}.internal")),
        };
        // Fly names every machine `<id>.vm.<app>.internal`; only with the default peer name.
        let machine_dns = match (self.mesh_dns.as_deref(), self.fly_app_name.as_deref()) {
            (None, Some(app)) if !app.is_empty() => Some(format!("{{}}.vm.{app}.internal")),
            _ => None,
        };
        crate::mesh::MeshConfig {
            dns,
            peers: self
                .mesh_peers
                .iter()
                .filter(|peer| !peer.is_empty())
                .cloned()
                .collect(),
            discovery: ms(self.mesh_discovery_ms),
            ping: ms(self.mesh_ping_ms),
            dead: ms(self.mesh_dead_ms),
            machine_dns,
            verify_address: self.mesh_verify_address,
            ..crate::mesh::MeshConfig::default()
        }
    }

    pub fn bridge_limits(&self) -> crate::service::BridgeLimits {
        crate::service::BridgeLimits {
            conns_per_bridge: self.max_conns_per_bridge.max(1),
            conns_per_tunnel: self.max_conns_per_tunnel.max(1),
            buffered_bytes: self.buffered_bytes_limit.max(1024 * 1024),
        }
    }

    pub fn timeouts(&self) -> crate::net::Timeouts {
        crate::net::Timeouts {
            idle: std::time::Duration::from_millis(self.connection_idle_timeout_ms.max(1)),
            half_close: std::time::Duration::from_millis(self.half_close_timeout_ms.max(1)),
        }
    }
}
