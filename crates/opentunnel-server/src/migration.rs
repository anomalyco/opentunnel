//! Moving tunnels from the Cloudflare Worker (docs/cutover.md). The export file format is permanent; everything
//! that talks to the Worker is TEMPORARY and only runs when `LEGACY_WORKER_URL` is set:
//!
//! - the legacy fallback carries public connections for tunnels whose client is still attached to the Worker
//!   to its `/api/relay` endpoint, exactly as the AWS relay did;
//! - the pull-through imports a tunnel the first time this server hears of it, so tunnels created on the
//!   Worker after the bulk export keep working.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, info, warn};

use crate::clock::Clock;
use crate::http::{Stats, count};
use crate::record::StoredTunnel;
use crate::relay::{Accepted, Fallback};
use crate::store::{ImportOutcome, Store};

/// The export file: what `bun migration/worker.ts export` writes and `opentunnel-server export` writes.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFile {
    pub version: u32,
    #[serde(default)]
    pub exported_at: Option<String>,
    pub records: Vec<ExportedRecord>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedRecord {
    /// The Durable Object ID, when exported from the Worker.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_id: Option<String>,
    pub record: Option<StoredTunnel>,
    /// The renewal alarm, Unix milliseconds.
    #[serde(default)]
    pub alarm: Option<f64>,
}

#[derive(Debug, Default, Serialize)]
pub struct ImportSummary {
    pub inserted: usize,
    pub updated: usize,
    pub unchanged: usize,
    pub kept_local: usize,
    pub skipped: usize,
    pub ids: Vec<String>,
}

/// Imports records. Rows this server changed since they were imported are kept unless `force`.
pub async fn import(store: &Store, clock: &Clock, file: ExportFile, force: bool) -> Result<ImportSummary> {
    anyhow::ensure!(file.version == 1, "unsupported export version {}", file.version);
    let mut summary = ImportSummary::default();
    for entry in file.records {
        let Some(record) = entry.record else {
            summary.skipped += 1;
            continue;
        };
        if record.id.is_empty() || record.token_hash.is_empty() || record.hostname.is_empty() {
            summary.skipped += 1;
            continue;
        }
        let alarm = entry.alarm.filter(|alarm| *alarm > 0.0).map(|alarm| alarm as u64);
        let id = record.id.clone();
        match store.import_tunnel(record, alarm, force, clock.now_ms()).await? {
            ImportOutcome::Inserted => summary.inserted += 1,
            ImportOutcome::Updated => summary.updated += 1,
            ImportOutcome::Unchanged => summary.unchanged += 1,
            ImportOutcome::KeptLocal => summary.kept_local += 1,
        }
        summary.ids.push(id);
    }
    Ok(summary)
}

pub async fn export(store: &Store, clock: &Clock) -> Result<ExportFile> {
    Ok(ExportFile {
        version: 1,
        exported_at: Some(clock.iso()),
        records: store
            .export_tunnels()
            .await?
            .into_iter()
            .map(|(record, alarm)| ExportedRecord {
                object_id: None,
                record: Some(record),
                alarm: alarm.map(|alarm| alarm as f64),
            })
            .collect(),
    })
}

#[derive(Clone)]
pub struct Legacy {
    /// The Worker's base URL, on workers.dev once opentunnel.xyz points here.
    pub worker_url: String,
    pub relay_token: Option<String>,
    pub export_token: Option<String>,
}

/// TEMPORARY: hands public connections nothing here serves to the Worker's `/api/relay`.
pub struct LegacyFallback {
    pub legacy: Legacy,
    pub stats: Arc<Stats>,
}

impl Fallback for LegacyFallback {
    fn forward(&self, accepted: Accepted) -> Option<Accepted> {
        let token = self.legacy.relay_token.clone()?;
        let mut url = url::Url::parse(&self.legacy.worker_url).ok()?;
        let scheme = if url.scheme() == "http" { "ws" } else { "wss" };
        url.set_scheme(scheme).ok()?;
        url.set_path("/api/relay");
        url.query_pairs_mut().clear().append_pair("token", &token);
        count(&self.stats.legacy_forwarded);
        tokio::spawn(async move {
            if let Err(error) = relay(url.to_string(), accepted).await {
                debug!(%error, "legacy relay connection ended");
            }
        });
        None
    }
}

