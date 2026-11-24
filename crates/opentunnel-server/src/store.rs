//! MySQL storage (PlanetScale in production). Records keep the Durable Object's JSON shape byte for byte.
//!
//! The schema follows Vitess' rules: every table has a primary key, there are no foreign keys, triggers or
//! stored procedures, and migrations are idempotent `CREATE TABLE IF NOT EXISTS` statements run at startup.
//! Nothing relies on a single writer: tunnel records carry a revision that every write checks, alarms and
//! job leases are taken with conditional updates, and imports lock the row they replace.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use sqlx::mysql::{
    MySqlConnectOptions, MySqlConnection, MySqlDatabaseError, MySqlPool, MySqlPoolOptions,
    MySqlSslMode,
};
use sqlx::{ConnectOptions, Connection, Executor, Row};
use tracing::{info, warn};

use crate::record::StoredTunnel;

/// The schema version this server writes. A database at a newer version is refused, so tables are added and
/// dropped without a new version where servers of the previous version do not depend on them (a rollback, or one
/// of them restarting during a deploy, still starts).
const SCHEMA_VERSION: i64 = 2;

const SCHEMA: &[&str] = &[
    r#"CREATE TABLE IF NOT EXISTS schema_migrations (
  version BIGINT NOT NULL PRIMARY KEY,
  applied_at BIGINT NOT NULL
) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin"#,
    r#"CREATE TABLE IF NOT EXISTS tunnels (
  id VARCHAR(191) NOT NULL PRIMARY KEY,
  -- The record, exactly as serialized in the Durable Object's StoredTunnel JSON shape. Text rather than JSON,
  -- which would reorder keys.
  record LONGTEXT NOT NULL,
  -- Bumped by every write; writers update only the revision they read.
  revision BIGINT NOT NULL,
  -- Derived from the record on every write, for queries.
  deleted TINYINT NOT NULL DEFAULT 0,
  issuing TINYINT NOT NULL DEFAULT 0,
  -- The renewal alarm (the Durable Object's storage alarm), Unix milliseconds.
  alarm_at BIGINT NULL,
  updated_at BIGINT NOT NULL,
  imported_at BIGINT NULL,
  -- 0 while the row is exactly as last imported, so a later import may refresh it; 1 once this server wrote it.
  local_update TINYINT NOT NULL DEFAULT 1,
  KEY tunnels_alarm (alarm_at),
  KEY tunnels_issuing (issuing, deleted)
) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin"#,
    r#"CREATE TABLE IF NOT EXISTS jobs (
  certificate_id VARCHAR(191) NOT NULL PRIMARY KEY,
  -- NULL for the server's own certificates.
  tunnel_id VARCHAR(191) NULL,
  kind VARCHAR(16) NOT NULL,
  identifiers TEXT NOT NULL,
  csr TEXT NOT NULL,
  -- pending, done, failed or abandoned (no longer wanted).
  status VARCHAR(16) NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  run_at BIGINT NOT NULL,
  -- The process running the job and until when; another may take it over once the lease expires.
  lease_owner VARCHAR(191) NULL,
  lease_until BIGINT NULL,
  last_error TEXT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  KEY jobs_due (status, run_at)
) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin"#,
    r#"CREATE TABLE IF NOT EXISTS server_certificates (
  name VARCHAR(191) NOT NULL PRIMARY KEY,
  private_key TEXT NOT NULL,
  csr TEXT NOT NULL,
  certificate MEDIUMTEXT NULL,
  chain MEDIUMTEXT NULL,
  expiry VARCHAR(64) NULL,
  updated_at BIGINT NOT NULL
) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin"#,
    r#"CREATE TABLE IF NOT EXISTS meta (
  name VARCHAR(191) NOT NULL PRIMARY KEY,
  value MEDIUMTEXT NOT NULL
) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin"#,
    RATE_LIMITS,
];

/// Rate limits (`limits.rs`). Added without a schema version, so servers of the previous version still start
/// against a database that has it: [`migrate`] creates it when it is missing.
const RATE_LIMITS: &str = r#"CREATE TABLE IF NOT EXISTS rate_limits (
  -- `create:<client address>` or `issue:<tunnel>`.
  name VARCHAR(191) NOT NULL PRIMARY KEY,
  -- When the key's budget is full again (GCRA's theoretical arrival time), Unix ms; a row in the past is the same
  -- as none, and is pruned.
  tat BIGINT NOT NULL,
  KEY rate_limits_tat (tat)
) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin"#;

/// Every statement gives up after this long, so a stalled database cannot hang a request.
const QUERY_TIMEOUT: Duration = Duration::from_secs(10);
/// The admin stats' counts, one of which scans the whole `tunnels` table; well inside Cloudflare's 100 s wait for a
/// response.
const COUNTS_TIMEOUT: Duration = Duration::from_secs(60);
/// How long opening a connection may take: TCP, TLS to PlanetScale's nearest edge and the MySQL handshake, which
/// the edge relays to the database (us-east-1), several round trips from far regions. sqlx bounds a new
/// connection by the pool's acquire timeout, so this is also that timeout; a statement on the request path is
/// still bounded by its own limit (`timed`, and 4 s for an attach), which fails an attach while the client can
/// back off. A 3 s acquire timeout aborted every connection that took longer, at startup forever (gru).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// Each address's TCP connect in the diagnostics after a failed startup connection.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// How often the pool is topped up to `MIN_CONNECTIONS` in the background.
const WARM_INTERVAL: Duration = Duration::from_secs(10);
/// Connections kept open while idle, so a burst after a quiet spell does not wait for TLS handshakes (several
/// round trips each from regions far from the database).
const MIN_CONNECTIONS: u32 = 8;
/// How long a job lease lasts; the runner extends it while the job runs.
pub const LEASE_MS: u64 = 2 * 60 * 1000;

const ER_DUP_ENTRY: u16 = 1062;
const ER_LOCK_WAIT_TIMEOUT: u16 = 1205;
const ER_LOCK_DEADLOCK: u16 = 1213;

/// Tunnels read in one statement at most. Each is a few KB of JSON.
const READ_BATCH: usize = 200;
/// Batched tunnel reads in flight at once, leaving the rest of the pool to writes, jobs and the API.
const READ_BATCHES: usize = 8;

#[derive(Clone)]
pub struct Store {
    pool: MySqlPool,
    options: MySqlConnectOptions,
    reads: Arc<Mutex<Reads>>,
}

type ReadResult = Result<Option<AttachSnapshot>>;

/// Single-tunnel reads waiting for a batch. A reconnect storm on a machine far from the database (150 ms from
/// `nrt` and `syd`) made every attach take a pooled connection for a round trip of its own, so the pool capped
/// attaches at ~100 a second there; batched, one round trip serves up to `READ_BATCH` of them.
#[derive(Default)]
struct Reads {
    waiting: Vec<(String, tokio::sync::oneshot::Sender<ReadResult>)>,
    running: usize,
}

/// A tunnel record changed since it was read, by an import or another server.
#[derive(Debug, thiserror::Error)]
#[error("the tunnel changed concurrently; try again")]
pub struct Conflict;

/// A record and the revision it was read at.
#[derive(Debug, Clone)]
pub struct Loaded {
    pub record: StoredTunnel,
    pub revision: u64,
}

/// What an attach needs from the database, read in one round trip: the tunnel and its renewal alarm.
#[derive(Debug, Clone)]
pub struct AttachSnapshot {
    pub loaded: Loaded,
    pub alarm: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobKind {
    /// The first certificate for a CSR.
    Issue,
    /// A renewal alongside the current certificate.
    Renew,
    /// The server's own certificate for the API domain.
    Server,
}

impl JobKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Issue => "issue",
            Self::Renew => "renew",
            Self::Server => "server",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "renew" => Self::Renew,
            "server" => Self::Server,
            _ => Self::Issue,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Job {
    pub certificate_id: String,
    pub tunnel_id: Option<String>,
    pub kind: JobKind,
    pub identifiers: Vec<String>,
    pub csr: String,
    pub attempts: u32,
    pub created_at: u64,
}

/// A failed (or still retrying) job, for queueing those that failed transiently again.
#[derive(Debug, Clone)]
pub struct FailedJob {
    pub certificate_id: String,
    pub tunnel_id: Option<String>,
    /// `failed` or `pending`.
    pub status: String,
    pub last_error: String,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone)]
pub struct ServerCertificate {
    pub private_key: String,
    pub csr: String,
    pub certificate: Option<String>,
    pub chain: Option<String>,
    pub expiry: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportOutcome {
    Inserted,
    Updated,
    Unchanged,
    /// The row changed on this server since it was imported, so it is the newer copy.
    KeptLocal,
}

/// Parses `DATABASE_URL` and enforces TLS: a remote database must use `ssl-mode` `REQUIRED`, `VERIFY_CA` or
/// `VERIFY_IDENTITY` (the default when unset); only a loopback host or a socket may go without.
pub fn connect_options(url: &str) -> Result<MySqlConnectOptions> {
    let parsed = url::Url::parse(url).context("DATABASE_URL is not a URL")?;
    anyhow::ensure!(
        parsed.scheme() == "mysql",
        "DATABASE_URL must be a mysql:// URL"
    );
    let explicit_mode = parsed
        .query_pairs()
        .any(|(key, _)| key == "ssl-mode" || key == "sslmode");
    let mut options: MySqlConnectOptions = url.parse().context("reading DATABASE_URL")?;
    let host = options.get_host().trim_matches(['[', ']']).to_owned();
    let local = options.get_socket().is_some()
        || host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback());
    if !local {
        if !explicit_mode {
            options = options.ssl_mode(MySqlSslMode::VerifyIdentity);
        }
        if matches!(
            options.get_ssl_mode(),
            MySqlSslMode::Disabled | MySqlSslMode::Preferred
        ) {
            bail!(
                "DATABASE_URL must use TLS for a remote database: set ssl-mode=VERIFY_IDENTITY (or leave it unset)"
            );
        }
    }
    Ok(options
        // Vitess rejects or pins connections for these session settings, and nothing here needs them.
        .pipes_as_concat(false)
        .no_engine_substitution(false)
        .timezone(None)
        .charset("utf8mb4"))
}

