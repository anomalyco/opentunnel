//! MySQL storage (PlanetScale in production). Records keep the Durable Object's JSON shape byte for byte.
//!
//! The schema follows Vitess' rules: every table has a primary key, there are no foreign keys, triggers or
//! stored procedures, and migrations are idempotent `CREATE TABLE IF NOT EXISTS` statements run at startup.
//! Nothing relies on a single writer: tunnel records carry a revision that every write checks, alarms and
//! job leases are taken with conditional updates, and imports lock the row they replace.

use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use sqlx::Executor;
use sqlx::mysql::{
    MySqlConnectOptions, MySqlDatabaseError, MySqlPool, MySqlPoolOptions, MySqlSslMode,
};
use tracing::warn;

use crate::record::StoredTunnel;

/// The schema version this server writes. A database at a newer version is refused.
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
  -- Reserved for assigning tunnels to regions; NULL is the primary region.
  region VARCHAR(32) NULL,
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
  -- pending, done or failed.
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
    // Version 2: where bridges are attached, so any machine can forward visitors to the one holding the bridge.
    r#"CREATE TABLE IF NOT EXISTS bridges (
  tunnel_id VARCHAR(191) NOT NULL,
  route VARCHAR(63) NOT NULL,
  machine_id VARCHAR(191) NOT NULL,
  -- The bridge on that machine, so a late removal cannot delete a newer bridge's row.
  bridge_id BIGINT NOT NULL,
  region VARCHAR(32) NOT NULL,
  -- The machine's internal listener on the private network, host:port.
  address VARCHAR(191) NOT NULL,
  -- Refreshed by the machine's heartbeat; readers ignore rows that stopped being refreshed.
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tunnel_id, route, machine_id),
  KEY bridges_machine (machine_id),
  KEY bridges_updated (updated_at)
) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin"#,
];

/// Every statement gives up after this long, so a stalled database cannot hang a request.
const QUERY_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a job lease lasts; the runner extends it while the job runs.
pub const LEASE_MS: u64 = 2 * 60 * 1000;

const ER_DUP_ENTRY: u16 = 1062;
const ER_LOCK_WAIT_TIMEOUT: u16 = 1205;
const ER_LOCK_DEADLOCK: u16 = 1213;

#[derive(Clone)]
pub struct Store {
    pool: MySqlPool,
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
    fn as_str(self) -> &'static str {
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

#[derive(Debug, Clone)]
pub struct ServerCertificate {
    pub private_key: String,
    pub csr: String,
    pub certificate: Option<String>,
    pub chain: Option<String>,
    pub expiry: Option<String>,
}

/// A route a bridge serves on some machine (a `bridges` row).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeLocation {
    pub tunnel_id: String,
    pub route: String,
    pub machine_id: String,
    pub bridge_id: u64,
    pub region: String,
    pub address: String,
    pub updated_at: u64,
}

/// What one machine holds, from the `bridges` table.
#[derive(Debug, Clone, Serialize)]
pub struct MachineBridges {
    pub machine_id: String,
    pub region: String,
    pub address: String,
    pub bridges: u64,
    pub tunnels: u64,
    pub routes: u64,
    pub updated_at: u64,
}

type BridgeRow = (String, String, String, i64, String, String, i64);