/// The AWS relay's protocol: binary messages carry bytes each way and `{"type":"end"}` half-closes.
async fn relay(url: String, accepted: Accepted) -> Result<()> {
    let (socket, _) = tokio::time::timeout(
        Duration::from_secs(10),
        tokio_tungstenite::connect_async(url.as_str()),
    )
    .await
    .context("connecting to the legacy relay timed out")??;
    let (mut sink, mut stream) = socket.split();
    let Accepted {
        stream: mut tcp,
        initial,
        ..
    } = accepted;
    sink.send(Message::Binary(initial.into())).await?;
    let (mut read, mut write) = tcp.split();
    let upload = async {
        let mut buffer = vec![0u8; 32 * 1024];
        loop {
            let read = read.read(&mut buffer).await?;
            if read == 0 {
                sink.send(Message::text(r#"{"type":"end"}"#)).await?;
                return anyhow::Ok(());
            }
            sink.send(Message::Binary(buffer[..read].to_vec().into()))
                .await?;
        }
    };
    let download = async {
        while let Some(message) = stream.next().await {
            match message? {
                Message::Binary(data) => write.write_all(&data).await?,
                Message::Text(text) if text.as_str().contains("\"end\"") => {
                    write.shutdown().await?;
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        anyhow::Ok(())
    };
    // The relay closes the WebSocket when the Worker is done, which ends both directions.
    tokio::pin!(upload, download);
    let mut uploaded = false;
    loop {
        tokio::select! {
            result = &mut upload, if !uploaded => {
                result?;
                uploaded = true;
            }
            result = &mut download => return result,
        }
    }
}

/// TEMPORARY: imports tunnels this server has not seen from the Worker's export endpoint.
pub struct PullThrough {
    legacy: Legacy,
    http: reqwest::Client,
    store: Store,
    clock: Clock,
    misses: Mutex<HashMap<String, Instant>>,
}

const MISS_TTL: Duration = Duration::from_secs(60);

#[derive(Deserialize)]
struct ExportResponse {
    records: Vec<ExportedRecord>,
}

impl PullThrough {
    pub fn new(legacy: Legacy, http: reqwest::Client, store: Store, clock: Clock) -> Self {
        Self {
            legacy,
            http,
            store,
            clock,
            misses: Mutex::new(HashMap::new()),
        }
    }

    /// Fetches and imports one tunnel. Returns whether the Worker had it.
    pub async fn fetch(&self, id: &str) -> bool {
        // Tunnel IDs are 12 base32 characters; nothing else is worth asking about.
        if id.len() != 12 || !id.bytes().all(|byte| byte.is_ascii_lowercase() || (b'2'..=b'7').contains(&byte)) {
            return false;
        }
        let Some(token) = &self.legacy.export_token else {
            return false;
        };
        {
            let mut misses = self.misses.lock().expect("misses lock");
            misses.retain(|_, at| at.elapsed() < MISS_TTL);
            if misses.contains_key(id) {
                return false;
            }
        }
        let url = format!(
            "{}/api/admin/export",
            self.legacy.worker_url.trim_end_matches('/')
        );
        let response = self
            .http
            .post(url)
            .bearer_auth(token)
            .timeout(Duration::from_secs(5))
            .json(&serde_json::json!({ "names": [id] }))
            .send()
            .await;
        let records = match response {
            Ok(response) if response.status().is_success() => {
                match response.json::<ExportResponse>().await {
                    Ok(body) => body.records,
                    Err(error) => {
                        warn!(%error, "legacy export returned an unreadable body");
                        return false;
                    }
                }
            }
            Ok(response) => {
                warn!(status = %response.status(), "legacy export failed");
                return false;
            }
            Err(error) => {
                warn!(%error, "legacy export failed");
                return false;
            }
        };
        let found = records
            .iter()
            .any(|entry| entry.record.as_ref().is_some_and(|record| record.id == id));
        if !found {
            self.misses
                .lock()
                .expect("misses lock")
                .insert(id.to_owned(), Instant::now());
            return false;
        }
        match import(
            &self.store,
            &self.clock,
            ExportFile {
                version: 1,
                exported_at: None,
                records,
            },
            false,
        )
        .await
        {
            Ok(_) => {
                info!(tunnel = id, "imported a tunnel from the Worker on first use");
                true
            }
            Err(error) => {
                warn!(%error, tunnel = id, "importing a tunnel from the Worker failed");
                false
            }
        }
    }
}

pub type SharedPullThrough = Arc<PullThrough>;