fn mysql_code(error: &sqlx::Error) -> Option<u16> {
    error
        .as_database_error()?
        .try_downcast_ref::<MySqlDatabaseError>()
        .map(MySqlDatabaseError::number)
}

fn retryable(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<sqlx::Error>()
        .and_then(mysql_code)
        .is_some_and(|code| matches!(code, ER_DUP_ENTRY | ER_LOCK_WAIT_TIMEOUT | ER_LOCK_DEADLOCK))
}

fn db(error: sqlx::Error) -> anyhow::Error {
    anyhow::Error::new(error).context("storage unavailable")
}

/// `value` as a SQL string literal, when it consists only of characters that need no escaping (the IDs and names
/// this server generates and validates). Statements built with literals go out as plain text queries, which take
/// one round trip on any connection, where a prepared statement takes two on a connection that has not prepared
/// it yet (and a pool spreads statements over many connections). Anything else is bound as a parameter.
fn literal(value: &str) -> Option<String> {
    let plain = !value.is_empty()
        && value.len() <= 191
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'@'));
    plain.then(|| format!("'{value}'"))
}

/// Runs one storage operation with the statement timeout, recording its duration and failure as `operation`.
/// Creates the tables unless the database is already at this version.
async fn migrate(connection: &mut MySqlConnection) -> Result<()> {
    let version: Option<i64> =
        match sqlx::query_scalar("SELECT MAX(version) FROM schema_migrations")
            .fetch_one(&mut *connection)
            .await
        {
            Ok(version) => version,
            // 1146: the table does not exist yet.
            Err(error) if mysql_code(&error) == Some(1146) => None,
            Err(error) => return Err(db(error)),
        };
    if let Some(version) = version {
        if version > SCHEMA_VERSION {
            return Err(NewerSchema(version).into());
        }
        if version == SCHEMA_VERSION {
            // Tables added without a version: created only while missing, so no DDL runs once they exist.
            match connection
                .execute("SELECT 1 FROM rate_limits LIMIT 0")
                .await
            {
                Ok(_) => {}
                Err(error) if mysql_code(&error) == Some(1146) => {
                    connection.execute(RATE_LIMITS).await.map_err(db)?;
                    info!("created the rate_limits table");
                }
                Err(error) => return Err(db(error)),
            }
            drop_bridges(connection).await;
            return Ok(());
        }
    }
    for statement in SCHEMA {
        connection.execute(*statement).await.map_err(db)?;
    }
    sqlx::query(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE version = version",
    )
    .bind(SCHEMA_VERSION)
    .bind(crate::clock::Clock::system().now_ms() as i64)
    .execute(&mut *connection)
    .await
    .map_err(db)?;
    Ok(())
}

/// Drops `bridges`, the bridge registry of servers before the mesh (schema 2), which nothing reads any more: only
/// while it exists, so no DDL runs once it is gone. Servers of the previous version never touch it either. A
/// failure (PlanetScale's safe migrations refuse direct DDL) is logged and leaves it for a deploy request.
async fn drop_bridges(connection: &mut MySqlConnection) {
    match connection.execute("SELECT 1 FROM bridges LIMIT 0").await {
        Ok(_) => match connection.execute("DROP TABLE IF EXISTS bridges").await {
            Ok(_) => info!("dropped the unused bridges table"),
            Err(error) => warn!(%error, "could not drop the unused bridges table"),
        },
        Err(error) if mysql_code(&error) == Some(1146) => {}
        Err(error) => warn!(%error, "could not check for the unused bridges table"),
    }
}

async fn timed<T>(operation: &'static str, future: impl Future<Output = Result<T>>) -> Result<T> {
    timed_within(operation, QUERY_TIMEOUT, future).await
}

/// [`timed`] with a shorter limit, for operations a client waits on.
async fn timed_within<T>(
    operation: &'static str,
    limit: Duration,
    future: impl Future<Output = Result<T>>,
) -> Result<T> {
    let started = std::time::Instant::now();
    // Boxed, so the futures of callers that make many storage calls stay shallow enough for the compiler's
    // layout computation in release builds.
    let result = match tokio::time::timeout(limit, Box::pin(future)).await {
        Ok(result) => result,
        Err(_) => Err(anyhow!("storage timed out").context("storage unavailable")),
    };
    crate::metrics::db_operation(operation, started.elapsed(), result.is_ok());
    result
}

fn record_flags(record: &StoredTunnel) -> (bool, bool) {
    use opentunnel::protocol::api::CertificateState;
    let issuing = record.renewal.is_some()
        || record.certificate.as_ref().is_some_and(|certificate| {
            matches!(
                certificate.state,
                CertificateState::Issuing | CertificateState::Challenge { .. }
            )
        });
    (record.is_deleted(), issuing)
}

type ServerCertificateRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
);
type FailedJobRow = (String, Option<String>, String, Option<String>, i64, i64);

fn failed_job_from_row(
    (certificate_id, tunnel_id, status, last_error, created_at, updated_at): FailedJobRow,
) -> FailedJob {
    FailedJob {
        certificate_id,
        tunnel_id,
        status,
        last_error: last_error.unwrap_or_default(),
        created_at: created_at as u64,
        updated_at: updated_at as u64,
    }
}
type JobRow = (String, Option<String>, String, String, String, i32, i64);

fn job_from_row(row: JobRow) -> Result<Job> {
    let (certificate_id, tunnel_id, kind, identifiers, csr, attempts, created_at) = row;
    Ok(Job {
        certificate_id,
        tunnel_id,
        kind: JobKind::parse(&kind),
        identifiers: serde_json::from_str(&identifiers).context("decoding job identifiers")?,
        csr,
        attempts: attempts.max(0) as u32,
        created_at: created_at as u64,
    })
}

impl Store {
    /// A pool that connects on demand, so a database that is down at startup only delays it.
    pub fn connect(url: &str, max_connections: u32) -> Result<Self> {
        Self::connect_with(url, max_connections)
    }

    fn connect_with(url: &str, max_connections: u32) -> Result<Self> {
        let options = connect_options(url)?;
        let pool = MySqlPoolOptions::new()
            .max_connections(max_connections)
            .min_connections(MIN_CONNECTIONS.min(max_connections))
            .acquire_timeout(CONNECT_TIMEOUT)
            // Shorter than PlanetScale's idle cutoff, so pooled connections are rarely dead. Pinging before every
            // acquire would double each query's round trip from regions far from the database.
            .idle_timeout(Duration::from_secs(60))
            .max_lifetime(Duration::from_secs(30 * 60))
            .test_before_acquire(false)
            .connect_lazy_with(options.clone());
        Ok(Self {
            pool,
            options,
            reads: Arc::default(),
        })
    }

    /// Connects and migrates, failing if the database is unavailable (the CLI's import and export).
    pub async fn open(url: &str) -> Result<Self> {
        let store = Self::connect_with(url, 2)?;
        store.migrate().await?;
        Ok(store)
    }

    /// Connects (outside the pool, with the full `CONNECT_TIMEOUT`) and migrates, retrying with backoff until the
    /// database answers, then opens the pool's idle connections in the background. An incompatible schema is an
    /// error, and so is a database still unreachable after `limit` (`None` waits forever), with the last error.
    pub async fn wait_ready(&self, limit: Option<Duration>) -> Result<()> {
        let started = tokio::time::Instant::now();
        let mut delay = Duration::from_millis(500);
        loop {
            match self.ready().await {
                Ok(()) => {
                    self.keep_warm();
                    return Ok(());
                }
                Err(error) if error.downcast_ref::<NewerSchema>().is_some() => return Err(error),
                Err(error) => {
                    let waited = started.elapsed();
                    let sleep = match limit {
                        Some(limit) if waited >= limit => {
                            return Err(error.context(format!(
                                "the database was unreachable for {}s at startup",
                                waited.as_secs()
                            )));
                        }
                        Some(limit) => delay.min(limit - waited),
                        None => delay,
                    };
                    warn!(error = %format!("{error:#}"), retry_in = ?sleep, "the database is not ready");
                    tokio::time::sleep(sleep).await;
                    delay = (delay * 2).min(Duration::from_secs(15));
                }
            }
        }
    }

    async fn ready(&self) -> Result<()> {
        let started = std::time::Instant::now();
        let connected = match tokio::time::timeout(CONNECT_TIMEOUT, self.options.connect()).await {
            Ok(result) => result.map_err(db),
            Err(_) => Err(anyhow!("connecting timed out after {CONNECT_TIMEOUT:?}")
                .context("storage unavailable")),
        };
        let connect_ms = started.elapsed().as_millis() as u64;
        let mut connection = match connected {
            Ok(connection) => connection,
            Err(error) => {
                warn!(error = %format!("{error:#}"), connect_ms, "connecting to the database failed");
                self.probe().await;
                return Err(error);
            }
        };
        info!(connect_ms, "connected to the database");
        let result = timed("migrate", migrate(&mut connection)).await;
        let _ = tokio::time::timeout(Duration::from_secs(1), connection.close()).await;
        result
    }

