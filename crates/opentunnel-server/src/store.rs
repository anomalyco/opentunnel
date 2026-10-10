//! SQLite storage: one file on the Fly volume. Calls run on Tokio's blocking pool; every statement is small.

use std::path::Path;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::record::StoredTunnel;

const SCHEMA_VERSION: i64 = 1;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS tunnels (
  id TEXT PRIMARY KEY,
  -- The record, in the Durable Object's StoredTunnel JSON shape.
  record TEXT NOT NULL,
  -- The renewal alarm (the Durable Object's storage alarm), Unix milliseconds.
  alarm_at INTEGER,
  -- Reserved for assigning tunnels to regions; NULL is the primary region.
  region TEXT,
  updated_at INTEGER NOT NULL,
  imported_at INTEGER,
  -- 0 while the row is exactly as last imported, so a later import may refresh it; 1 once this server wrote it.
  local_update INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS tunnels_alarm ON tunnels (alarm_at) WHERE alarm_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS jobs (
  certificate_id TEXT PRIMARY KEY,
  -- NULL for the server's own certificates.
  tunnel_id TEXT,
  kind TEXT NOT NULL,
  identifiers TEXT NOT NULL,
  csr TEXT NOT NULL,
  -- pending, done or failed.
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  run_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_pending ON jobs (run_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS server_certificates (
  name TEXT PRIMARY KEY,
  private_key TEXT NOT NULL,
  csr TEXT NOT NULL,
  certificate TEXT,
  chain TEXT,
  expiry TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"#;

#[derive(Clone)]
pub struct Store {
    connection: Arc<Mutex<Connection>>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportOutcome {
    Inserted,
    Updated,
    Unchanged,
    /// The row changed on this server since it was imported, so it is the newer copy.
    KeptLocal,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        let connection =
            Connection::open(path).with_context(|| format!("opening {}", path.display()))?;
        Self::init(connection)
    }

    pub fn memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(connection: Connection) -> Result<Self> {
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "NORMAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        anyhow::ensure!(
            version <= SCHEMA_VERSION,
            "database schema {version} is newer than this server ({SCHEMA_VERSION})"
        );
        connection.execute_batch(SCHEMA)?;
        connection.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    /// Runs `f` with the connection on the blocking pool.
    pub async fn call<R: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<R> + Send + 'static,
    ) -> Result<R> {
        let connection = self.connection.clone();
        tokio::task::spawn_blocking(move || {
            let mut connection = connection
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            f(&mut connection)
        })
        .await
        .context("storage task failed")?
    }

    pub async fn tunnel(&self, id: &str) -> Result<Option<StoredTunnel>> {
        let id = id.to_owned();
        self.call(move |connection| {
            let record: Option<String> = connection
                .query_row(
                    "SELECT record FROM tunnels WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .optional()?;
            record
                .map(|record| serde_json::from_str(&record).context("decoding a stored tunnel"))
                .transpose()
        })
        .await
    }

    pub async fn save_tunnel(&self, record: &StoredTunnel, now: u64) -> Result<()> {
        let id = record.id.clone();
        let json = serde_json::to_string(record)?;
        self.call(move |connection| {
            connection.execute(
                "INSERT INTO tunnels (id, record, updated_at, local_update) VALUES (?1, ?2, ?3, 1)
                 ON CONFLICT (id) DO UPDATE SET record = ?2, updated_at = ?3, local_update = 1",
                params![id, json, now as i64],
            )?;
            Ok(())
        })
        .await
    }

    pub async fn alarm(&self, id: &str) -> Result<Option<u64>> {
        let id = id.to_owned();
        self.call(move |connection| {
            let alarm: Option<Option<i64>> = connection
                .query_row(
                    "SELECT alarm_at FROM tunnels WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .optional()?;
            Ok(alarm.flatten().map(|alarm| alarm as u64))
        })
        .await
    }

    pub async fn set_alarm(&self, id: &str, at: Option<u64>) -> Result<()> {
        let id = id.to_owned();
        self.call(move |connection| {
            connection.execute(
                "UPDATE tunnels SET alarm_at = ?2 WHERE id = ?1",
                params![id, at.map(|at| at as i64)],
            )?;
            Ok(())
        })
        .await
    }

    /// Clears and returns the alarms due at `now`, like a Durable Object alarm firing once.
    pub async fn take_due_alarms(&self, now: u64) -> Result<Vec<String>> {
        self.call(move |connection| {
            let transaction = connection.transaction()?;
            let ids = {
                let mut statement = transaction.prepare(
                    "SELECT id FROM tunnels WHERE alarm_at IS NOT NULL AND alarm_at <= ?1 ORDER BY alarm_at LIMIT 500",
                )?;
                statement
                    .query_map(params![now as i64], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?
            };
            for id in &ids {
                transaction.execute("UPDATE tunnels SET alarm_at = NULL WHERE id = ?1", params![id])?;
            }
            transaction.commit()?;
            Ok(ids)
        })
        .await
    }

    pub async fn next_alarm(&self) -> Result<Option<u64>> {
        self.call(|connection| {
            let next: Option<i64> =
                connection.query_row("SELECT MIN(alarm_at) FROM tunnels", [], |row| row.get(0))?;
            Ok(next.map(|next| next as u64))
        })
        .await
    }

    /// Records whose certificate is issuing or renewing, for resuming issuance that has no job.
    pub async fn issuing_tunnels(&self) -> Result<Vec<StoredTunnel>> {
        self.call(|connection| {
            let mut statement = connection.prepare(
                "SELECT record FROM tunnels
                 WHERE json_extract(record, '$.deletedAt') IS NULL
                   AND (json_extract(record, '$.certificate.state.type') IN ('issuing', 'challenge')
                        OR json_extract(record, '$.renewal') IS NOT NULL)",
            )?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
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
        self.call(move |connection| {
            let transaction = connection.transaction()?;
            let existing: Option<(String, i64)> = transaction
                .query_row(
                    "SELECT record, local_update FROM tunnels WHERE id = ?1",
                    params![record.id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let outcome = match existing {
                None => {
                    transaction.execute(
                        "INSERT INTO tunnels (id, record, alarm_at, updated_at, imported_at, local_update)
                         VALUES (?1, ?2, ?3, ?4, ?4, 0)",
                        params![record.id, json, alarm.map(|alarm| alarm as i64), now as i64],
                    )?;
                    ImportOutcome::Inserted
                }
                Some((_, 1)) if !force => ImportOutcome::KeptLocal,
                Some((existing, _)) if existing == json => ImportOutcome::Unchanged,
                Some(_) => {
                    transaction.execute(
                        "UPDATE tunnels SET record = ?2, alarm_at = ?3, updated_at = ?4, imported_at = ?4,
                         local_update = 0 WHERE id = ?1",
                        params![record.id, json, alarm.map(|alarm| alarm as i64), now as i64],
                    )?;
                    ImportOutcome::Updated
                }
            };
            transaction.commit()?;
            Ok(outcome)
        })
        .await
    }

    pub async fn export_tunnels(&self) -> Result<Vec<(StoredTunnel, Option<u64>)>> {
        self.call(|connection| {
            let mut statement =
                connection.prepare("SELECT record, alarm_at FROM tunnels ORDER BY id")?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
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
        self.call(move |connection| {
            let added = connection.execute(
                "INSERT INTO jobs (certificate_id, tunnel_id, kind, identifiers, csr, status, attempts, run_at,
                                   created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7, ?8, ?8)
                 ON CONFLICT (certificate_id) DO NOTHING",
                params![
                    job.certificate_id,
                    job.tunnel_id,
                    job.kind.as_str(),
                    serde_json::to_string(&job.identifiers)?,
                    job.csr,
                    job.attempts,
                    run_at as i64,
                    job.created_at as i64,
                ],
            )?;
            Ok(added == 1)
        })
        .await
    }

    pub async fn job_exists(&self, certificate_id: &str) -> Result<bool> {
        let certificate_id = certificate_id.to_owned();
        self.call(move |connection| {
            Ok(connection
                .query_row(
                    "SELECT 1 FROM jobs WHERE certificate_id = ?1",
                    params![certificate_id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some())
        })
        .await
    }

    pub async fn job_pending(&self, certificate_id: &str) -> Result<bool> {
        let certificate_id = certificate_id.to_owned();
        self.call(move |connection| {
            Ok(connection
                .query_row(
                    "SELECT 1 FROM jobs WHERE certificate_id = ?1 AND status = 'pending'",
                    params![certificate_id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some())
        })
        .await
    }

    pub async fn counts(&self) -> Result<serde_json::Value> {
        self.call(|connection| {
            let count = |sql: &str| -> rusqlite::Result<i64> { connection.query_row(sql, [], |row| row.get(0)) };
            Ok(serde_json::json!({
                "tunnels": count("SELECT COUNT(*) FROM tunnels WHERE json_extract(record, '$.deletedAt') IS NULL")?,
                "deleted": count("SELECT COUNT(*) FROM tunnels WHERE json_extract(record, '$.deletedAt') IS NOT NULL")?,
                "imported_unchanged": count("SELECT COUNT(*) FROM tunnels WHERE local_update = 0")?,
                "alarms": count("SELECT COUNT(*) FROM tunnels WHERE alarm_at IS NOT NULL")?,
                "jobs_pending": count("SELECT COUNT(*) FROM jobs WHERE status = 'pending'")?,
                "jobs_failed": count("SELECT COUNT(*) FROM jobs WHERE status = 'failed'")?,
            }))
        })
        .await
    }

    pub async fn due_jobs(&self, now: u64, limit: usize) -> Result<Vec<Job>> {
        self.call(move |connection| {
            let mut statement = connection.prepare(
                "SELECT certificate_id, tunnel_id, kind, identifiers, csr, attempts, created_at FROM jobs
                 WHERE status = 'pending' AND run_at <= ?1 ORDER BY run_at LIMIT ?2",
            )?;
            let rows = statement
                .query_map(params![now as i64, limit as i64], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, u32>(5)?,
                        row.get::<_, i64>(6)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows.into_iter()
                .map(
                    |(certificate_id, tunnel_id, kind, identifiers, csr, attempts, created_at)| {
                        Ok(Job {
                            certificate_id,
                            tunnel_id,
                            kind: JobKind::parse(&kind),
                            identifiers: serde_json::from_str(&identifiers)?,
                            csr,
                            attempts,
                            created_at: created_at as u64,
                        })
                    },
                )
                .collect()
        })
        .await
    }

    pub async fn next_job_at(&self) -> Result<Option<u64>> {
        self.call(|connection| {
            let next: Option<i64> = connection.query_row(
                "SELECT MIN(run_at) FROM jobs WHERE status = 'pending'",
                [],
                |row| row.get(0),
            )?;
            Ok(next.map(|next| next as u64))
        })
        .await
    }

    pub async fn finish_job(
        &self,
        certificate_id: &str,
        status: &'static str,
        error: Option<String>,
        now: u64,
    ) -> Result<()> {
        let certificate_id = certificate_id.to_owned();
        self.call(move |connection| {
            connection.execute(
                "UPDATE jobs SET status = ?2, last_error = ?3, updated_at = ?4 WHERE certificate_id = ?1",
                params![certificate_id, status, error, now as i64],
            )?;
            Ok(())
        })
        .await
    }

    pub async fn retry_job(
        &self,
        certificate_id: &str,
        attempts: u32,
        run_at: u64,
        error: String,
        now: u64,
    ) -> Result<()> {
        let certificate_id = certificate_id.to_owned();
        self.call(move |connection| {
            connection.execute(
                "UPDATE jobs SET attempts = ?2, run_at = ?3, last_error = ?4, updated_at = ?5
                 WHERE certificate_id = ?1",
                params![certificate_id, attempts, run_at as i64, error, now as i64],
            )?;
            Ok(())
        })
        .await
    }

    pub async fn server_certificate(&self, name: &str) -> Result<Option<ServerCertificate>> {
        let name = name.to_owned();
        self.call(move |connection| {
            Ok(connection
                .query_row(
                    "SELECT private_key, csr, certificate, chain, expiry FROM server_certificates WHERE name = ?1",
                    params![name],
                    |row| {
                        Ok(ServerCertificate {
                            private_key: row.get(0)?,
                            csr: row.get(1)?,
                            certificate: row.get(2)?,
                            chain: row.get(3)?,
                            expiry: row.get(4)?,
                        })
                    },
                )
                .optional()?)
        })
        .await
    }

    pub async fn save_server_certificate(
        &self,
        name: &str,
        certificate: ServerCertificate,
        now: u64,
    ) -> Result<()> {
        let name = name.to_owned();
        self.call(move |connection| {
            connection.execute(
                "INSERT INTO server_certificates (name, private_key, csr, certificate, chain, expiry, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT (name) DO UPDATE SET private_key = ?2, csr = ?3, certificate = ?4, chain = ?5,
                   expiry = ?6, updated_at = ?7",
                params![
                    name,
                    certificate.private_key,
                    certificate.csr,
                    certificate.certificate,
                    certificate.chain,
                    certificate.expiry,
                    now as i64
                ],
            )?;
            Ok(())
        })
        .await
    }

    pub async fn meta(&self, key: &str) -> Result<Option<String>> {
        let key = key.to_owned();
        self.call(move |connection| {
            Ok(connection
                .query_row(
                    "SELECT value FROM meta WHERE key = ?1",
                    params![key],
                    |row| row.get(0),
                )
                .optional()?)
        })
        .await
    }

    pub async fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        let key = key.to_owned();
        let value = value.to_owned();
        self.call(move |connection| {
            connection.execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = ?2",
                params![key, value],
            )?;
            Ok(())
        })
        .await
    }
}
