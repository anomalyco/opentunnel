#![allow(dead_code)]

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use clap::{CommandFactory, FromArgMatches, Parser};
use opentunnel_server::clock::Clock;
use opentunnel_server::config::Config;
use opentunnel_server::server::Server;
use opentunnel_server::store::Store;
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, ServerName};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpSocket, TcpStream};
use tokio::task::JoinHandle;

pub const DOMAIN: &str = "opentunnel.test";

#[derive(Parser)]
struct Args {
    #[command(flatten)]
    config: Config,
}

pub fn config(dir: &Path, extra: &[&str]) -> Config {
    let database = dir.join("db.sqlite");
    let website = dir.join("site");
    std::fs::create_dir_all(&website).unwrap();
    std::fs::write(website.join("index.html"), "<h1>opentunnel</h1>").unwrap();
    std::fs::write(website.join("install"), "#!/bin/sh\necho install\n").unwrap();
    let mut args = vec![
        "test".to_owned(),
        format!("--domain={DOMAIN}"),
        format!("--database={}", database.display()),
        format!("--website-dir={}", website.display()),
        "--issuer=local".into(),
        "--http-mode=serve".into(),
        "--admin-token=admin-secret".into(),
        "--issuance-retry-delay-ms=10".into(),
    ];
    args.extend(extra.iter().map(|arg| (*arg).to_owned()));
    // Later flags override the defaults above.
    let matches = Args::command()
        .args_override_self(true)
        .get_matches_from(args);
    Args::from_arg_matches(&matches).unwrap().config
}

fn reusable(address: SocketAddr) -> TcpListener {
    let socket = TcpSocket::new_v4().unwrap();
    socket.set_reuseaddr(true).unwrap();
    socket.bind(address).unwrap();
    socket.listen(1024).unwrap()
}

pub struct TestServer {
    pub dir: PathBuf,
    /// Plain HTTP serving the whole app, for the clients' `OPENTUNNEL_API`.
    pub api: String,
    pub http: SocketAddr,
    pub tls: SocketAddr,
    pub server: Arc<Server>,
    pub ca: String,
    tasks: Vec<JoinHandle<()>>,
}

impl TestServer {
    pub async fn start(dir: &Path, extra: &[&str]) -> Self {
        Self::start_at(
            dir,
            extra,
            "127.0.0.1:0".parse().unwrap(),
            "127.0.0.1:0".parse().unwrap(),
        )
        .await
    }

    pub async fn start_at(dir: &Path, extra: &[&str], http: SocketAddr, tls: SocketAddr) -> Self {
        opentunnel_server::install_crypto_provider();
        let config = config(dir, extra);
        let store = Store::open(&config.database).unwrap();
        let server = Server::with_store(config, Clock::system(), store)
            .await
            .unwrap();
        let ca = server.local_ca.clone().unwrap_or_default();
        let mut tasks = server.start_background().await.unwrap();
        let server = Arc::new(server);
        let http_listener = reusable(http);
        let tls_listener = reusable(tls);
        let http = http_listener.local_addr().unwrap();
        let tls = tls_listener.local_addr().unwrap();
        let serving = server.clone();
        tasks.push(tokio::spawn(async move {
            let _ = serving.serve_http(http_listener).await;
        }));
        let serving = server.clone();
        tasks.push(tokio::spawn(async move {
            let _ = serving.serve_tls(tls_listener).await;
        }));
        // The API domain's certificate is issued in the background.
        for _ in 0..100 {
            if server.resolver.is_installed() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        Self {
            dir: dir.to_owned(),
            api: format!("http://{http}"),
            http,
            tls,
            server,
            ca,
            tasks,
        }
    }

    /// Stops accepting, tells bridges to reconnect, and stops background work, like a deploy.
    pub async fn stop(self) {
        for task in &self.tasks {
            task.abort();
        }
        self.server.app.service.drain("server restarting").await;
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    pub fn service(&self) -> &opentunnel_server::service::Service {
        &self.server.app.service
    }

    /// One HTTPS request through the public TLS port with `sni`, trusting the local CA.
    pub async fn visit(&self, sni: &str, path: &str) -> std::io::Result<String> {
        visit(self.tls, &self.ca, sni, path).await
    }
}

pub fn connector(ca: &str) -> tokio_rustls::TlsConnector {
    let mut roots = rustls::RootCertStore::empty();
    for certificate in CertificateDer::pem_slice_iter(ca.as_bytes()) {
        roots.add(certificate.unwrap()).unwrap();
    }
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_root_certificates(roots)
    .with_no_client_auth();
    tokio_rustls::TlsConnector::from(Arc::new(config))
}

pub async fn visit(tls: SocketAddr, ca: &str, sni: &str, path: &str) -> std::io::Result<String> {
    let stream = TcpStream::connect(tls).await?;
    let name = ServerName::try_from(sni.to_owned()).unwrap();
    let mut stream =
        tokio::time::timeout(Duration::from_secs(10), connector(ca).connect(name, stream))
            .await
            .map_err(|_| std::io::Error::other("handshake timed out"))??;
    stream
        .write_all(
            format!("GET {path} HTTP/1.1\r\nHost: {sni}\r\nConnection: close\r\n\r\n").as_bytes(),
        )
        .await?;
    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(10), stream.read_to_end(&mut response))
        .await
        .map_err(|_| std::io::Error::other("response timed out"))??;
    Ok(String::from_utf8_lossy(&response).into_owned())
}

/// An HTTP server answering every request with `body`.
pub async fn app(body: &'static str) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap().to_string();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let mut buffer = vec![0u8; 8192];
                let mut request = Vec::new();
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let Ok(read) = socket.read(&mut buffer).await else {
                        return;
                    };
                    if read == 0 {
                        return;
                    }
                    request.extend_from_slice(&buffer[..read]);
                }
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    address
}

pub async fn eventually<F, Fut>(what: &str, mut check: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    for _ in 0..200 {
        if check().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {what}");
}