    /// Logs how long resolving the database host and a TCP connect to each of its addresses take, to tell a
    /// slow resolver or an unreachable address from a slow TLS or MySQL handshake.
    async fn probe(&self) {
        if self.options.get_socket().is_some() {
            return;
        }
        let host = self.options.get_host().trim_matches(['[', ']']).to_owned();
        let port = self.options.get_port();
        let started = std::time::Instant::now();
        let resolved = tokio::time::timeout(
            PROBE_TIMEOUT,
            tokio::net::lookup_host((host.as_str(), port)),
        )
        .await;
        let resolve_ms = started.elapsed().as_millis() as u64;
        let addresses: Vec<std::net::SocketAddr> = match resolved {
            Ok(Ok(addresses)) => addresses.collect(),
            Ok(Err(error)) => {
                warn!(host, resolve_ms, error = %error, "database probe: resolving failed");
                return;
            }
            Err(_) => {
                warn!(host, resolve_ms, "database probe: resolving timed out");
                return;
            }
        };
        info!(host, resolve_ms, addresses = ?addresses, "database probe: resolved");
        for address in addresses {
            let started = std::time::Instant::now();
            let outcome =
                match tokio::time::timeout(PROBE_TIMEOUT, tokio::net::TcpStream::connect(address))
                    .await
                {
                    Ok(Ok(_)) => "ok".to_owned(),
                    Ok(Err(error)) => error.to_string(),
                    Err(_) => "timed out".to_owned(),
                };
            info!(%address, connect_ms = started.elapsed().as_millis() as u64, outcome, "database probe: TCP connect");
        }
    }

    /// Opens the pool's idle connections now, and tops them up every `WARM_INTERVAL`, in the background with the
    /// full `CONNECT_TIMEOUT`: sqlx only replaces them when it closes one, and a connection a request opens is
    /// lost when the request gives up first.
    fn keep_warm(&self) {
        let pool = self.pool.clone();
        let target = MIN_CONNECTIONS.min(pool.options().get_max_connections());
        tokio::spawn(async move {
            while !pool.is_closed() {
                let missing = target.saturating_sub(pool.size());
                if missing > 0 {
                    let started = std::time::Instant::now();
                    // Each goes back to the pool at once, so the request path never waits for them.
                    let results = futures_util::future::join_all(
                        (0..missing).map(|_| async { pool.acquire().await.map(drop) }),
                    )
                    .await;
                    let elapsed_ms = started.elapsed().as_millis() as u64;
                    let opened = results.iter().filter(|result| result.is_ok()).count();
                    match results.into_iter().find_map(Result::err) {
                        Some(sqlx::Error::PoolClosed) => return,
                        Some(error) => warn!(
                            opened, missing, elapsed_ms, error = %error,
                            "opening idle database connections failed"
                        ),
                        None => info!(opened, elapsed_ms, "opened idle database connections"),
                    }
                }
                tokio::time::sleep(WARM_INTERVAL).await;
            }
        });
    }

    /// Creates the tables unless the database is already at this version. Safe to run from several servers.
    pub async fn migrate(&self) -> Result<()> {
        timed("migrate", async {
            let mut connection = self.pool.acquire().await.map_err(db)?;
            migrate(&mut connection).await
        })
        .await
    }

    /// Open connections in the pool, and how many of them are idle.
    pub fn pool_connections(&self) -> (u32, usize) {
        (self.pool.size(), self.pool.num_idle())
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }

    pub async fn tunnel(&self, id: &str) -> Result<Option<Loaded>> {
        Ok(self
            .tunnel_with_alarm(id)
            .await?
            .map(|snapshot| snapshot.loaded))
    }

    /// The tunnel and its alarm, which come in the same read.
    pub async fn tunnel_with_alarm(&self, id: &str) -> Result<Option<AttachSnapshot>> {
        timed("tunnel", self.read(id)).await
    }

    /// The tunnel and its alarm in one round trip, for an attach. Gives up after `limit`.
    pub async fn attach_snapshot(
        &self,
        id: &str,
        limit: Duration,
    ) -> Result<Option<AttachSnapshot>> {
        timed_within("attach_snapshot", limit, self.read(id)).await
    }

    /// One tunnel with its alarm, read in the next batch.
    async fn read(&self, id: &str) -> ReadResult {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let start = {
            let mut reads = self.reads.lock().expect("reads lock");
            reads.waiting.push((id.to_owned(), tx));
            let start = reads.running < READ_BATCHES;
            if start {
                reads.running += 1;
            }
            start
        };
        if start {
            tokio::spawn(self.clone().read_batches());
        }
        rx.await
            .unwrap_or_else(|_| Err(anyhow!("storage read dropped").context("storage unavailable")))
    }

    /// Reads waiting tunnels in batches until none are left.
    async fn read_batches(self) {
        loop {
            let batch: Vec<_> = {
                let mut reads = self.reads.lock().expect("reads lock");
                if reads.waiting.is_empty() {
                    reads.running -= 1;
                    return;
                }
                let take = reads.waiting.len().min(READ_BATCH);
                reads.waiting.drain(..take).collect()
            };
            let ids: Vec<&str> = batch.iter().map(|(id, _)| id.as_str()).collect();
            match timed("tunnel_batch", self.read_tunnels(&ids)).await {
                Ok(found) => {
                    for (id, tx) in batch {
                        let _ = tx.send(match found.get(&id) {
                            None => Ok(None),
                            Some(Ok(snapshot)) => Ok(Some(snapshot.clone())),
                            Some(Err(error)) => Err(anyhow!("{error}")),
                        });
                    }
                }
                Err(error) => {
                    let error = format!("{error:#}");
                    let error = error
                        .strip_prefix("storage unavailable: ")
                        .unwrap_or(&error);
                    for (_, tx) in batch {
                        let _ = tx.send(Err(anyhow!("{error}").context("storage unavailable")));
                    }
                }
            }
        }
    }

    /// The rows found, each decoded or the reason it could not be.
    async fn read_tunnels(
        &self,
        ids: &[&str],
    ) -> Result<HashMap<String, Result<AttachSnapshot, String>>> {
        const SQL: &str = "SELECT id, record, revision, alarm_at FROM tunnels WHERE id ";
        let mut literals = Vec::new();
        let mut rows = Vec::new();
        for id in ids {
            match literal(id) {
                Some(literal) => literals.push(literal),
                // Bound alone: plain text needs no prepared statement per batch size.
                None => rows.extend(
                    sqlx::query(sqlx::AssertSqlSafe(format!("{SQL}= ?")))
                        .bind(*id)
                        .fetch_optional(&self.pool)
                        .await
                        .map_err(db)?,
                ),
            }
        }
        if !literals.is_empty() {
            literals.sort_unstable();
            literals.dedup();
            let list = literals.join(",");
            rows.extend(
                self.pool
                    // Every ID is a literal that needs no escaping.
                    .fetch_all(sqlx::AssertSqlSafe(format!("{SQL}IN ({list})")))
                    .await
                    .map_err(db)?,
            );
        }
        let mut found = HashMap::with_capacity(rows.len());
        for row in rows {
            let id: String = row.try_get(0)?;
            let decoded = (|| -> Result<AttachSnapshot> {
                let record: String = row.try_get(1)?;
                let revision: i64 = row.try_get(2)?;
                let alarm: Option<i64> = row.try_get(3)?;
                Ok(AttachSnapshot {
                    loaded: Loaded {
                        record: serde_json::from_str(&record)
                            .context("decoding a stored tunnel")?,
                        revision: revision as u64,
                    },
                    alarm: alarm.map(|alarm| alarm as u64),
                })
            })();
            found.insert(id, decoded.map_err(|error| format!("{error:#}")));
        }
        Ok(found)
    }

    /// Writes a record read at `revision` (0: no row existed) and returns its new revision. Fails with
    /// [`Conflict`] when the row changed meanwhile.
    pub async fn save_tunnel(&self, record: &StoredTunnel, revision: u64, now: u64) -> Result<u64> {
        let json = serde_json::to_string(record)?;
        let (deleted, issuing) = record_flags(record);
        timed("save_tunnel", async {
            if revision == 0 {
                let inserted = sqlx::query(
                    "INSERT INTO tunnels (id, record, revision, deleted, issuing, updated_at, local_update)
                     VALUES (?, ?, 1, ?, ?, ?, 1)",
                )
                .bind(&record.id)
                .bind(&json)
                .bind(deleted)
                .bind(issuing)
                .bind(now as i64)
                .execute(&self.pool)
                .await;
                return match inserted {
                    Ok(_) => Ok(1),
                    Err(error) if mysql_code(&error) == Some(ER_DUP_ENTRY) => Err(Conflict.into()),
                    Err(error) => Err(db(error)),
                };
            }
            let updated = sqlx::query(
                "UPDATE tunnels SET record = ?, revision = revision + 1, deleted = ?, issuing = ?, updated_at = ?,
                   local_update = 1
                 WHERE id = ? AND revision = ?",
            )
            .bind(&json)
            .bind(deleted)
            .bind(issuing)
            .bind(now as i64)
            .bind(&record.id)
            .bind(revision as i64)
            .execute(&self.pool)
            .await
            .map_err(db)?;
            if updated.rows_affected() == 0 {
                return Err(Conflict.into());
            }
            Ok(revision + 1)
        })
        .await
    }

    /// Writes a record whatever its revision, for seeding tests.
    #[doc(hidden)]
    pub async fn put_tunnel(&self, record: &StoredTunnel, now: u64) -> Result<()> {
        let json = serde_json::to_string(record)?;
        let (deleted, issuing) = record_flags(record);
        timed("put_tunnel", async {
            sqlx::query(
                "INSERT INTO tunnels (id, record, revision, deleted, issuing, updated_at, local_update)
                 VALUES (?, ?, 1, ?, ?, ?, 1)
                 ON DUPLICATE KEY UPDATE record = VALUES(record), revision = revision + 1,
                   deleted = VALUES(deleted), issuing = VALUES(issuing), updated_at = VALUES(updated_at),
                   local_update = 1",
            )
            .bind(&record.id)
            .bind(&json)
            .bind(deleted)
            .bind(issuing)
            .bind(now as i64)
            .execute(&self.pool)
            .await
            .map_err(db)?;
            Ok(())
        })
        .await
    }

    pub async fn alarm(&self, id: &str) -> Result<Option<u64>> {
        timed("alarm", async {
            let alarm: Option<Option<i64>> =
                sqlx::query_scalar("SELECT alarm_at FROM tunnels WHERE id = ?")
                    .bind(id)
                    .fetch_optional(&self.pool)
                    .await
                    .map_err(db)?;
            Ok(alarm.flatten().map(|alarm| alarm as u64))
        })
        .await
    }

