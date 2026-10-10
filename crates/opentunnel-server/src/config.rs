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

    #[arg(long, env = "DATABASE_PATH", default_value = "/data/opentunnel.db")]
    pub database: PathBuf,

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

    #[arg(long, env = "LOCAL_CA_VALIDITY_DAYS", default_value_t = 90)]
    pub local_ca_validity_days: u32,

    #[arg(long, env = "ACME_URL", default_value = "https://acme.zerossl.com/v2/DV90")]
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

    #[arg(long, env = "ACME_DNS_PROPAGATION_TIMEOUT_MS", default_value_t = 10_000)]
    pub acme_dns_propagation_timeout_ms: u64,

    #[arg(long, env = "ACME_POLL_INTERVAL_MS", default_value_t = 5_000)]
    pub acme_poll_interval_ms: u64,

    #[arg(long, env = "DNS_PROVIDER", value_enum, default_value = "cloudflare")]
    pub dns_provider: DnsKind,

    #[arg(long, env = "CLOUDFLARE_ZONE_ID", default_value = "43d8e5cf1c0ccc8c3868125be74a5e68")]
    pub cloudflare_zone_id: String,

    /// DNS edit on the zone, only for DNS-01 challenges.
    #[arg(long, env = "CLOUDFLARE_API_TOKEN", hide_env_values = true)]
    pub cloudflare_api_token: Option<String>,

    #[arg(long, env = "CLOUDFLARE_API_URL", default_value = "https://api.cloudflare.com/client/v4")]
    pub cloudflare_api_url: String,

    /// pebble-challtestsrv's management API, with `--dns-provider challtestsrv`.
    #[arg(long, env = "CHALLTESTSRV_URL", default_value = "http://127.0.0.1:8055")]
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

    /// TEMPORARY (migration): the old Worker, e.g. its workers.dev URL. Enables the legacy relay fallback and
    /// the pull-through import.
    #[arg(long, env = "LEGACY_WORKER_URL")]
    pub legacy_worker_url: Option<String>,

    /// TEMPORARY (migration): the Worker's RELAY_TOKEN, for its /api/relay.
    #[arg(long, env = "RELAY_TOKEN", hide_env_values = true)]
    pub relay_token: Option<String>,

    /// TEMPORARY (migration): the Worker's ADMIN_EXPORT_TOKEN, for its /api/admin/export.
    #[arg(long, env = "LEGACY_EXPORT_TOKEN", hide_env_values = true)]
    pub legacy_export_token: Option<String>,
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
    Challtestsrv,
}