fn bridge_from_row(row: BridgeRow) -> BridgeLocation {
    let (tunnel_id, route, machine_id, bridge_id, region, address, updated_at) = row;
    BridgeLocation {
        tunnel_id,
        route,
        machine_id,
        bridge_id: bridge_id as u64,
        region,
        address,
        updated_at: updated_at as u64,
    }
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

/// Runs one storage operation with the statement timeout.
async fn timed<T>(future: impl Future<Output = Result<T>>) -> Result<T> {
    match tokio::time::timeout(QUERY_TIMEOUT, future).await {
        Ok(result) => result,
        Err(_) => Err(anyhow!("storage timed out").context("storage unavailable")),
    }
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
    pub fn connect(url: &str) -> Result<Self> {
        Self::connect_with(url, 10)
    }

    fn connect_with(url: &str, max_connections: u32) -> Result<Self> {
        let options = connect_options(url)?;
        let pool = MySqlPoolOptions::new()
            .max_connections(max_connections)
            .min_connections(1)
            .acquire_timeout(Duration::from_secs(5))
            .idle_timeout(Duration::from_secs(5 * 60))
            .max_lifetime(Duration::from_secs(30 * 60))
            // A connection the server or a proxy dropped is noticed and replaced before use.
            .test_before_acquire(true)
            .connect_lazy_with(options);
        Ok(Self { pool })
    }

    /// Connects and migrates, failing if the database is unavailable (the CLI's import and export).
    pub async fn open(url: &str) -> Result<Self> {
        let store = Self::connect(url)?;
        store.migrate().await?;
        Ok(store)
    }

    /// Migrates, retrying with backoff until the database answers. Only an incompatible schema is an error.
    pub async fn wait_ready(&self) -> Result<()> {
        let mut delay = Duration::from_millis(500);
        loop {
            match self.migrate().await {
                Ok(()) => return Ok(()),
                Err(error) if error.downcast_ref::<NewerSchema>().is_some() => return Err(error),
                Err(error) => {
                    warn!(error = %format!("{error:#}"), retry_in = ?delay, "the database is not ready");
                    tokio::time::sleep(delay).await;
                    delay = (delay * 2).min(Duration::from_secs(15));
                }
            }
        }
    }

    /// Creates the tables unless the database is already at this version. Safe to run from several servers.
    pub async fn migrate(&self) -> Result<()> {
        timed(async {
            let version: Option<i64> =
                match sqlx::query_scalar("SELECT MAX(version) FROM schema_migrations")
                    .fetch_one(&self.pool)
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
                    return Ok(());
                }
            }
            for statement in SCHEMA {
                self.pool.execute(*statement).await.map_err(db)?;
            }
            sqlx::query(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE version = version",
            )
            .bind(SCHEMA_VERSION)
            .bind(crate::clock::Clock::system().now_ms() as i64)
            .execute(&self.pool)
            .await
            .map_err(db)?;
            Ok(())
        })
        .await
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }

    pub async fn tunnel(&self, id: &str) -> Result<Option<Loaded>> {
        timed(async {
            let row: Option<(String, i64)> =
                sqlx::query_as("SELECT record, revision FROM tunnels WHERE id = ?")
                    .bind(id)
                    .fetch_optional(&self.pool)
                    .await
                    .map_err(db)?;
            row.map(|(record, revision)| {
                Ok(Loaded {
                    record: serde_json::from_str(&record).context("decoding a stored tunnel")?,
                    revision: revision as u64,
                })
            })
            .transpose()
        })
        .await
    }

    /// Writes a record read at `revision` (0: no row existed) and returns its new revision. Fails with
    /// [`Conflict`] when the row changed meanwhile.
    pub async fn save_tunnel(&self, record: &StoredTunnel, revision: u64, now: u64) -> Result<u64> {
        let json = serde_json::to_string(record)?;
        let (deleted, issuing) = record_flags(record);
        timed(async {
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
        timed(async {
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
        timed(async {
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
        timed(async {
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
        timed(async {
            let due: Vec<(String, i64)> = sqlx::query_as(
                "SELECT id, alarm_at FROM tunnels WHERE alarm_at IS NOT NULL AND alarm_at <= ?
                 ORDER BY alarm_at LIMIT 500",
            )
            .bind(now as i64)
            .fetch_all(&self.pool)
            .await
            .map_err(db)?;
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
            Ok(taken)
        })
        .await
    }

    pub async fn next_alarm(&self) -> Result<Option<u64>> {
        timed(async {
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
        timed(async {
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
            match timed(self.try_import(&record, &json, alarm, force, now)).await {
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

    pub async fn export_tunnels(&self) -> Result<Vec<(StoredTunnel, Option<u64>)>> {
        timed(async {
            let rows: Vec<(String, Option<i64>)> =
                sqlx::query_as("SELECT record, alarm_at FROM tunnels ORDER BY id")
                    .fetch_all(&self.pool)
                    .await
                    .map_err(db)?;
            rows.into_iter()
                .map(|(record, alarm)| {
                    Ok((
                        serde_json::from_str(&record)?,
                        alarm.map(|alarm| alarm as u64),
                    ))
                })
                .collect()
        })
        .await
    }

    /// Adds an issuance job unless one exists for the certificate ID. Returns whether it was added.
    pub async fn add_job(&self, job: Job, run_at: u64) -> Result<bool> {
        let identifiers = serde_json::to_string(&job.identifiers)?;
        timed(async {
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
        timed(async {
            sqlx::query_scalar("SELECT status FROM jobs WHERE certificate_id = ?")
                .bind(certificate_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(db)
        })
        .await
    }

    pub async fn counts(&self) -> Result<serde_json::Value> {
        timed(async {
            let mut counts = serde_json::Map::new();
            for (name, sql) in [
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
            ] {
                let count: i64 = sqlx::query_scalar(sql)
                    .fetch_one(&self.pool)
                    .await
                    .map_err(db)?;
                counts.insert(name.into(), count.into());
            }
            Ok(serde_json::Value::Object(counts))
        })
        .await
    }

    /// Pending jobs due at `now` that nobody else holds, without taking them.
    pub async fn due_job_ids(&self, owner: &str, now: u64, limit: usize) -> Result<Vec<String>> {
        timed(async {
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
        timed(async {
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
        timed(async {
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
        timed(async {
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
        timed(async {
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
        timed(async {
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

    pub async fn next_job_at(&self) -> Result<Option<u64>> {
        timed(async {
            let next: Option<i64> =
                sqlx::query_scalar("SELECT MIN(run_at) FROM jobs WHERE status = 'pending'")
                    .fetch_one(&self.pool)
                    .await
                    .map_err(db)?;
            Ok(next.map(|next| next as u64))
        })
        .await
    }

    pub async fn server_certificate(&self, name: &str) -> Result<Option<ServerCertificate>> {
        timed(async {
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
        timed(async {
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
        timed(async {
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
        timed(async {
            sqlx::query_scalar("SELECT value FROM meta WHERE name = ?")
                .bind(key)
                .fetch_optional(&self.pool)
                .await
                .map_err(db)
        })
        .await
    }

    /// Sets `key` to `value` only if it is still `expected` (`None`: absent). Returns whether it did.
    pub async fn swap_meta(&self, key: &str, expected: Option<&str>, value: &str) -> Result<bool> {
        timed(async {
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

    // --- Bridge locations (the cluster registry) -------------------------------------------------------------

    /// Records that `machine_id` serves `routes` of a tunnel with one bridge, replacing older rows for them.
    pub async fn put_bridge(&self, location: &BridgeLocation, routes: &[String]) -> Result<()> {
        if routes.is_empty() {
            return Ok(());
        }
        timed(async {
            let mut query = sqlx::QueryBuilder::new(
                "INSERT INTO bridges (tunnel_id, route, machine_id, bridge_id, region, address, updated_at) ",
            );
            query.push_values(routes, |mut row, route| {
                row.push_bind(&location.tunnel_id)
                    .push_bind(route)
                    .push_bind(&location.machine_id)
                    .push_bind(location.bridge_id as i64)
                    .push_bind(&location.region)
                    .push_bind(&location.address)
                    .push_bind(location.updated_at as i64);
            });
            query.push(
                " ON DUPLICATE KEY UPDATE bridge_id = VALUES(bridge_id), region = VALUES(region),
                   address = VALUES(address), updated_at = VALUES(updated_at)",
            );
            query.build().execute(&self.pool).await.map_err(db)?;
            Ok(())
        })
        .await
    }

    /// Removes one bridge's rows; a newer bridge that took the same routes on the machine keeps its rows.
    pub async fn delete_bridge(
        &self,
        tunnel_id: &str,
        machine_id: &str,
        bridge_id: u64,
    ) -> Result<()> {
        timed(async {
            sqlx::query(
                "DELETE FROM bridges WHERE tunnel_id = ? AND machine_id = ? AND bridge_id = ?",
            )
            .bind(tunnel_id)
            .bind(machine_id)
            .bind(bridge_id as i64)
            .execute(&self.pool)
            .await
            .map_err(db)?;
            Ok(())
        })
        .await
    }

    pub async fn delete_tunnel_bridges(&self, tunnel_id: &str) -> Result<()> {
        timed(async {
            sqlx::query("DELETE FROM bridges WHERE tunnel_id = ?")
                .bind(tunnel_id)
                .execute(&self.pool)
                .await
                .map_err(db)?;
            Ok(())
        })
        .await
    }

    /// Removes every row of a machine, at its startup and clean shutdown.
    pub async fn delete_machine_bridges(&self, machine_id: &str) -> Result<u64> {
        timed(async {
            let deleted = sqlx::query("DELETE FROM bridges WHERE machine_id = ?")
                .bind(machine_id)
                .execute(&self.pool)
                .await
                .map_err(db)?;
            Ok(deleted.rows_affected())
        })
        .await
    }

    /// Removes rows nobody refreshed since `before`, left behind by machines that are gone.
    pub async fn delete_expired_bridges(&self, before: u64) -> Result<u64> {
        timed(async {
            let deleted = sqlx::query("DELETE FROM bridges WHERE updated_at < ?")
                .bind(before as i64)
                .execute(&self.pool)
                .await
                .map_err(db)?;
            Ok(deleted.rows_affected())
        })
        .await
    }

    /// The machine's heartbeat: marks its rows current.
    pub async fn refresh_bridges(&self, machine_id: &str, now: u64) -> Result<u64> {
        timed(async {
            let refreshed = sqlx::query("UPDATE bridges SET updated_at = ? WHERE machine_id = ?")
                .bind(now as i64)
                .bind(machine_id)
                .execute(&self.pool)
                .await
                .map_err(db)?;
            Ok(refreshed.rows_affected())
        })
        .await
    }

    /// Rows for a tunnel (one route, or all) refreshed since `since`, newest first.
    pub async fn bridge_locations(
        &self,
        tunnel_id: &str,
        route: Option<&str>,
        since: u64,
    ) -> Result<Vec<BridgeLocation>> {
        timed(async {
            let rows: Vec<BridgeRow> = sqlx::query_as(
                "SELECT tunnel_id, route, machine_id, bridge_id, region, address, updated_at FROM bridges
                 WHERE tunnel_id = ? AND (? IS NULL OR route = ?) AND updated_at >= ?
                 ORDER BY updated_at DESC",
            )
            .bind(tunnel_id)
            .bind(route)
            .bind(route)
            .bind(since as i64)
            .fetch_all(&self.pool)
            .await
            .map_err(db)?;
            Ok(rows.into_iter().map(bridge_from_row).collect())
        })
        .await
    }

    /// Bridges per machine, from rows refreshed since `since`.
    pub async fn machine_bridges(&self, since: u64) -> Result<Vec<MachineBridges>> {
        timed(async {
            let rows: Vec<(String, String, String, i64, i64, i64, i64)> = sqlx::query_as(
                "SELECT machine_id, MAX(region), MAX(address), COUNT(DISTINCT tunnel_id, bridge_id),
                   COUNT(DISTINCT tunnel_id), COUNT(*), MAX(updated_at)
                 FROM bridges WHERE updated_at >= ? GROUP BY machine_id ORDER BY MAX(region), machine_id",
            )
            .bind(since as i64)
            .fetch_all(&self.pool)
            .await
            .map_err(db)?;
            Ok(rows
                .into_iter()
                .map(
                    |(machine_id, region, address, bridges, tunnels, routes, updated_at)| {
                        MachineBridges {
                            machine_id,
                            region,
                            address,
                            bridges: bridges as u64,
                            tunnels: tunnels as u64,
                            routes: routes as u64,
                            updated_at: updated_at as u64,
                        }
                    },
                )
                .collect())
        })
        .await
    }

    /// Which of `ids` are deleted.
    pub async fn deleted_tunnels(&self, ids: &[String]) -> Result<Vec<String>> {
        let mut deleted = Vec::new();
        for chunk in ids.chunks(500) {
            let found: Vec<String> = timed(async {
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
    timed(async {
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
    async fn registry_rows_expire_and_belong_to_one_bridge() {
        let Some(store) = test_store().await else {
            return;
        };
        let location = |machine: &str, bridge_id, updated_at| BridgeLocation {
            tunnel_id: "abcdefghijkl".into(),
            route: String::new(),
            machine_id: machine.into(),
            bridge_id,
            region: "iad".into(),
            address: "[fdaa::1]:9000".into(),
            updated_at,
        };
        let routes = vec!["api".to_owned(), "@".to_owned()];
        store
            .put_bridge(&location("a", 1, 100), &routes)
            .await
            .unwrap();
        store
            .put_bridge(&location("b", 7, 150), &routes[..1])
            .await
            .unwrap();
        let api = store
            .bridge_locations("abcdefghijkl", Some("api"), 0)
            .await
            .unwrap();
        assert_eq!(api.len(), 2);
        assert_eq!(api[0].machine_id, "b");
        assert_eq!(
            store
                .bridge_locations("abcdefghijkl", None, 120)
                .await
                .unwrap()
                .len(),
            1
        );
        // A newer bridge on the machine takes the rows; the old one's late removal leaves them.
        store
            .put_bridge(&location("a", 2, 160), &routes)
            .await
            .unwrap();
        store.delete_bridge("abcdefghijkl", "a", 1).await.unwrap();
        assert_eq!(
            store
                .bridge_locations("abcdefghijkl", None, 0)
                .await
                .unwrap()
                .len(),
            3
        );
        assert_eq!(store.refresh_bridges("a", 500).await.unwrap(), 2);
        let machines = store.machine_bridges(400).await.unwrap();
        assert_eq!(machines.len(), 1);
        assert_eq!((machines[0].bridges, machines[0].routes), (1, 2));
        assert_eq!(store.delete_expired_bridges(400).await.unwrap(), 1);
        assert_eq!(store.delete_machine_bridges("a").await.unwrap(), 2);

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