    pub async fn set_alarm(&self, id: &str, at: Option<u64>) -> Result<()> {
        timed("set_alarm", async {
            sqlx::query("UPDATE tunnels SET alarm_at = ? WHERE id = ?")
                .bind(at.map(|at| at as i64))
                .bind(id)
                .execute(&self.pool)
                .await
                .map_err(db)?;
            Ok(())
        })
        .await
    }

    /// Clears and returns the alarms due at `now`, like a Durable Object alarm firing once. Each alarm is
    /// cleared only if it is still the one that was read, so concurrent callers never both take it.
    pub async fn take_due_alarms(&self, now: u64) -> Result<Vec<String>> {
        Ok(self.take_due_alarms_and_next(now).await?.0)
    }

    /// [`Store::take_due_alarms`], and when the next alarm after those is due (with the same query).
    pub async fn take_due_alarms_and_next(&self, now: u64) -> Result<(Vec<String>, Option<u64>)> {
        const LIMIT: usize = 500;
        timed("take_due_alarms", async {
            let mut due: Vec<(String, i64)> = sqlx::query_as(
                "SELECT id, alarm_at FROM tunnels WHERE alarm_at IS NOT NULL ORDER BY alarm_at LIMIT ?",
            )
            .bind(LIMIT as i64 + 1)
            .fetch_all(&self.pool)
            .await
            .map_err(db)?;
            let later = due
                .iter()
                .position(|(_, alarm)| *alarm as u64 > now)
                .unwrap_or(due.len())
                .min(LIMIT);
            let next = due.get(later).map(|(_, alarm)| (*alarm as u64).max(now));
            due.truncate(later);
            let mut taken = Vec::with_capacity(due.len());
            for (id, alarm) in due {
                let cleared =
                    sqlx::query("UPDATE tunnels SET alarm_at = NULL WHERE id = ? AND alarm_at = ?")
                        .bind(&id)
                        .bind(alarm)
                        .execute(&self.pool)
                        .await
                        .map_err(db)?;
                if cleared.rows_affected() == 1 {
                    taken.push(id);
                }
            }
            Ok((taken, next))
        })
        .await
    }

    pub async fn next_alarm(&self) -> Result<Option<u64>> {
        timed("next_alarm", async {
            let next: Option<i64> = sqlx::query_scalar("SELECT MIN(alarm_at) FROM tunnels")
                .fetch_one(&self.pool)
                .await
                .map_err(db)?;
            Ok(next.map(|next| next as u64))
        })
        .await
    }

    /// Records whose certificate is issuing or renewing, for resuming issuance that has no job.
    pub async fn issuing_tunnels(&self) -> Result<Vec<StoredTunnel>> {
        timed("issuing_tunnels", async {
            let rows: Vec<String> =
                sqlx::query_scalar("SELECT record FROM tunnels WHERE issuing = 1 AND deleted = 0")
                    .fetch_all(&self.pool)
                    .await
                    .map_err(db)?;
            rows.iter()
                .map(|row| serde_json::from_str(row).context("decoding a stored tunnel"))
                .collect()
        })
        .await
    }

    /// Imports a record exported from the Worker (or another server). A row this server has written since its
    /// last import is kept unless `force`.
    pub async fn import_tunnel(
        &self,
        record: StoredTunnel,
        alarm: Option<u64>,
        force: bool,
        now: u64,
    ) -> Result<ImportOutcome> {
        let json = serde_json::to_string(&record)?;
        let mut attempt = 0;
        loop {
            match timed(
                "import_tunnel",
                self.try_import(&record, &json, alarm, force, now),
            )
            .await
            {
                Err(error) if attempt < 5 && retryable(&error) => {
                    attempt += 1;
                    tokio::time::sleep(Duration::from_millis(20 * attempt)).await;
                }
                result => return result,
            }
        }
    }

    async fn try_import(
        &self,
        record: &StoredTunnel,
        json: &str,
        alarm: Option<u64>,
        force: bool,
        now: u64,
    ) -> Result<ImportOutcome> {
        let (deleted, issuing) = record_flags(record);
        // Insert first: locking a missing row would take a gap lock, which deadlocks concurrent imports.
        let inserted = sqlx::query(
            "INSERT INTO tunnels (id, record, revision, deleted, issuing, alarm_at, updated_at, imported_at,
               local_update)
             VALUES (?, ?, 1, ?, ?, ?, ?, ?, 0)",
        )
        .bind(&record.id)
        .bind(json)
        .bind(deleted)
        .bind(issuing)
        .bind(alarm.map(|alarm| alarm as i64))
        .bind(now as i64)
        .bind(now as i64)
        .execute(&self.pool)
        .await;
        match inserted {
            Ok(_) => return Ok(ImportOutcome::Inserted),
            Err(error) if mysql_code(&error) == Some(ER_DUP_ENTRY) => {}
            Err(error) => return Err(db(error)),
        }
        // Rows are never deleted, so the existing one is locked and compared without a race.
        let mut transaction = self.pool.begin().await.map_err(db)?;
        let (existing, local_update): (String, i8) =
            sqlx::query_as("SELECT record, local_update FROM tunnels WHERE id = ? FOR UPDATE")
                .bind(&record.id)
                .fetch_one(&mut *transaction)
                .await
                .map_err(db)?;
        let outcome = if local_update == 1 && !force {
            ImportOutcome::KeptLocal
        } else if existing == json {
            ImportOutcome::Unchanged
        } else {
            sqlx::query(
                "UPDATE tunnels SET record = ?, revision = revision + 1, deleted = ?, issuing = ?, alarm_at = ?,
                   updated_at = ?, imported_at = ?, local_update = 0
                 WHERE id = ?",
            )
            .bind(json)
            .bind(deleted)
            .bind(issuing)
            .bind(alarm.map(|alarm| alarm as i64))
            .bind(now as i64)
            .bind(now as i64)
            .bind(&record.id)
            .execute(&mut *transaction)
            .await
            .map_err(db)?;
            ImportOutcome::Updated
        };
        transaction.commit().await.map_err(db)?;
        Ok(outcome)
    }

    /// Up to `limit` tunnels with IDs after `after`, in ID order, with their renewal alarms: one page of an export.
    /// The whole table no longer fits in one result (PlanetScale refuses results over 64 MiB).
    pub async fn export_page(
        &self,
        after: Option<&str>,
        limit: usize,
    ) -> Result<Vec<(String, StoredTunnel, Option<u64>)>> {
        timed("export_page", async {
            let rows: Vec<(String, String, Option<i64>)> = sqlx::query_as(
                "SELECT id, record, alarm_at FROM tunnels WHERE id > ? ORDER BY id LIMIT ?",
            )
            .bind(after.unwrap_or(""))
            .bind(limit as u64)
            .fetch_all(&self.pool)
            .await
            .map_err(db)?;
            rows.into_iter()
                .map(|(id, record, alarm)| {
                    let record = serde_json::from_str(&record)
                        .with_context(|| format!("the record of {id}"))?;
                    Ok((id, record, alarm.map(|alarm| alarm as u64)))
                })
                .collect()
        })
        .await
    }

    /// Adds an issuance job unless one exists for the certificate ID. Returns whether it was added.
    pub async fn add_job(&self, job: Job, run_at: u64) -> Result<bool> {
        let identifiers = serde_json::to_string(&job.identifiers)?;
        timed("add_job", async {
            let added = sqlx::query(
                "INSERT INTO jobs (certificate_id, tunnel_id, kind, identifiers, csr, status, attempts, run_at,
                                   created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)",
            )
            .bind(&job.certificate_id)
            .bind(&job.tunnel_id)
            .bind(job.kind.as_str())
            .bind(&identifiers)
            .bind(&job.csr)
            .bind(job.attempts as i32)
            .bind(run_at as i64)
            .bind(job.created_at as i64)
            .bind(job.created_at as i64)
            .execute(&self.pool)
            .await;
            match added {
                Ok(_) => Ok(true),
                Err(error) if mysql_code(&error) == Some(ER_DUP_ENTRY) => Ok(false),
                Err(error) => Err(db(error)),
            }
        })
        .await
    }

    pub async fn job_exists(&self, certificate_id: &str) -> Result<bool> {
        self.job_status(certificate_id)
            .await
            .map(|status| status.is_some())
    }

    pub async fn job_pending(&self, certificate_id: &str) -> Result<bool> {
        self.job_status(certificate_id)
            .await
            .map(|status| status.as_deref() == Some("pending"))
    }

    async fn job_status(&self, certificate_id: &str) -> Result<Option<String>> {
        timed("job_status", async {
            sqlx::query_scalar("SELECT status FROM jobs WHERE certificate_id = ?")
                .bind(certificate_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(db)
        })
        .await
    }

    /// The admin stats' counts. `imported_unchanged` has no index to count from, so it scans the whole table
    /// (15-35 s at 110,000 tunnels): the counts run side by side, within `COUNTS_TIMEOUT` rather than the usual
    /// statement timeout. Nothing but `/api/admin/stats` and tests asks for them.
    pub async fn counts(&self) -> Result<serde_json::Value> {
        timed_within("counts", COUNTS_TIMEOUT, async {
            let queries = [
                ("tunnels", "SELECT COUNT(*) FROM tunnels WHERE deleted = 0"),
                ("deleted", "SELECT COUNT(*) FROM tunnels WHERE deleted = 1"),
                (
                    "imported_unchanged",
                    "SELECT COUNT(*) FROM tunnels WHERE local_update = 0",
                ),
                (
                    "alarms",
                    "SELECT COUNT(*) FROM tunnels WHERE alarm_at IS NOT NULL",
                ),
                (
                    "jobs_pending",
                    "SELECT COUNT(*) FROM jobs WHERE status = 'pending'",
                ),
                (
                    "jobs_failed",
                    "SELECT COUNT(*) FROM jobs WHERE status = 'failed'",
                ),
            ];
            let results = futures_util::future::try_join_all(queries.into_iter().map(
                |(name, sql)| async move {
                    let count: i64 = sqlx::query_scalar(sql)
                        .fetch_one(&self.pool)
                        .await
                        .map_err(db)?;
                    Ok::<_, anyhow::Error>((name, count))
                },
            ))
            .await?;
            let mut counts = serde_json::Map::new();
            for (name, count) in results {
                counts.insert(name.into(), count.into());
            }
            Ok(serde_json::Value::Object(counts))
        })
        .await
    }

    /// Pending jobs, and jobs that failed since `since`, for the metrics.
    pub async fn job_counts(&self, since: u64) -> Result<(u64, u64)> {
        timed("job_counts", async {
            let (pending, failed): (i64, i64) = sqlx::query_as(
                "SELECT
                   (SELECT COUNT(*) FROM jobs WHERE status = 'pending'),
                   (SELECT COUNT(*) FROM jobs WHERE status = 'failed' AND updated_at >= ?)",
            )
            .bind(since as i64)
            .fetch_one(&self.pool)
            .await
            .map_err(db)?;
            Ok((pending.max(0) as u64, failed.max(0) as u64))
        })
        .await
    }

    /// The names of every job some process is running now (an unexpired lease), whose challenge records are
    /// in use.
    pub async fn leased_job_identifiers(&self, now: u64) -> Result<Vec<String>> {
        timed("leased_job_identifiers", async {
            let rows: Vec<String> = sqlx::query_scalar(
                "SELECT identifiers FROM jobs WHERE status = 'pending' AND lease_until >= ?",
            )
            .bind(now as i64)
            .fetch_all(&self.pool)
            .await
            .map_err(db)?;
            Ok(rows
                .iter()
                .filter_map(|row| serde_json::from_str::<Vec<String>>(row).ok())
                .flatten()
                .collect())
        })
        .await
    }

    /// Certificate jobs pending, cluster-wide, for the issuance backlog limit.
    pub async fn pending_jobs(&self) -> Result<u64> {
        timed("pending_jobs", async {
            let pending: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM jobs WHERE status = 'pending'")
                    .fetch_one(&self.pool)
                    .await
                    .map_err(db)?;
            Ok(pending.max(0) as u64)
        })
        .await
    }

    /// Takes one request from `name`'s budget (GCRA, see `limits.rs`) at `now`. Usually one statement: a
    /// conditional update that only succeeds within the budget; a key not seen before is inserted.
    pub async fn take_rate(
        &self,
        name: &str,
        now: u64,
        rate: crate::limits::Rate,
    ) -> Result<crate::limits::Verdict> {
        use crate::limits::Verdict;
        let (now, interval, tolerance) = (
            now as i64,
            rate.interval_ms as i64,
            rate.tolerance_ms as i64,
        );
        timed("take_rate", async {
            for _ in 0..2 {
                let taken = sqlx::query(
                    "UPDATE rate_limits SET tat = GREATEST(tat, ?) + ?
                     WHERE name = ? AND GREATEST(tat, ?) <= ?",
                )
                .bind(now)
                .bind(interval)
                .bind(name)
                .bind(now)
                .bind(now + tolerance)
                .execute(&self.pool)
                .await
                .map_err(db)?;
                if taken.rows_affected() == 1 {
                    return Ok(Verdict::Allowed);
                }
                let inserted = sqlx::query("INSERT INTO rate_limits (name, tat) VALUES (?, ?)")
                    .bind(name)
                    .bind(now + interval)
                    .execute(&self.pool)
                    .await;
                match inserted {
                    Ok(_) => return Ok(Verdict::Allowed),
                    // It exists: over budget, or inserted by someone else in between (then try once more).
                    Err(error) if mysql_code(&error) == Some(ER_DUP_ENTRY) => {}
                    Err(error) => return Err(db(error)),
                }
            }
            let tat: Option<i64> = sqlx::query_scalar("SELECT tat FROM rate_limits WHERE name = ?")
                .bind(name)
                .fetch_optional(&self.pool)
                .await
                .map_err(db)?;
            let retry_after_ms = tat.map_or(0, |tat| tat - tolerance - now).max(1) as u64;
            Ok(Verdict::Limited { retry_after_ms })
        })
        .await
    }

    /// Deletes rate limit rows whose budget is full again (the same as no row). Returns how many.
    pub async fn prune_rate_limits(&self, now: u64) -> Result<u64> {
        timed("prune_rate_limits", async {
            let pruned = sqlx::query("DELETE FROM rate_limits WHERE tat < ? LIMIT 10000")
                .bind(now as i64)
                .execute(&self.pool)
                .await
                .map_err(db)?;
            Ok(pruned.rows_affected())
        })
        .await
    }

    /// Pending jobs due at `now` that nobody else holds, without taking them.
    pub async fn due_job_ids(&self, owner: &str, now: u64, limit: usize) -> Result<Vec<String>> {
        timed("due_job_ids", async {
            sqlx::query_scalar(
                "SELECT certificate_id FROM jobs
                 WHERE status = 'pending' AND run_at <= ?
                   AND (lease_until IS NULL OR lease_until < ? OR lease_owner = ?)
                 ORDER BY run_at LIMIT ?",
            )
            .bind(now as i64)
            .bind(now as i64)
            .bind(owner)
            .bind(limit as i64)
            .fetch_all(&self.pool)
            .await
            .map_err(db)
        })
        .await
    }

    /// Takes a due job for `owner` until `now + LEASE_MS`, unless another process holds an unexpired lease.
    /// Returns the job as it is once taken.
    pub async fn claim_job(
        &self,
        certificate_id: &str,
        owner: &str,
        now: u64,
    ) -> Result<Option<Job>> {
        timed("claim_job", async {
            let claimed = sqlx::query(
                "UPDATE jobs SET lease_owner = ?, lease_until = ?
                 WHERE certificate_id = ? AND status = 'pending' AND run_at <= ?
                   AND (lease_until IS NULL OR lease_until < ? OR lease_owner = ?)",
            )
            .bind(owner)
            .bind((now + LEASE_MS) as i64)
            .bind(certificate_id)
            .bind(now as i64)
            .bind(now as i64)
            .bind(owner)
            .execute(&self.pool)
            .await
            .map_err(db)?;
            if claimed.rows_affected() == 0 {
                return Ok(None);
            }
            let row: Option<JobRow> = sqlx::query_as(
                "SELECT certificate_id, tunnel_id, kind, identifiers, csr, attempts, created_at FROM jobs
                 WHERE certificate_id = ? AND lease_owner = ?",
            )
            .bind(certificate_id)
            .bind(owner)
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?;
            row.map(job_from_row).transpose()
        })
        .await
    }

    /// Takes up to `limit` due jobs for `owner`.
    pub async fn claim_due_jobs(&self, owner: &str, now: u64, limit: usize) -> Result<Vec<Job>> {
        let mut claimed = Vec::new();
        for id in self.due_job_ids(owner, now, limit).await? {
            if let Some(job) = self.claim_job(&id, owner, now).await? {
                claimed.push(job);
            }
        }
        Ok(claimed)
    }

    /// Extends a lease `owner` still holds. Returns false once it lost it.
    pub async fn extend_lease(&self, certificate_id: &str, owner: &str, now: u64) -> Result<bool> {
        timed("extend_lease", async {
            let extended = sqlx::query(
                "UPDATE jobs SET lease_until = ? WHERE certificate_id = ? AND lease_owner = ? AND status = 'pending'",
            )
            .bind((now + LEASE_MS) as i64)
            .bind(certificate_id)
            .bind(owner)
            .execute(&self.pool)
            .await
            .map_err(db)?;
            Ok(extended.rows_affected() == 1)
        })
        .await
    }

    /// Gives up every lease `owner` holds, on shutdown, so a restarted server resumes the jobs at once.
    pub async fn release_leases(&self, owner: &str) -> Result<()> {
        timed("release_leases", async {
            sqlx::query(
                "UPDATE jobs SET lease_owner = NULL, lease_until = NULL WHERE lease_owner = ?",
            )
            .bind(owner)
            .execute(&self.pool)
            .await
            .map_err(db)?;
            Ok(())
        })
        .await
    }

    /// Records a job's final status and releases its lease. Returns false if `owner` no longer held it.
    pub async fn finish_job(
        &self,
        certificate_id: &str,
        owner: &str,
        status: &'static str,
        error: Option<String>,
        now: u64,
    ) -> Result<bool> {
        timed("finish_job", async {
            let finished = sqlx::query(
                "UPDATE jobs SET status = ?, last_error = ?, updated_at = ?, lease_owner = NULL, lease_until = NULL
                 WHERE certificate_id = ? AND lease_owner = ?",
            )
            .bind(status)
            .bind(error)
            .bind(now as i64)
            .bind(certificate_id)
            .bind(owner)
            .execute(&self.pool)
            .await
            .map_err(db)?;
            Ok(finished.rows_affected() == 1)
        })
        .await
    }

    /// Schedules another attempt and releases the lease. Returns false if `owner` no longer held it.
    pub async fn retry_job(
        &self,
        certificate_id: &str,
        owner: &str,
        attempts: u32,
        run_at: u64,
        error: String,
        now: u64,
    ) -> Result<bool> {
        timed("retry_job", async {
            let retried = sqlx::query(
                "UPDATE jobs SET attempts = ?, run_at = ?, last_error = ?, updated_at = ?, lease_owner = NULL,
                   lease_until = NULL
                 WHERE certificate_id = ? AND lease_owner = ?",
            )
            .bind(attempts as i32)
            .bind(run_at as i64)
            .bind(error)
            .bind(now as i64)
            .bind(certificate_id)
            .bind(owner)
            .execute(&self.pool)
            .await
            .map_err(db)?;
            Ok(retried.rows_affected() == 1)
        })
        .await
    }

    /// Failed first-issuance jobs that last changed at or after `since`.
    pub async fn failed_issue_jobs(&self, since: u64) -> Result<Vec<FailedJob>> {
        timed("failed_issue_jobs", async {
            let rows: Vec<FailedJobRow> = sqlx::query_as(
                "SELECT certificate_id, tunnel_id, status, last_error, created_at, updated_at FROM jobs
                 WHERE status = 'failed' AND kind = 'issue' AND updated_at >= ?",
            )
            .bind(since as i64)
            .fetch_all(&self.pool)
            .await
            .map_err(db)?;
            Ok(rows.into_iter().map(failed_job_from_row).collect())
        })
        .await
    }

    /// First-issuance jobs queued before `before`, failed since `since` or still retrying, whose last attempt
    /// ended with an ACME authorization still pending.
    pub async fn authz_pending_issue_jobs(
        &self,
        before: u64,
        since: u64,
    ) -> Result<Vec<FailedJob>> {
        timed("authz_pending_issue_jobs", async {
            let rows: Vec<FailedJobRow> = sqlx::query_as(
                "SELECT certificate_id, tunnel_id, status, last_error, created_at, updated_at FROM jobs
                 WHERE kind = 'issue' AND status IN ('failed', 'pending') AND created_at < ? AND updated_at >= ?
                   AND last_error LIKE '%authorization ended in pending%'",
            )
            .bind(before as i64)
            .bind(since as i64)
            .fetch_all(&self.pool)
            .await
            .map_err(db)?;
            Ok(rows.into_iter().map(failed_job_from_row).collect())
        })
        .await
    }

    /// Queues a failed or retrying job that was queued before `before` again as if it were new, unless a
    /// server is running it. It counts as queued at `before` at the earliest, so it is requeued like this once.
    /// Only one caller wins. Returns whether this one did.
    pub async fn requeue_job_queued_before(
        &self,
        certificate_id: &str,
        before: u64,
        now: u64,
    ) -> Result<bool> {
        timed("requeue_job_queued_before", async {
            let requeued = sqlx::query(
                "UPDATE jobs SET status = 'pending', attempts = 0, run_at = ?, created_at = ?, updated_at = ?,
                   lease_owner = NULL, lease_until = NULL
                 WHERE certificate_id = ? AND status IN ('failed', 'pending') AND created_at < ?
                   AND (lease_until IS NULL OR lease_until < ?)",
            )
            .bind(now as i64)
            .bind(now.max(before) as i64)
            .bind(now as i64)
            .bind(certificate_id)
            .bind(before as i64)
            .bind(now as i64)
            .execute(&self.pool)
            .await
            .map_err(db)?;
            Ok(requeued.rows_affected() == 1)
        })
        .await
    }

    /// Queues a failed job again as if it were new, keeping its last error. Only one caller wins. Returns
    /// whether this one did.
    pub async fn requeue_failed_job(&self, certificate_id: &str, now: u64) -> Result<bool> {
        timed("requeue_failed_job", async {
            let requeued = sqlx::query(
                "UPDATE jobs SET status = 'pending', attempts = 0, run_at = ?, created_at = ?, updated_at = ?,
                   lease_owner = NULL, lease_until = NULL
                 WHERE certificate_id = ? AND status = 'failed'",
            )
            .bind(now as i64)
            .bind(now as i64)
            .bind(now as i64)
            .bind(certificate_id)
            .execute(&self.pool)
            .await
            .map_err(db)?;
            Ok(requeued.rows_affected() == 1)
        })
        .await
    }

    /// Up to `limit` pending jobs with when `owner` may take each (Unix ms) and their kind: when it is due and
    /// any lease of another process has expired. Those that may be taken at `now` come first, renewals and the
    /// server's own before first issuance (so a flood of new certificates cannot hold renewals up), then the
    /// rest soonest first. The job runner's one query per wakeup.
    pub async fn job_schedule(
        &self,
        owner: &str,
        now: u64,
        limit: usize,
    ) -> Result<Vec<(String, u64, JobKind)>> {
        timed("job_schedule", async {
            let rows: Vec<(String, i64, String)> = sqlx::query_as(
                "SELECT certificate_id,
                   GREATEST(run_at, CASE WHEN lease_until IS NULL OR lease_owner = ? THEN 0 ELSE lease_until + 1 END)
                     AS ready_at,
                   kind
                 FROM jobs WHERE status = 'pending'
                 ORDER BY ready_at > ?, kind = 'issue', ready_at LIMIT ?",
            )
            .bind(owner)
            .bind(now as i64)
            .bind(limit as i64)
            .fetch_all(&self.pool)
            .await
            .map_err(db)?;
            Ok(rows
                .into_iter()
                .map(|(id, ready_at, kind)| (id, ready_at.max(0) as u64, JobKind::parse(&kind)))
                .collect())
        })
        .await
    }

    pub async fn server_certificate(&self, name: &str) -> Result<Option<ServerCertificate>> {
        timed("server_certificate", async {
            let row: Option<ServerCertificateRow> =
                sqlx::query_as(
                    "SELECT private_key, csr, certificate, chain, expiry FROM server_certificates WHERE name = ?",
                )
                .bind(name)
                .fetch_optional(&self.pool)
                .await
                .map_err(db)?;
            Ok(
                row.map(|(private_key, csr, certificate, chain, expiry)| ServerCertificate {
                    private_key,
                    csr,
                    certificate,
                    chain,
                    expiry,
                }),
            )
        })
        .await
    }

    /// Stores the first key and CSR for `name` unless another server already did; returns what is stored.
    pub async fn create_server_certificate(
        &self,
        name: &str,
        certificate: ServerCertificate,
        now: u64,
    ) -> Result<ServerCertificate> {
        timed("create_server_certificate", async {
            let inserted = sqlx::query(
                "INSERT INTO server_certificates (name, private_key, csr, certificate, chain, expiry, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(name)
            .bind(&certificate.private_key)
            .bind(&certificate.csr)
            .bind(&certificate.certificate)
            .bind(&certificate.chain)
            .bind(&certificate.expiry)
            .bind(now as i64)
            .execute(&self.pool)
            .await;
            match inserted {
                Ok(_) => Ok(()),
                Err(error) if mysql_code(&error) == Some(ER_DUP_ENTRY) => Ok(()),
                Err(error) => Err(db(error)),
            }
        })
        .await?;
        self.server_certificate(name)
            .await?
            .ok_or_else(|| anyhow!("the server certificate disappeared"))
    }

    /// Stores an issued certificate, only for the CSR it was issued for.
    pub async fn save_server_certificate(
        &self,
        name: &str,
        certificate: ServerCertificate,
        now: u64,
    ) -> Result<()> {
        timed("save_server_certificate", async {
            sqlx::query(
                "UPDATE server_certificates SET certificate = ?, chain = ?, expiry = ?, updated_at = ?
                 WHERE name = ? AND csr = ?",
            )
            .bind(&certificate.certificate)
            .bind(&certificate.chain)
            .bind(&certificate.expiry)
            .bind(now as i64)
            .bind(name)
            .bind(&certificate.csr)
            .execute(&self.pool)
            .await
            .map_err(db)?;
            Ok(())
        })
        .await
    }

    pub async fn meta(&self, key: &str) -> Result<Option<String>> {
        timed("meta", async {
            sqlx::query_scalar("SELECT value FROM meta WHERE name = ?")
                .bind(key)
                .fetch_optional(&self.pool)
                .await
                .map_err(db)
        })
        .await
    }

    /// Sets `key` to `value`, whatever it was.
    pub async fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        timed("set_meta", async {
            sqlx::query(
                "INSERT INTO meta (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
            )
            .bind(key)
            .bind(value)
            .execute(&self.pool)
            .await
            .map_err(db)?;
            Ok(())
        })
        .await
    }

    /// Sets `key` to `value` only if it is still `expected` (`None`: absent). Returns whether it did.
    pub async fn swap_meta(&self, key: &str, expected: Option<&str>, value: &str) -> Result<bool> {
        timed("swap_meta", async {
            let result = match expected {
                None => {
                    sqlx::query("INSERT INTO meta (name, value) VALUES (?, ?)")
                        .bind(key)
                        .bind(value)
                        .execute(&self.pool)
                        .await
                }
                Some(expected) => {
                    sqlx::query("UPDATE meta SET value = ? WHERE name = ? AND value = ?")
                        .bind(value)
                        .bind(key)
                        .bind(expected)
                        .execute(&self.pool)
                        .await
                }
            };
            match result {
                Ok(done) => Ok(done.rows_affected() == 1),
                Err(error) if mysql_code(&error) == Some(ER_DUP_ENTRY) => Ok(false),
                Err(error) => Err(db(error)),
            }
        })
        .await
    }

    /// Which of `ids` are deleted.
    pub async fn deleted_tunnels(&self, ids: &[String]) -> Result<Vec<String>> {
        let mut deleted = Vec::new();
        for chunk in ids.chunks(500) {
            let found: Vec<String> = timed("deleted_tunnels", async {
                let mut query =
                    sqlx::QueryBuilder::new("SELECT id FROM tunnels WHERE deleted = 1 AND id IN (");
                let mut separated = query.separated(", ");
                for id in chunk {
                    separated.push_bind(id);
                }
                query.push(")");
                query
                    .build_query_scalar()
                    .fetch_all(&self.pool)
                    .await
                    .map_err(db)
            })
            .await?;
            deleted.extend(found);
        }
        Ok(deleted)
    }
}

/// The database was migrated by a newer server.
#[derive(Debug, thiserror::Error)]
#[error("database schema {0} is newer than this server ({SCHEMA_VERSION})")]
pub struct NewerSchema(i64);

/// A store in a new, empty database on the server `TEST_DATABASE_URL` points at, or `None` (with a note on
/// stderr) when it is unset. Tests skip themselves without it.
#[doc(hidden)]
pub async fn test_store() -> Option<Store> {
    let url = test_database_url().await?;
    Some(
        Store::open(&url)
            .await
            .expect("migrating the test database"),
    )
}

/// The URL of a new, empty database for one test (see [`test_store`]).
#[doc(hidden)]
pub async fn test_database_url() -> Option<String> {
    let Ok(base) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!(
            "skipping: TEST_DATABASE_URL is not set (a MySQL 8 server URL whose user may create databases, e.g. mysql://root:password@127.0.0.1:3306/opentunnel; see docs/server.md)"
        );
        return None;
    };
    let name = format!(
        "ot_test_{}",
        crate::crypto::uuid()
            .replace('-', "")
            .get(..16)
            .unwrap_or("x")
    );
    let admin = Store::connect_with(&base, 1).expect("TEST_DATABASE_URL");
    timed("test_database_url", async {
        admin
            .pool
            // The name is generated here from hex digits.
            .execute(sqlx::AssertSqlSafe(format!(
                "CREATE DATABASE `{name}` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin"
            )))
            .await
            .map_err(db)
    })
    .await
    .expect("creating a test database");
    admin.close().await;
    let mut url = url::Url::parse(&base).expect("TEST_DATABASE_URL");
    url.set_path(&format!("/{name}"));
    Some(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::iso;
    use opentunnel::protocol::api::TunnelState;

    fn record(id: &str) -> StoredTunnel {
        StoredTunnel {
            version: 1,
            id: id.into(),
            hostname: format!("{id}.opentunnel.test"),
            state: TunnelState::Offline,
            certificate_id: None,
            token_hash: "00ff".into(),
            created_at: iso(1_800_000_000_000),
            deleted_at: None,
            certificate: None,
            certificate_csr: None,
            certificate_identifiers: None,
            certificate_started_at: None,
            last_connected_at: None,
            renewal: None,
        }
    }

    fn job(id: &str) -> Job {
        Job {
            certificate_id: id.into(),
            tunnel_id: Some("abcdefghijkl".into()),
            kind: JobKind::Issue,
            identifiers: vec!["abcdefghijkl.opentunnel.test".into()],
            csr: "CSR".into(),
            attempts: 0,
            created_at: 1,
        }
    }

    #[test]
    fn requires_tls_for_remote_databases() {
        let remote = connect_options("mysql://u:p@aws.connect.psdb.cloud/opentunnel").unwrap();
        assert!(matches!(
            remote.get_ssl_mode(),
            MySqlSslMode::VerifyIdentity
        ));
        let verified = connect_options(
            "mysql://u:p@aws.connect.psdb.cloud/opentunnel?ssl-mode=VERIFY_IDENTITY",
        )
        .unwrap();
        assert!(matches!(
            verified.get_ssl_mode(),
            MySqlSslMode::VerifyIdentity
        ));
        assert!(
            connect_options("mysql://u:p@db.example.com/opentunnel?ssl-mode=DISABLED").is_err()
        );
        assert!(
            connect_options("mysql://u:p@db.example.com/opentunnel?sslmode=preferred").is_err()
        );
        assert!(connect_options("mysql://u:p@127.0.0.1:3306/opentunnel?ssl-mode=DISABLED").is_ok());
        assert!(connect_options("mysql://u:p@localhost/opentunnel").is_ok());
        assert!(connect_options("mysql://u:p@[::1]:3306/opentunnel?ssl-mode=DISABLED").is_ok());
        assert!(connect_options("postgres://u:p@localhost/opentunnel").is_err());
    }

    #[tokio::test]
    async fn keeps_records_byte_for_byte_and_checks_revisions() {
        let Some(store) = test_store().await else {
            return;
        };
        // Migrating again is a no-op.
        store.migrate().await.unwrap();
        let mut tunnel = record("abcdefghijkl");
        tunnel.renewal = Some(crate::record::Renewal {
            certificate_id: "cert_✓".into(),
            started_at: iso(1),
        });
        assert_eq!(store.save_tunnel(&tunnel, 0, 1).await.unwrap(), 1);
        assert!(
            store
                .save_tunnel(&tunnel, 0, 1)
                .await
                .unwrap_err()
                .is::<Conflict>()
        );
        let loaded = store.tunnel("abcdefghijkl").await.unwrap().unwrap();
        assert_eq!(loaded.revision, 1);
        assert_eq!(
            serde_json::to_string(&loaded.record).unwrap(),
            serde_json::to_string(&tunnel).unwrap()
        );
        assert_eq!(store.issuing_tunnels().await.unwrap().len(), 1);
        // IDs are case-sensitive, as they were in SQLite.
        assert!(store.tunnel("ABCDEFGHIJKL").await.unwrap().is_none());

        assert_eq!(store.save_tunnel(&tunnel, 1, 2).await.unwrap(), 2);
        assert!(
            store
                .save_tunnel(&tunnel, 1, 3)
                .await
                .unwrap_err()
                .is::<Conflict>()
        );
        tunnel.deleted_at = Some(iso(3));
        store.save_tunnel(&tunnel, 2, 3).await.unwrap();
        assert!(store.issuing_tunnels().await.unwrap().is_empty());
        assert_eq!(store.counts().await.unwrap()["deleted"], 1);
    }

    #[tokio::test]
    async fn imports_keep_local_changes_and_bump_revisions() {
        let Some(store) = test_store().await else {
            return;
        };
        let tunnel = record("abcdefghijkl");
        let import = |force| store.import_tunnel(tunnel.clone(), Some(5), force, 1);
        assert_eq!(import(false).await.unwrap(), ImportOutcome::Inserted);
        assert_eq!(import(false).await.unwrap(), ImportOutcome::Unchanged);
        assert_eq!(store.alarm("abcdefghijkl").await.unwrap(), Some(5));
        let mut changed = tunnel.clone();
        changed.state = TunnelState::Online;
        assert_eq!(
            store
                .import_tunnel(changed.clone(), None, false, 2)
                .await
                .unwrap(),
            ImportOutcome::Updated
        );
        let loaded = store.tunnel("abcdefghijkl").await.unwrap().unwrap();
        assert_eq!(loaded.revision, 2);
        store.save_tunnel(&loaded.record, 2, 3).await.unwrap();
        assert_eq!(import(false).await.unwrap(), ImportOutcome::KeptLocal);
        assert_eq!(import(true).await.unwrap(), ImportOutcome::Updated);

        // Concurrent imports of new records all land once.
        let imports = (0..8).map(|index| {
            let store = store.clone();
            async move {
                store
                    .import_tunnel(record(&format!("concurrent{index:02}")), None, false, 1)
                    .await
            }
        });
        for outcome in futures_util::future::join_all(imports).await {
            assert_eq!(outcome.unwrap(), ImportOutcome::Inserted);
        }

        // Machines importing the same record at once (the pull-through on first use) insert it once.
        let same = (0..8).map(|_| {
            let store = store.clone();
            async move {
                store
                    .import_tunnel(record("pulledthrugh"), Some(9), false, 1)
                    .await
            }
        });
        let mut outcomes: Vec<ImportOutcome> = futures_util::future::join_all(same)
            .await
            .into_iter()
            .map(Result::unwrap)
            .collect();
        outcomes.sort_by_key(|outcome| *outcome != ImportOutcome::Inserted);
        assert_eq!(outcomes[0], ImportOutcome::Inserted);
        assert!(
            outcomes[1..]
                .iter()
                .all(|outcome| *outcome == ImportOutcome::Unchanged)
        );
        let loaded = store.tunnel("pulledthrugh").await.unwrap().unwrap();
        assert_eq!(loaded.revision, 1);
    }

    #[tokio::test]
    async fn lists_deleted_tunnels() {
        let Some(store) = test_store().await else {
            return;
        };
        store.put_tunnel(&record("abcdefghijkl"), 1).await.unwrap();
        let mut deleted = record("deletedtunnl");
        deleted.deleted_at = Some(iso(1));
        store.put_tunnel(&deleted, 1).await.unwrap();
        assert_eq!(
            store
                .deleted_tunnels(&[
                    "abcdefghijkl".into(),
                    "deletedtunnl".into(),
                    "unknown".into()
                ])
                .await
                .unwrap(),
            vec!["deletedtunnl".to_owned()]
        );
        assert!(store.deleted_tunnels(&[]).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn attach_snapshots_read_the_record_and_alarm_at_once() {
        let Some(store) = test_store().await else {
            return;
        };
        let limit = Duration::from_secs(5);
        assert!(
            store
                .attach_snapshot("abcdefghijkl", limit)
                .await
                .unwrap()
                .is_none()
        );
        store.put_tunnel(&record("abcdefghijkl"), 1).await.unwrap();
        let snapshot = store
            .attach_snapshot("abcdefghijkl", limit)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(snapshot.loaded.revision, 1);
        assert_eq!(snapshot.loaded.record.id, "abcdefghijkl");
        assert_eq!(snapshot.alarm, None);
        store.set_alarm("abcdefghijkl", Some(77)).await.unwrap();
        let snapshot = store
            .attach_snapshot("abcdefghijkl", limit)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(snapshot.alarm, Some(77));
        // IDs that cannot be inlined as literals are bound instead, with the same result.
        assert!(
            store
                .attach_snapshot("abc'def", limit)
                .await
                .unwrap()
                .is_none()
        );
        assert!(store.tunnel("abc'def").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn alarm_scans_report_the_next_alarm() {
        let Some(store) = test_store().await else {
            return;
        };
        assert_eq!(
            store.take_due_alarms_and_next(100).await.unwrap(),
            (vec![], None)
        );
        for (id, at) in [
            ("tunnel000001", 50),
            ("tunnel000002", 300),
            ("tunnel000003", 400),
        ] {
            store.put_tunnel(&record(id), 1).await.unwrap();
            store.set_alarm(id, Some(at)).await.unwrap();
        }
        assert_eq!(
            store.take_due_alarms_and_next(100).await.unwrap(),
            (vec!["tunnel000001".to_owned()], Some(300))
        );
        assert_eq!(
            store.take_due_alarms_and_next(100).await.unwrap(),
            (vec![], Some(300))
        );
    }

    #[tokio::test]
    async fn alarms_fire_once_across_concurrent_callers() {
        let Some(store) = test_store().await else {
            return;
        };
        for index in 0..20 {
            let id = format!("tunnel{index:06}");
            store.put_tunnel(&record(&id), 1).await.unwrap();
            store.set_alarm(&id, Some(100 + index)).await.unwrap();
        }
        let (first, second) = tokio::join!(store.take_due_alarms(200), store.take_due_alarms(200));
        let mut taken = first.unwrap();
        taken.extend(second.unwrap());
        taken.sort();
        taken.dedup();
        assert_eq!(taken.len(), 20);
        assert_eq!(store.next_alarm().await.unwrap(), None);
    }

    #[tokio::test]
    async fn jobs_are_leased_to_one_owner() {
        let Some(store) = test_store().await else {
            return;
        };
        assert!(store.add_job(job("cert_1"), 10).await.unwrap());
        assert!(!store.add_job(job("cert_1"), 10).await.unwrap());
        assert!(store.claim_due_jobs("a", 5, 10).await.unwrap().is_empty());

        let (a, b) = tokio::join!(
            store.claim_job("cert_1", "a", 20),
            store.claim_job("cert_1", "b", 20)
        );
        let (a, b) = (a.unwrap(), b.unwrap());
        assert!(
            a.is_some() != b.is_some(),
            "exactly one owner takes the job"
        );
        let (owner, other) = if a.is_some() { ("a", "b") } else { ("b", "a") };
        assert!(
            store
                .claim_due_jobs(other, 20 + LEASE_MS - 1, 10)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            !store
                .finish_job("cert_1", other, "done", None, 30)
                .await
                .unwrap()
        );
        assert!(store.extend_lease("cert_1", owner, 1_000).await.unwrap());

        // An expired lease (a crashed owner) is taken over, and the old owner can no longer record results.
        let taken = store
            .claim_due_jobs(other, 1_000 + LEASE_MS + 1, 10)
            .await
            .unwrap();
        assert_eq!(taken.len(), 1);
        assert!(
            !store
                .retry_job("cert_1", owner, 1, 0, "x".into(), 40)
                .await
                .unwrap()
        );
        assert!(
            store
                .retry_job("cert_1", other, 1, 50, "x".into(), 40)
                .await
                .unwrap()
        );
        let retried = store.claim_due_jobs(owner, 60, 10).await.unwrap();
        assert_eq!(retried[0].attempts, 1);
        store.release_leases(owner).await.unwrap();
        assert!(
            store
                .claim_job("cert_1", other, 61)
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            store
                .finish_job("cert_1", other, "done", None, 70)
                .await
                .unwrap()
        );
        assert!(!store.job_pending("cert_1").await.unwrap());
        assert!(store.job_exists("cert_1").await.unwrap());
    }

    #[tokio::test]
    async fn job_schedules_say_when_each_job_may_be_taken() {
        let Some(store) = test_store().await else {
            return;
        };
        assert!(store.job_schedule("a", 30, 10).await.unwrap().is_empty());
        store.add_job(job("cert_due"), 10).await.unwrap();
        store.add_job(job("cert_later"), 500).await.unwrap();
        store.add_job(job("cert_leased"), 10).await.unwrap();
        store
            .claim_job("cert_leased", "b", 20)
            .await
            .unwrap()
            .unwrap();
        let issue = JobKind::Issue;
        // Another owner's lease holds the job until it expires; the owner's own lease does not.
        assert_eq!(
            store.job_schedule("a", 30, 10).await.unwrap(),
            [
                ("cert_due".to_owned(), 10, issue),
                ("cert_later".to_owned(), 500, issue),
                ("cert_leased".to_owned(), 20 + LEASE_MS + 1, issue),
            ]
        );
        assert_eq!(
            store.job_schedule("b", 30, 2).await.unwrap(),
            [
                ("cert_due".to_owned(), 10, issue),
                ("cert_leased".to_owned(), 10, issue)
            ]
        );
        // Due renewals come before due first issuance, even when queued later.
        store
            .add_job(
                Job {
                    kind: JobKind::Renew,
                    ..job("cert_renew")
                },
                25,
            )
            .await
            .unwrap();
        assert_eq!(
            store.job_schedule("b", 30, 2).await.unwrap(),
            [
                ("cert_renew".to_owned(), 25, JobKind::Renew),
                ("cert_due".to_owned(), 10, issue),
            ]
        );
        // Not yet due: soonest first, after everything due.
        assert_eq!(
            store.job_schedule("a", 20, 10).await.unwrap()[..2],
            [
                ("cert_due".to_owned(), 10, issue),
                ("cert_renew".to_owned(), 25, JobKind::Renew),
            ]
        );
        store
            .finish_job("cert_leased", "b", "done", None, 30)
            .await
            .unwrap();
        assert_eq!(store.job_schedule("a", 30, 10).await.unwrap().len(), 3);
        assert_eq!(store.pending_jobs().await.unwrap(), 3);
    }

    /// A database the previous version migrated (schema 2, before `rate_limits`) gets the table without a new
    /// schema version, so that version still starts against it.
    #[tokio::test]
    async fn adds_the_rate_limits_table_to_a_database_at_this_version() {
        let Some(store) = test_store().await else {
            return;
        };
        sqlx::query("DROP TABLE rate_limits")
            .execute(&store.pool)
            .await
            .unwrap();
        store.migrate().await.unwrap();
        let version: i64 = sqlx::query_scalar("SELECT MAX(version) FROM schema_migrations")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let rate = crate::limits::Rate {
            interval_ms: 100,
            tolerance_ms: 0,
        };
        assert_eq!(
            store.take_rate("k", 1_000, rate).await.unwrap(),
            crate::limits::Verdict::Allowed
        );
        store.migrate().await.unwrap();
    }

    /// The bridge registry of servers before the mesh is dropped from a database at this version.
    #[tokio::test]
    async fn drops_the_bridges_table() {
        let Some(store) = test_store().await else {
            return;
        };
        sqlx::query(
            "CREATE TABLE bridges (tunnel_id VARCHAR(191) NOT NULL PRIMARY KEY) DEFAULT CHARSET = utf8mb4",
        )
        .execute(&store.pool)
        .await
        .unwrap();
        store.migrate().await.unwrap();
        let tables: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM information_schema.tables
             WHERE table_schema = DATABASE() AND table_name = 'bridges'",
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(tables, 0);
        store.migrate().await.unwrap();
    }

    #[tokio::test]
    async fn rates_allow_a_burst_then_one_per_interval() {
        let Some(store) = test_store().await else {
            return;
        };
        let rate = crate::limits::Rate {
            interval_ms: 100,
            tolerance_ms: 200,
        };
        use crate::limits::Verdict::{Allowed, Limited};
        // A burst of three, then one every interval.
        for _ in 0..3 {
            assert_eq!(store.take_rate("k", 1_000, rate).await.unwrap(), Allowed);
        }
        assert_eq!(
            store.take_rate("k", 1_000, rate).await.unwrap(),
            Limited {
                retry_after_ms: 100
            }
        );
        assert_eq!(
            store.take_rate("k", 1_050, rate).await.unwrap(),
            Limited { retry_after_ms: 50 }
        );
        assert_eq!(store.take_rate("k", 1_100, rate).await.unwrap(), Allowed);
        assert!(matches!(
            store.take_rate("k", 1_100, rate).await.unwrap(),
            Limited { .. }
        ));
        // Other keys have their own budget.
        assert_eq!(
            store.take_rate("other", 1_100, rate).await.unwrap(),
            Allowed
        );
        // Concurrent first requests for a new key: exactly the burst goes through.
        let results =
            futures_util::future::join_all((0..10).map(|_| store.take_rate("new", 5_000, rate)))
                .await;
        let allowed = results
            .into_iter()
            .filter(|result| *result.as_ref().unwrap() == Allowed)
            .count();
        assert_eq!(allowed, 3);
        // Rows whose budget is full again are pruned; the rest stay.
        assert_eq!(store.prune_rate_limits(1_401).await.unwrap(), 2);
        assert!(matches!(
            store.take_rate("new", 5_000, rate).await.unwrap(),
            Limited { .. }
        ));
    }

    #[tokio::test]
    async fn server_certificates_and_meta_are_set_once() {
        let Some(store) = test_store().await else {
            return;
        };
        let created = |key: &str| ServerCertificate {
            private_key: key.into(),
            csr: format!("csr-{key}"),
            certificate: None,
            chain: None,
            expiry: None,
        };
        let first = store
            .create_server_certificate("opentunnel.test", created("a"), 1)
            .await
            .unwrap();
        let second = store
            .create_server_certificate("opentunnel.test", created("b"), 1)
            .await
            .unwrap();
        assert_eq!(first.private_key, "a");
        assert_eq!(second.private_key, "a");
        // A certificate for a CSR that is no longer stored is not saved.
        let stale = ServerCertificate {
            certificate: Some("C".into()),
            ..created("b")
        };
        store
            .save_server_certificate("opentunnel.test", stale, 2)
            .await
            .unwrap();
        assert!(
            store
                .server_certificate("opentunnel.test")
                .await
                .unwrap()
                .unwrap()
                .certificate
                .is_none()
        );

        assert!(store.swap_meta("k", None, "1").await.unwrap());
        assert!(!store.swap_meta("k", None, "2").await.unwrap());
        assert!(!store.swap_meta("k", Some("0"), "2").await.unwrap());
        assert!(store.swap_meta("k", Some("1"), "2").await.unwrap());
        assert_eq!(store.meta("k").await.unwrap().as_deref(), Some("2"));
    }
}
