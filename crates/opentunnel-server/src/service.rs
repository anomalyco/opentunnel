//! Tunnels: what the Worker's per-tunnel Durable Object did. Each tunnel has an entry whose async lock
//! serializes its record changes, as the Durable Object's single thread did, and which holds its live bridges.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::Result;
use bytes::Bytes;
use opentunnel::protocol::api::{CertificateInfo, CertificateState, TunnelState};
use opentunnel::protocol::bridge::{HEARTBEAT_MS, IDLE_TIMEOUT_MS};
use serde_json::json;
use tokio::sync::{Notify, mpsc, watch};
use tokio_util::sync::CancellationToken;
use tracing::{error, warn};

use crate::analytics::{self, Analytics, ClientInfo};
use crate::clock::{Clock, DAY_MS, HOUR_MS, MINUTE_MS, iso, parse_iso};
use crate::crypto::{token_matches, uuid};
use crate::record::{Renewal, StoredTunnel, TunnelView};
use crate::store::{Conflict, Job, JobKind, Store};

/// Renew this long before the current certificate expires.
pub const RENEW_BEFORE_MS: u64 = 30 * DAY_MS;
/// Tunnels with no connection in this window are not renewed and expire.
pub const ACTIVE_WINDOW_MS: u64 = 90 * DAY_MS;
pub const RENEWAL_RETRY_MS: u64 = HOUR_MS;
/// A renewal still running after this long is treated as lost and restarted.
pub const RENEWAL_STALE_MS: u64 = DAY_MS;
/// Issuance without a job is resumed only when it started less than this long ago.
pub const ORPHAN_MAX_AGE_MS: u64 = 2 * DAY_MS;
/// A bridge silent for this long is gone: its client pings every heartbeat and gives up after the idle timeout.
pub const STALE_BRIDGE_MS: u64 = IDLE_TIMEOUT_MS + HEARTBEAT_MS;

#[derive(Clone)]
pub struct Service(Arc<Inner>);

pub struct Inner {
    pub domain: String,
    pub store: Store,
    pub clock: Clock,
    pub analytics: Analytics,
    /// Wakes the job runner when a job is added.
    pub jobs: Arc<Notify>,
    /// Wakes the alarm loop when an alarm is set.
    pub alarms: Arc<Notify>,
    tunnels: Mutex<HashMap<String, Arc<Entry>>>,
    next_bridge: AtomicU64,
    /// TEMPORARY (migration): imports tunnels this server has not seen from the Worker.
    pull_through: std::sync::OnceLock<crate::migration::SharedPullThrough>,
}

impl std::ops::Deref for Service {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}

pub struct Entry {
    pub id: String,
    state: tokio::sync::Mutex<EntryState>,
}

#[derive(Default)]
pub struct EntryState {
    loaded: bool,
    record: Option<StoredTunnel>,
    /// The stored row's revision when `record` was read or written; 0 when there is no row.
    revision: u64,
    bridges: Vec<Arc<Bridge>>,
    sequence: u32,
}

impl EntryState {
    pub fn record(&self) -> Option<&StoredTunnel> {
        self.record.as_ref().filter(|record| !record.is_deleted())
    }

    fn attached(&self) -> impl Iterator<Item = &Arc<Bridge>> {
        self.bridges.iter().filter(|bridge| bridge.is_attached())
    }
}

/// A message for a bridge's WebSocket writer.
#[derive(Debug)]
pub enum Outbound {
    Text(String),
    Binary(Bytes),
    Close(u16, String),
}

pub struct Bridge {
    pub id: u64,
    pub tx: mpsc::Sender<Outbound>,
    /// Ends the session, for retired and replaced bridges.
    pub cancel: CancellationToken,
    pub client: ClientInfo,
    /// Server time this bridge last sent anything, Unix ms.
    pub seen_at: AtomicU64,
    pub state: Mutex<BridgeState>,
    pub channels: Mutex<HashMap<u32, ChannelHandle>>,
}

#[derive(Default, Clone)]
pub struct BridgeState {
    pub attached: bool,
    /// Retired for silence or closed by the server; already accounted for.
    pub detached: bool,
    pub session: Option<String>,
    pub routes: Vec<String>,
    pub max_conns: Option<u64>,
    pub attached_at: u64,
    pub active_at: u64,
    /// The close the server sent, reported if the client never answers it.
    pub server_close: Option<u16>,
}

impl Bridge {
    pub fn is_attached(&self) -> bool {
        let state = self.state.lock().expect("bridge lock");
        state.attached && !state.detached
    }

    pub fn snapshot(&self) -> BridgeState {
        self.state.lock().expect("bridge lock").clone()
    }

    pub fn claims(&self, route: &str) -> bool {
        let state = self.state.lock().expect("bridge lock");
        state.attached && !state.detached && state.routes.iter().any(|claimed| claimed == route)
    }

    pub fn is_closing(&self) -> bool {
        self.state
            .lock()
            .expect("bridge lock")
            .server_close
            .is_some()
    }

    pub fn touch(&self, now: u64) {
        self.seen_at.store(now, Ordering::Relaxed);
    }

    /// Queues a close and ends the session after a grace period if the client never answers it.
    pub fn close(&self, code: u16, reason: &str) {
        self.state.lock().expect("bridge lock").server_close = Some(code);
        let _ = self.tx.try_send(Outbound::Close(code, reason.into()));
        let cancel = self.cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            cancel.cancel();
        });
    }

    /// Ends every public connection on this bridge.
    pub fn finish_channels(&self, outcome: Outcome) {
        let channels: Vec<ChannelHandle> = self
            .channels
            .lock()
            .expect("channels lock")
            .drain()
            .map(|(_, channel)| channel)
            .collect();
        for channel in channels {
            channel.finish.finish(outcome, true);
        }
    }

    pub fn open_channels(&self) -> usize {
        self.channels.lock().expect("channels lock").len()
    }
}

/// Data from a tunnel client for one public connection.
#[derive(Debug)]
pub enum Inbound {
    Data(Bytes),
    End,
}

#[derive(Clone)]
pub struct ChannelHandle {
    pub inbound: mpsc::Sender<Inbound>,
    pub finish: Arc<Finish>,
    pub bytes_out: Arc<AtomicU64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Closed,
    Reset,
    BridgeDisconnected,
    Deleted,
    Backpressure,
    ClientError,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Closed => "closed",
            Self::Reset => "reset",
            Self::BridgeDisconnected => "bridge_disconnected",
            Self::Deleted => "deleted",
            Self::Backpressure => "backpressure",
            Self::ClientError => "client_error",
        }
    }
}

/// How a public connection ended: set once, first writer wins.
pub struct Finish {
    outcome: Mutex<Option<Outcome>>,
    abort: watch::Sender<bool>,
}

impl Finish {
    pub fn new() -> (Arc<Self>, watch::Receiver<bool>) {
        let (abort, receiver) = watch::channel(false);
        (
            Arc::new(Self {
                outcome: Mutex::new(None),
                abort,
            }),
            receiver,
        )
    }

    /// Records the outcome unless one is set; `abort` tears the connection down now.
    pub fn finish(&self, outcome: Outcome, abort: bool) {
        let mut current = self.outcome.lock().expect("finish lock");
        if current.is_some() {
            return;
        }
        *current = Some(outcome);
        if abort {
            self.abort.send_replace(true);
        }
    }

    pub fn outcome(&self) -> Option<Outcome> {
        *self.outcome.lock().expect("finish lock")
    }
}

pub enum Lookup<T> {
    Ok(T),
    NotFound,
    Unauthorized,
}

pub enum CertificateLookup {
    Ok(CertificateInfo),
    NotFound,
    Unauthorized,
    NoCertificate,
}

pub enum Bind {
    Ok(CertificateInfo),
    NotFound,
    Unauthorized,
    InProgress,
    InvalidRequest(String),
    InvalidHostname { provided: String, expected: String },
    Unavailable(String),
}

pub enum Attach {
    Attached {
        session: String,
        routes: Vec<String>,
    },
    Error(&'static str, &'static str),
}

/// Where a public connection goes.
pub enum Route {
    Bridge {
        bridge: Arc<Bridge>,
        conn: u32,
        tunnel_id: String,
        finish: Arc<Finish>,
        abort: watch::Receiver<bool>,
        inbound: mpsc::Receiver<Inbound>,
        bytes_out: Arc<AtomicU64>,
    },
    /// Nothing serves it here; the outcome is reported if the tunnel exists.
    Rejected {
        tunnel_exists: bool,
        outcome: &'static str,
    },
}

/// Frames queued per public connection before the bridge reader waits for the visitor.
pub const INBOUND_QUEUE: usize = 64;

impl Service {
    pub fn new(domain: String, store: Store, clock: Clock, analytics: Analytics) -> Self {
        Self(Arc::new(Inner {
            domain: domain.to_ascii_lowercase(),
            store,
            clock,
            analytics,
            jobs: Arc::new(Notify::new()),
            alarms: Arc::new(Notify::new()),
            tunnels: Mutex::new(HashMap::new()),
            next_bridge: AtomicU64::new(1),
            pull_through: std::sync::OnceLock::new(),
        }))
    }

    pub fn set_pull_through(&self, pull: crate::migration::SharedPullThrough) {
        let _ = self.pull_through.set(pull);
    }

    pub fn now(&self) -> u64 {
        self.clock.now_ms()
    }

    pub fn entry(&self, id: &str) -> Arc<Entry> {
        let mut tunnels = self.tunnels.lock().expect("tunnels lock");
        tunnels
            .entry(id.to_owned())
            .or_insert_with(|| {
                Arc::new(Entry {
                    id: id.to_owned(),
                    state: tokio::sync::Mutex::new(EntryState::default()),
                })
            })
            .clone()
    }

    /// Locks a tunnel and loads its record on first use.
    pub async fn lock<'a>(
        &self,
        entry: &'a Entry,
    ) -> Result<tokio::sync::MutexGuard<'a, EntryState>> {
        let mut state = entry.state.lock().await;
        if !state.loaded {
            let mut loaded = self.store.tunnel(&entry.id).await?;
            if loaded.is_none()
                && let Some(pull) = self.pull_through.get()
                && pull.fetch(&entry.id).await
            {
                loaded = self.store.tunnel(&entry.id).await?;
            }
            (state.record, state.revision) = match loaded {
                Some(loaded) => (Some(loaded.record), loaded.revision),
                None => (None, 0),
            };
            state.loaded = true;
        }
        Ok(state)
    }

    /// Drops cached entries nobody is using and that have no bridges.
    pub fn collect_idle(&self) {
        let mut tunnels = self.tunnels.lock().expect("tunnels lock");
        tunnels.retain(|_, entry| {
            if Arc::strong_count(entry) > 1 {
                return true;
            }
            match entry.state.try_lock() {
                Ok(state) => !state.bridges.is_empty(),
                Err(_) => true,
            }
        });
    }

    /// Forgets the cached copy of a tunnel, after an import changed it underneath.
    pub async fn invalidate(&self, id: &str) {
        let entry = self.entry(id);
        let mut state = entry.state.lock().await;
        state.loaded = false;
        state.record = None;
        state.revision = 0;
    }

    pub fn entries(&self) -> Vec<Arc<Entry>> {
        self.tunnels
            .lock()
            .expect("tunnels lock")
            .values()
            .cloned()
            .collect()
    }

    /// Writes the record if the stored row is still the one this entry read. When another writer (an import,
    /// another server) changed it, the entry reloads on next use and the operation fails with `Conflict`.
    async fn save(&self, state: &mut EntryState, record: StoredTunnel) -> Result<()> {
        match self
            .store
            .save_tunnel(&record, state.revision, self.now())
            .await
        {
            Ok(revision) => {
                state.revision = revision;
                state.record = Some(record);
                Ok(())
            }
            Err(error) => {
                if error.is::<Conflict>() {
                    state.loaded = false;
                    state.record = None;
                    state.revision = 0;
                }
                Err(error)
            }
        }
    }

    fn view(&self, state: &EntryState, record: &StoredTunnel) -> TunnelView {
        TunnelView {
            id: record.id.clone(),
            hostname: record.hostname.clone(),
            // Live bridges are the truth; the stored state can be stale after a restart or an import.
            state: if state.attached().next().is_some() {
                TunnelState::Online
            } else {
                TunnelState::Offline
            },
            certificate_id: record.certificate_id.clone(),
        }
    }

    // --- API ---------------------------------------------------------------------------------------------

    /// Creates a tunnel unless the ID is taken by a live one.
    pub async fn create(&self, id: &str, token_hash: String) -> Result<Option<TunnelView>> {
        let entry = self.entry(id);
        let mut state = self.lock(&entry).await?;
        if state.record().is_some() {
            return Ok(None);
        }
        let record = StoredTunnel {
            version: 1,
            id: id.into(),
            hostname: format!("{id}.{}", self.domain),
            state: TunnelState::Offline,
            certificate_id: None,
            token_hash,
            created_at: self.clock.iso(),
            deleted_at: None,
            certificate: None,
            certificate_csr: None,
            certificate_identifiers: None,
            certificate_started_at: None,
            last_connected_at: None,
            renewal: None,
        };
        self.save(&mut state, record.clone()).await?;
        // A recreated ID must not inherit the deleted tunnel's alarm.
        self.store.set_alarm(id, None).await?;
        Ok(Some(self.view(&state, &record)))
    }

    pub async fn info(&self, id: &str, token: &str) -> Result<Lookup<TunnelView>> {
        let entry = self.entry(id);
        let state = self.lock(&entry).await?;
        let Some(record) = state.record() else {
            return Ok(Lookup::NotFound);
        };
        if !token_matches(token, &record.token_hash) {
            return Ok(Lookup::Unauthorized);
        }
        Ok(Lookup::Ok(self.view(&state, record)))
    }

    pub async fn certificate(&self, id: &str, token: &str) -> Result<CertificateLookup> {
        let entry = self.entry(id);
        let state = self.lock(&entry).await?;
        let Some(record) = state.record() else {
            return Ok(CertificateLookup::NotFound);
        };
        if !token_matches(token, &record.token_hash) {
            return Ok(CertificateLookup::Unauthorized);
        }
        Ok(match &record.certificate {
            Some(certificate) => CertificateLookup::Ok(certificate.clone()),
            None => CertificateLookup::NoCertificate,
        })
    }

    pub async fn bind_certificate(&self, id: &str, token: &str, csr: &str) -> Result<Bind> {
        let entry = self.entry(id);
        let mut state = self.lock(&entry).await?;
        let Some(record) = state.record().cloned() else {
            return Ok(Bind::NotFound);
        };
        if !token_matches(token, &record.token_hash) {
            return Ok(Bind::Unauthorized);
        }
        let Some(request) = crate::csr::parse(csr) else {
            return Ok(Bind::InvalidRequest("Failed to parse CSR".into()));
        };
        if request.hostname != record.hostname {
            return Ok(Bind::InvalidHostname {
                provided: request.hostname,
                expected: record.hostname,
            });
        }
        let wildcard = format!("*.{}", record.hostname);
        if request
            .identifiers
            .iter()
            .any(|identifier| *identifier != record.hostname && *identifier != wildcard)
        {
            return Ok(Bind::InvalidHostname {
                provided: request.identifiers.join(","),
                expected: format!("{},{wildcard}", record.hostname),
            });
        }
        if let Some(certificate) = &record.certificate
            && record.certificate_csr.as_deref() == Some(csr)
        {
            // A resumed provision: make sure the issuance it is waiting for exists.
            if let Err(error) = self.ensure_issuance(&record, JobKind::Issue).await {
                return Ok(Bind::Unavailable(error.to_string()));
            }
            return Ok(Bind::Ok(certificate.clone()));
        }
        if let Some(certificate) = &record.certificate
            && !matches!(
                certificate.state,
                CertificateState::Ready { .. } | CertificateState::Failed { .. }
            )
        {
            return Ok(Bind::InProgress);
        }

        let certificate_id = format!("cert_{}", uuid());
        let certificate = CertificateInfo {
            id: certificate_id.clone(),
            state: CertificateState::Issuing,
        };
        let issuing = StoredTunnel {
            certificate_id: Some(certificate_id.clone()),
            certificate: Some(certificate.clone()),
            certificate_csr: Some(csr.into()),
            certificate_identifiers: Some(request.identifiers),
            certificate_started_at: Some(self.clock.iso()),
            renewal: None,
            ..record.clone()
        };
        self.save(&mut state, issuing.clone()).await?;
        if let Err(error) = self.ensure_issuance(&issuing, JobKind::Issue).await {
            let reason = error.to_string();
            self.analytics.publish(
                "certificate.failed",
                json!({ "tunnel_id": record.id, "certificate_id": certificate_id, "renewal": false, "reason": "workflow_start" }),
            );
            let failed = StoredTunnel {
                certificate: Some(CertificateInfo {
                    id: certificate_id,
                    state: CertificateState::Failed {
                        reason: reason.clone(),
                    },
                }),
                ..issuing
            };
            self.save(&mut state, failed).await?;
            return Ok(Bind::Unavailable(reason));
        }
        Ok(Bind::Ok(certificate))
    }

    pub async fn remove(&self, id: &str, token: &str) -> Result<Lookup<()>> {
        let entry = self.entry(id);
        let mut state = self.lock(&entry).await?;
        let Some(record) = state.record().cloned() else {
            return Ok(Lookup::NotFound);
        };
        if !token_matches(token, &record.token_hash) {
            return Ok(Lookup::Unauthorized);
        }
        for bridge in &state.bridges {
            bridge.finish_channels(Outcome::Deleted);
            bridge.close(1000, "deleted");
        }
        let now = self.now();
        let deleted = StoredTunnel {
            state: TunnelState::Offline,
            deleted_at: Some(iso(now)),
            ..record.clone()
        };
        self.save(&mut state, deleted).await?;
        self.store.set_alarm(id, None).await?;
        let age = parse_iso(&record.created_at).map_or(0, |created| now.saturating_sub(created));
        self.analytics.publish(
            "tunnel.deleted",
            json!({ "tunnel_id": record.id, "age_ms": age }),
        );
        Ok(Lookup::Ok(()))
    }

    // --- Certificates --------------------------------------------------------------------------------------

    /// Adds the issuance job for the record's current certificate (or its renewal) unless it exists, the way
    /// the Worker created a Workflow instance named after the certificate ID unless one existed.
    async fn ensure_issuance(&self, record: &StoredTunnel, kind: JobKind) -> Result<()> {
        let (certificate_id, csr) = match kind {
            JobKind::Renew => (
                record
                    .renewal
                    .as_ref()
                    .map(|renewal| renewal.certificate_id.clone()),
                record.certificate_csr.clone(),
            ),
            _ => (
                record.certificate_id.clone(),
                record.certificate_csr.clone(),
            ),
        };
        let certificate_id =
            certificate_id.ok_or_else(|| anyhow::anyhow!("Certificate ID is missing"))?;
        let csr = csr.ok_or_else(|| anyhow::anyhow!("Certificate CSR is missing"))?;
        let added = self
            .store
            .add_job(
                Job {
                    certificate_id,
                    tunnel_id: Some(record.id.clone()),
                    kind,
                    identifiers: record.identifiers(),
                    csr,
                    attempts: 0,
                    created_at: self.now(),
                },
                self.now(),
            )
            .await?;
        if added {
            self.jobs.notify_one();
        }
        Ok(())
    }

    /// Records progress of an issuance. Returns false when the tunnel or certificate no longer matches, as the
    /// Durable Object's `updateCertificate` did.
    pub async fn update_certificate(
        &self,
        tunnel_id: &str,
        certificate_id: &str,
        input: CertificateState,
    ) -> Result<bool> {
        let entry = self.entry(tunnel_id);
        let mut state = self.lock(&entry).await?;
        let Some(record) = state.record().cloned() else {
            return Ok(false);
        };
        let now = self.now();
        if let Some(renewal) = &record.renewal
            && renewal.certificate_id == certificate_id
        {
            let duration =
                parse_iso(&renewal.started_at).map_or(0, |started| now.saturating_sub(started));
            match &input {
                CertificateState::Ready { .. } => {
                    let renewed = StoredTunnel {
                        certificate_id: Some(renewal.certificate_id.clone()),
                        certificate: Some(CertificateInfo {
                            id: renewal.certificate_id.clone(),
                            state: input.clone(),
                        }),
                        renewal: None,
                        ..record.clone()
                    };
                    self.save(&mut state, renewed.clone()).await?;
                    self.schedule_renewal(&renewed).await?;
                    self.analytics.publish(
                        "certificate.renewed",
                        json!({ "tunnel_id": record.id, "certificate_id": certificate_id, "duration_ms": duration }),
                    );
                }
                CertificateState::Failed { reason } => {
                    error!(tunnel = %record.id, %reason, "certificate renewal failed");
                    self.analytics.publish(
                        "certificate.failed",
                        json!({
                            "tunnel_id": record.id,
                            "certificate_id": certificate_id,
                            "renewal": true,
                            "reason": analytics::certificate_failure(reason),
                            "duration_ms": duration,
                        }),
                    );
                    let cleared = StoredTunnel {
                        renewal: None,
                        ..record.clone()
                    };
                    self.save(&mut state, cleared).await?;
                    self.set_alarm(tunnel_id, Some(now + RENEWAL_RETRY_MS))
                        .await?;
                }
                _ => {}
            }
            return Ok(true);
        }
        if record.certificate_id.as_deref() != Some(certificate_id) {
            return Ok(false);
        }
        let updated = StoredTunnel {
            certificate: Some(CertificateInfo {
                id: certificate_id.into(),
                state: input.clone(),
            }),
            ..record.clone()
        };
        self.save(&mut state, updated.clone()).await?;
        self.schedule_renewal(&updated).await?;
        let previous = record
            .certificate
            .as_ref()
            .map(|certificate| &certificate.state);
        let mut payload = json!({ "tunnel_id": record.id, "certificate_id": certificate_id });
        if let Some(started) = record.certificate_started_at.as_deref().and_then(parse_iso) {
            payload["duration_ms"] = now.saturating_sub(started).into();
        }
        match &input {
            CertificateState::Ready { .. }
                if !matches!(previous, Some(CertificateState::Ready { .. })) =>
            {
                self.analytics.publish("certificate.issued", payload);
            }
            CertificateState::Failed { reason }
                if !matches!(previous, Some(CertificateState::Failed { .. })) =>
            {
                payload["renewal"] = false.into();
                payload["reason"] = analytics::certificate_failure(reason).into();
                self.analytics.publish("certificate.failed", payload);
            }
            _ => {}
        }
        Ok(true)
    }

    async fn set_alarm(&self, id: &str, at: Option<u64>) -> Result<()> {
        self.store.set_alarm(id, at).await?;
        self.alarms.notify_one();
        Ok(())
    }

    async fn schedule_renewal(&self, record: &StoredTunnel) -> Result<()> {
        if record.is_deleted() {
            return Ok(());
        }
        let Some(expiry) = record.ready_expiry().and_then(parse_iso) else {
            return Ok(());
        };
        let renew_at = expiry.saturating_sub(RENEW_BEFORE_MS);
        self.set_alarm(&record.id, Some(renew_at.max(self.now() + MINUTE_MS)))
            .await
    }

    fn is_active(&self, state: &EntryState, record: &StoredTunnel) -> bool {
        if state.attached().next().is_some() {
            return true;
        }
        record
            .last_connected_at
            .as_deref()
            .and_then(parse_iso)
            .is_some_and(|connected| self.now().saturating_sub(connected) < ACTIVE_WINDOW_MS)
    }

    /// The renewal alarm: renews the certificate of active tunnels shortly before it expires.
    pub async fn alarm(&self, id: &str) -> Result<()> {
        let entry = self.entry(id);
        let mut state = self.lock(&entry).await?;
        let Some(record) = state.record().cloned() else {
            return Ok(());
        };
        let Some(expiry) = record.ready_expiry().and_then(parse_iso) else {
            return Ok(());
        };
        let now = self.now();
        if let Some(renewal) = &record.renewal
            && parse_iso(&renewal.started_at)
                .is_some_and(|started| now.saturating_sub(started) < RENEWAL_STALE_MS)
        {
            return Ok(());
        }
        if expiry.saturating_sub(RENEW_BEFORE_MS) > now {
            return self.schedule_renewal(&record).await;
        }
        if !self.is_active(&state, &record) {
            return Ok(());
        }
        self.start_renewal(&mut state, record).await
    }

    /// Issues a new certificate from the stored CSR; the current one serves until it is ready.
    async fn start_renewal(&self, state: &mut EntryState, record: StoredTunnel) -> Result<()> {
        if record.certificate_csr.is_none() {
            return Ok(());
        }
        let certificate_id = format!("cert_{}", uuid());
        let renewing = StoredTunnel {
            renewal: Some(Renewal {
                certificate_id: certificate_id.clone(),
                started_at: self.clock.iso(),
            }),
            ..record.clone()
        };
        self.save(state, renewing.clone()).await?;
        if let Err(error) = self.ensure_issuance(&renewing, JobKind::Renew).await {
            warn!(tunnel = %record.id, %error, "failed to start certificate renewal");
            self.analytics.publish(
                "certificate.failed",
                json!({ "tunnel_id": record.id, "certificate_id": certificate_id, "renewal": true, "reason": "workflow_start" }),
            );
            self.save(state, record.clone()).await?;
            self.set_alarm(&record.id, Some(self.now() + RENEWAL_RETRY_MS))
                .await?;
        }
        Ok(())
    }

    /// Renews on connect when the certificate is close to or past expiry, which covers tunnels that went idle
    /// and come back, and schedules the renewal alarm for tunnels that have none.
    async fn on_attached(&self, state: &mut EntryState, record: StoredTunnel) -> Result<()> {
        let Some(expiry) = record.ready_expiry().and_then(parse_iso) else {
            return Ok(());
        };
        let now = self.now();
        let stale = record.renewal.as_ref().is_some_and(|renewal| {
            parse_iso(&renewal.started_at)
                .is_none_or(|started| now.saturating_sub(started) >= RENEWAL_STALE_MS)
        });
        if (record.renewal.is_none() || stale) && expiry.saturating_sub(RENEW_BEFORE_MS) <= now {
            self.start_renewal(state, record).await
        } else if self.store.alarm(&record.id).await?.is_none() {
            self.schedule_renewal(&record).await
        } else {
            Ok(())
        }
    }

    /// Resumes issuance that has no job: records imported mid-issuance from the Worker, whose Workflow
    /// instances stayed behind. Only issuance older than `grace_ms` is resumed, so the Worker can finish first.
    pub async fn resume_orphaned_issuance(&self, grace_ms: u64) -> Result<usize> {
        let now = self.now();
        let mut resumed = 0;
        for candidate in self.store.issuing_tunnels().await? {
            let entry = self.entry(&candidate.id);
            let state = self.lock(&entry).await?;
            let Some(record) = state.record().cloned() else {
                continue;
            };
            // Older issuance was abandoned (a client resuming it binds again, which adds the job), so it is
            // not worth an ACME order each.
            let old = |started: Option<&str>| {
                started.and_then(parse_iso).is_some_and(|started| {
                    let age = now.saturating_sub(started);
                    age >= grace_ms && age < ORPHAN_MAX_AGE_MS
                })
            };
            let issuing = record.certificate.as_ref().is_some_and(|certificate| {
                matches!(
                    certificate.state,
                    CertificateState::Issuing | CertificateState::Challenge { .. }
                )
            });
            if issuing
                && old(record.certificate_started_at.as_deref())
                && let Some(id) = &record.certificate_id
                && !self.store.job_exists(id).await?
            {
                self.ensure_issuance(&record, JobKind::Issue).await?;
                resumed += 1;
            }
            if let Some(renewal) = &record.renewal
                && old(Some(&renewal.started_at))
                && !self.store.job_exists(&renewal.certificate_id).await?
            {
                self.ensure_issuance(&record, JobKind::Renew).await?;
                resumed += 1;
            }
        }
        Ok(resumed)
    }

    // --- Bridges -----------------------------------------------------------------------------------------

    /// Whether the tunnel exists, for the WebSocket upgrade.
    pub async fn exists(&self, id: &str) -> Result<bool> {
        let entry = self.entry(id);
        let state = self.lock(&entry).await?;
        Ok(state.record().is_some())
    }

    /// Registers a bridge that has not attached yet.
    pub async fn register_bridge(
        &self,
        id: &str,
        tx: mpsc::Sender<Outbound>,
        client: ClientInfo,
    ) -> Result<Option<Arc<Bridge>>> {
        let entry = self.entry(id);
        let mut state = self.lock(&entry).await?;
        if state.record().is_none() {
            return Ok(None);
        }
        let bridge = Arc::new(Bridge {
            id: self.next_bridge.fetch_add(1, Ordering::Relaxed),
            tx,
            cancel: CancellationToken::new(),
            client,
            seen_at: AtomicU64::new(self.now()),
            state: Mutex::new(BridgeState::default()),
            channels: Mutex::new(HashMap::new()),
        });
        state.bridges.push(bridge.clone());
        Ok(Some(bridge))
    }

    /// Handles `attach` for a registered bridge.
    pub async fn attach(
        &self,
        id: &str,
        bridge: &Arc<Bridge>,
        token: &str,
        routes: Vec<String>,
        max_conns: Option<u64>,
    ) -> Result<Attach> {
        let entry = self.entry(id);
        let mut state = self.lock(&entry).await?;
        let Some(record) = state.record().cloned() else {
            return Ok(Attach::Error("bad_token", "bad token"));
        };
        if !token_matches(token, &record.token_hash) {
            return Ok(Attach::Error("bad_token", "bad token"));
        }
        if !record.certificate_ready() {
            return Ok(Attach::Error("cert_not_ready", "certificate not ready"));
        }
        if routes.is_empty()
            || routes
                .iter()
                .any(|route| !opentunnel::protocol::names::is_valid_route(route))
        {
            return Ok(Attach::Error("invalid_route", "invalid route"));
        }
        self.retire_stale(&mut state).await?;
        let conflict = state.bridges.iter().any(|candidate| {
            candidate.id != bridge.id && routes.iter().any(|route| candidate.claims(route))
        });
        if conflict {
            return Ok(Attach::Error("route_conflict", "route conflict"));
        }
        let now = self.now();
        let session = format!("sess_{}", uuid());
        {
            let mut bridge_state = bridge.state.lock().expect("bridge lock");
            bridge_state.attached = true;
            bridge_state.session = Some(session.clone());
            bridge_state.routes = routes.clone();
            bridge_state.max_conns = max_conns;
            bridge_state.attached_at = now;
            bridge_state.active_at = now;
        }
        bridge.touch(now);
        let connected = StoredTunnel {
            state: TunnelState::Online,
            last_connected_at: Some(iso(now)),
            ..record.clone()
        };
        // Bridges keep working while storage is briefly unavailable: the connection is still accepted, and the
        // renewal check runs again on the next attach or alarm.
        match self.save(&mut state, connected.clone()).await {
            Ok(()) => {
                if let Err(error) = self.on_attached(&mut state, connected).await {
                    warn!(tunnel = %record.id, error = %format!("{error:#}"), "renewal check on attach failed");
                }
            }
            Err(error) => {
                warn!(tunnel = %record.id, error = %format!("{error:#}"), "could not record the connection");
            }
        }
        let mut connected_payload = json!({
            "tunnel_id": record.id,
            "session_id": session,
            "route_count": routes.len(),
        });
        for (key, value) in bridge.client.fields() {
            connected_payload[key] = value;
        }
        self.analytics
            .publish("bridge.connected", connected_payload);
        self.analytics.publish(
            "tunnel.active",
            json!({
                "tunnel_id": record.id,
                "session_id": session,
                "route_count": routes.len(),
                "connected_ms": 0,
                "open_connections": 0,
            }),
        );
        Ok(Attach::Attached { session, routes })
    }

    /// Reports `tunnel.active` at most once per interval per bridge, piggybacking on the client's pings.
    pub fn report_active(&self, id: &str, bridge: &Bridge) {
        let now = self.now();
        let snapshot = {
            let mut state = bridge.state.lock().expect("bridge lock");
            if !state.attached
                || now.saturating_sub(state.active_at) < analytics::ACTIVE_INTERVAL_MS
            {
                return;
            }
            state.active_at = now;
            state.clone()
        };
        self.analytics.publish(
            "tunnel.active",
            json!({
                "tunnel_id": id,
                "session_id": snapshot.session,
                "route_count": snapshot.routes.len(),
                "connected_ms": now.saturating_sub(snapshot.attached_at),
                "open_connections": bridge.open_channels(),
            }),
        );
    }

    fn publish_disconnected(&self, id: &str, bridge: &BridgeState, code: u16, clean: bool) {
        let Some(session) = &bridge.session else {
            return;
        };
        self.analytics.publish(
            "bridge.disconnected",
            json!({
                "tunnel_id": id,
                "session_id": session,
                "route_count": bridge.routes.len(),
                "duration_ms": self.now().saturating_sub(bridge.attached_at),
                "code": code,
                "clean": clean,
            }),
        );
    }

    /// Cleans up after a bridge's socket closed.
    pub async fn bridge_closed(
        &self,
        id: &str,
        bridge: &Arc<Bridge>,
        code: u16,
        clean: bool,
    ) -> Result<()> {
        let entry = self.entry(id);
        let mut state = self.lock(&entry).await?;
        state.bridges.retain(|candidate| candidate.id != bridge.id);
        let snapshot = bridge.snapshot();
        // Bridges that never attached have nothing to clean up; retired ones were cleaned up when retired.
        if !snapshot.attached || snapshot.detached {
            return Ok(());
        }
        bridge.state.lock().expect("bridge lock").detached = true;
        bridge.finish_channels(Outcome::BridgeDisconnected);
        self.publish_disconnected(id, &snapshot, code, clean);
        if state.attached().next().is_none()
            && let Some(record) = state.record().cloned()
        {
            self.save(
                &mut state,
                StoredTunnel {
                    state: TunnelState::Offline,
                    ..record
                },
            )
            .await?;
        }
        Ok(())
    }

    /// Retires attached bridges whose client is gone. A client that vanishes without a close (sleep, a network
    /// change) leaves its socket open until TCP notices, which can take very long. Until then the bridge would
    /// keep its routes, so the client's reconnects get `route_conflict`, and it would swallow every public
    /// connection routed to it.
    async fn retire_stale(&self, state: &mut EntryState) -> Result<()> {
        let now = self.now();
        let mut retired = false;
        let id = state.record.as_ref().map(|record| record.id.clone());
        for bridge in state.bridges.clone() {
            if !bridge.is_attached() {
                continue;
            }
            let seen = bridge.seen_at.load(Ordering::Relaxed);
            if now.saturating_sub(seen) <= STALE_BRIDGE_MS {
                continue;
            }
            let snapshot = {
                let mut bridge_state = bridge.state.lock().expect("bridge lock");
                bridge_state.detached = true;
                bridge_state.clone()
            };
            bridge.finish_channels(Outcome::BridgeDisconnected);
            bridge.close(1001, "idle timeout");
            if let Some(id) = &id {
                self.publish_disconnected(id, &snapshot, 1001, false);
            }
            retired = true;
        }
        if retired
            && state.attached().next().is_none()
            && let Some(record) = state.record().cloned()
            // The stored state is informational (the API computes it from live bridges), so routing goes on
            // when storage is unavailable.
            && let Err(error) = self
                .save(
                    state,
                    StoredTunnel {
                        state: TunnelState::Offline,
                        ..record
                    },
                )
                .await
        {
            warn!(error = %format!("{error:#}"), "could not record a retired bridge");
        }
        Ok(())
    }

    /// Retires silent bridges across all tunnels; the Durable Object only did this lazily.
    pub async fn sweep(&self) -> Result<()> {
        for entry in self.entries() {
            let mut state = entry.state.lock().await;
            if state.bridges.is_empty() {
                continue;
            }
            self.retire_stale(&mut state).await?;
        }
        self.collect_idle();
        Ok(())
    }

    /// Picks the bridge for a public connection and registers the connection on it.
    pub async fn route(&self, id: &str, sni: &str) -> Result<Route> {
        let entry = self.entry(id);
        let mut state = self.lock(&entry).await?;
        let Some(record) = state.record().cloned() else {
            return Ok(Route::Rejected {
                tunnel_exists: false,
                outcome: "no_bridge",
            });
        };
        let route = if sni == record.hostname {
            Some("@".to_owned())
        } else {
            sni.strip_suffix(&format!(".{}", record.hostname))
                .map(str::to_owned)
        };
        self.retire_stale(&mut state).await?;
        let outcome = if !record.certificate_ready() {
            "certificate_not_ready"
        } else {
            match &route {
                None => "unknown_route",
                Some(route) if route.contains('.') => "unknown_route",
                Some(_) => "no_bridge",
            }
        };
        let bridge = route.as_deref().and_then(|route| {
            state
                .bridges
                .iter()
                .find(|bridge| bridge.claims(route))
                .cloned()
        });
        let (Some(bridge), "no_bridge") = (bridge, outcome) else {
            return Ok(Route::Rejected {
                tunnel_exists: true,
                outcome,
            });
        };
        let conn = loop {
            let candidate = state.sequence;
            state.sequence = state.sequence.wrapping_add(1);
            if candidate != 0
                && !state.bridges.iter().any(|bridge| {
                    bridge
                        .channels
                        .lock()
                        .expect("channels lock")
                        .contains_key(&candidate)
                })
            {
                break candidate;
            }
        };
        let (finish, abort) = Finish::new();
        let (inbound_tx, inbound) = mpsc::channel(INBOUND_QUEUE);
        let bytes_out = Arc::new(AtomicU64::new(0));
        bridge.channels.lock().expect("channels lock").insert(
            conn,
            ChannelHandle {
                inbound: inbound_tx,
                finish: finish.clone(),
                bytes_out: bytes_out.clone(),
            },
        );
        Ok(Route::Bridge {
            bridge,
            conn,
            tunnel_id: record.id,
            finish,
            abort,
            inbound,
            bytes_out,
        })
    }

    /// Closes every bridge, for shutdown. Clients treat `drain` as a reason to reconnect.
    pub async fn drain(&self, reason: &str) {
        for entry in self.entries() {
            let state = entry.state.lock().await;
            for bridge in &state.bridges {
                let message = serde_json::to_string(&json!({ "type": "drain", "reason": reason }))
                    .expect("drain serializes");
                let _ = bridge.tx.try_send(Outbound::Text(message));
                bridge.close(1012, reason);
            }
        }
    }

    pub fn bridge_count(&self) -> usize {
        self.entries()
            .iter()
            .filter_map(|entry| {
                entry
                    .state
                    .try_lock()
                    .ok()
                    .map(|state| state.attached().count())
            })
            .sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analytics::Event;
    use crate::crypto::hash_token;
    use std::sync::atomic::AtomicU64;

    const T0: u64 = 1_800_000_000_000;

    struct Harness {
        service: Service,
        now: Arc<AtomicU64>,
        events: mpsc::Receiver<Event>,
    }

    impl Harness {
        /// `None` (the test skips) without `TEST_DATABASE_URL`.
        async fn new() -> Option<Self> {
            let store = crate::store::test_store().await?;
            let (clock, now) = Clock::manual(T0);
            let (analytics, events) = Analytics::channel(clock.clone());
            let service = Service::new("opentunnel.test".into(), store, clock, analytics);
            Some(Self {
                service,
                now,
                events,
            })
        }

        fn advance(&self, ms: u64) {
            self.now.fetch_add(ms, Ordering::SeqCst);
        }

        fn events(&mut self, kind: &str) -> Vec<serde_json::Value> {
            let mut found = Vec::new();
            while let Ok(event) = self.events.try_recv() {
                if event.kind == kind {
                    found.push(event.payload);
                }
            }
            found
        }

        async fn tunnel(&self, expiry: u64, last_connected: Option<u64>) -> StoredTunnel {
            let record = StoredTunnel {
                version: 1,
                id: "abcdefghijkl".into(),
                hostname: "abcdefghijkl.opentunnel.test".into(),
                state: TunnelState::Offline,
                certificate_id: Some("cert_1".into()),
                token_hash: hash_token("token"),
                created_at: iso(T0 - DAY_MS),
                deleted_at: None,
                certificate: Some(CertificateInfo {
                    id: "cert_1".into(),
                    state: CertificateState::Ready {
                        certificate: "CERT".into(),
                        chain: "CHAIN".into(),
                        expiry: iso(expiry),
                    },
                }),
                certificate_csr: Some("CSR".into()),
                certificate_identifiers: None,
                certificate_started_at: None,
                last_connected_at: last_connected.map(iso),
                renewal: None,
            };
            self.service.store.put_tunnel(&record, T0).await.unwrap();
            record
        }

        async fn record(&self) -> StoredTunnel {
            self.service
                .store
                .tunnel("abcdefghijkl")
                .await
                .unwrap()
                .unwrap()
                .record
        }

        async fn alarm(&self) -> Option<u64> {
            self.service.store.alarm("abcdefghijkl").await.unwrap()
        }

        async fn bridge(&self) -> (Arc<Bridge>, mpsc::Receiver<Outbound>) {
            let (tx, rx) = mpsc::channel(64);
            let bridge = self
                .service
                .register_bridge("abcdefghijkl", tx, ClientInfo::default())
                .await
                .unwrap()
                .unwrap();
            (bridge, rx)
        }

        async fn attach(
            &self,
            bridge: &Arc<Bridge>,
            routes: &[&str],
        ) -> Result<String, &'static str> {
            let routes = routes.iter().map(|route| (*route).to_owned()).collect();
            match self
                .service
                .attach("abcdefghijkl", bridge, "token", routes, Some(256))
                .await
                .unwrap()
            {
                Attach::Attached { session, .. } => Ok(session),
                Attach::Error(code, _) => Err(code),
            }
        }
    }

    fn closes(rx: &mut mpsc::Receiver<Outbound>) -> Vec<(u16, String)> {
        let mut closes = Vec::new();
        while let Ok(message) = rx.try_recv() {
            if let Outbound::Close(code, reason) = message {
                closes.push((code, reason));
            }
        }
        closes
    }

    #[tokio::test]
    async fn schedules_renewal_thirty_days_before_expiry_and_renews_active_tunnels() {
        let Some(mut harness) = Harness::new().await else {
            return;
        };
        let expiry = T0 + 60 * DAY_MS;
        harness.tunnel(expiry, Some(T0)).await;

        harness.service.alarm("abcdefghijkl").await.unwrap();
        assert_eq!(harness.alarm().await, Some(expiry - RENEW_BEFORE_MS));

        harness.advance(30 * DAY_MS);
        assert_eq!(
            crate::jobs::fire_due_alarms(&harness.service)
                .await
                .unwrap(),
            1
        );
        let renewal = harness.record().await.renewal.expect("a renewal started");
        assert!(
            harness
                .service
                .store
                .job_exists(&renewal.certificate_id)
                .await
                .unwrap()
        );
        // The current certificate keeps serving while the renewal issues.
        assert!(matches!(
            harness.service.certificate("abcdefghijkl", "token").await.unwrap(),
            CertificateLookup::Ok(CertificateInfo { id, .. }) if id == "cert_1"
        ));

        let renewed_expiry = T0 + 120 * DAY_MS;
        let ready = CertificateState::Ready {
            certificate: "NEW".into(),
            chain: "CHAIN".into(),
            expiry: iso(renewed_expiry),
        };
        assert!(
            harness
                .service
                .update_certificate("abcdefghijkl", &renewal.certificate_id, ready)
                .await
                .unwrap()
        );
        let record = harness.record().await;
        assert_eq!(
            record.certificate_id.as_deref(),
            Some(renewal.certificate_id.as_str())
        );
        assert!(record.renewal.is_none());
        assert_eq!(
            harness.alarm().await,
            Some(renewed_expiry - RENEW_BEFORE_MS)
        );
        assert_eq!(harness.events("certificate.renewed").len(), 1);
    }

    #[tokio::test]
    async fn lets_idle_tunnels_expire() {
        let Some(harness) = Harness::new().await else {
            return;
        };
        harness
            .tunnel(T0 + 10 * DAY_MS, Some(T0 - 91 * DAY_MS))
            .await;
        harness.service.alarm("abcdefghijkl").await.unwrap();
        assert!(harness.record().await.renewal.is_none());
        assert_eq!(harness.alarm().await, None);
    }

    #[tokio::test]
    async fn retries_a_failed_renewal_in_an_hour() {
        let Some(mut harness) = Harness::new().await else {
            return;
        };
        harness.tunnel(T0 + 10 * DAY_MS, Some(T0)).await;
        harness.service.alarm("abcdefghijkl").await.unwrap();
        let renewal = harness.record().await.renewal.unwrap();
        let failed = CertificateState::Failed {
            reason: "urn:ietf:params:acme:error:rateLimited: slow down | HTTP 429".into(),
        };
        harness
            .service
            .update_certificate("abcdefghijkl", &renewal.certificate_id, failed)
            .await
            .unwrap();
        let record = harness.record().await;
        assert!(record.renewal.is_none());
        assert_eq!(record.certificate_id.as_deref(), Some("cert_1"));
        assert_eq!(harness.alarm().await, Some(T0 + RENEWAL_RETRY_MS));
        let failures = harness.events("certificate.failed");
        assert_eq!(failures[0]["renewal"], true);
        assert_eq!(failures[0]["reason"], "acme_rate_limit");
    }

    #[tokio::test]
    async fn renews_on_attach_near_expiry_and_restarts_stale_renewals() {
        let Some(harness) = Harness::new().await else {
            return;
        };
        let mut record = harness.tunnel(T0 + 5 * DAY_MS, None).await;
        record.renewal = Some(Renewal {
            certificate_id: "cert_lost".into(),
            started_at: iso(T0 - 2 * DAY_MS),
        });
        harness.service.store.put_tunnel(&record, T0).await.unwrap();
        let (bridge, _rx) = harness.bridge().await;
        harness.attach(&bridge, &["api"]).await.unwrap();
        let renewal = harness.record().await.renewal.unwrap();
        assert_ne!(renewal.certificate_id, "cert_lost");
        assert!(
            harness
                .service
                .store
                .job_exists(&renewal.certificate_id)
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn schedules_an_alarm_on_attach_when_there_is_none() {
        let Some(harness) = Harness::new().await else {
            return;
        };
        harness.tunnel(T0 + 80 * DAY_MS, None).await;
        let (bridge, _rx) = harness.bridge().await;
        harness.attach(&bridge, &["@"]).await.unwrap();
        assert_eq!(harness.alarm().await, Some(T0 + 50 * DAY_MS));
        assert!(harness.record().await.last_connected_at.is_some());
    }

    #[tokio::test]
    async fn retires_silent_bridges_and_gives_their_routes_away() {
        let Some(mut harness) = Harness::new().await else {
            return;
        };
        harness.tunnel(T0 + 80 * DAY_MS, None).await;
        let (old, mut old_rx) = harness.bridge().await;
        harness.attach(&old, &["api"]).await.unwrap();

        harness.advance(STALE_BRIDGE_MS);
        let (next, _next_rx) = harness.bridge().await;
        assert_eq!(harness.attach(&next, &["api"]).await, Err("route_conflict"));
        assert!(closes(&mut old_rx).is_empty());

        harness.advance(1);
        let (next, _next_rx) = harness.bridge().await;
        harness.attach(&next, &["api"]).await.unwrap();
        assert_eq!(closes(&mut old_rx), vec![(1001, "idle timeout".to_owned())]);
        let disconnected = harness.events("bridge.disconnected");
        assert_eq!(disconnected.len(), 1);
        assert_eq!(disconnected[0]["code"], 1001);
        assert_eq!(disconnected[0]["clean"], false);

        // The socket's close arrives later; it was already accounted for.
        harness
            .service
            .bridge_closed("abcdefghijkl", &old, 1006, false)
            .await
            .unwrap();
        assert!(harness.events("bridge.disconnected").is_empty());
    }

    #[tokio::test]
    async fn routes_public_connections_only_to_live_bridges() {
        let Some(harness) = Harness::new().await else {
            return;
        };
        harness.tunnel(T0 + 80 * DAY_MS, None).await;
        let (bridge, _rx) = harness.bridge().await;
        harness.attach(&bridge, &["api", "@"]).await.unwrap();
        let host = "abcdefghijkl.opentunnel.test";
        assert!(matches!(
            harness
                .service
                .route("abcdefghijkl", &format!("api.{host}"))
                .await
                .unwrap(),
            Route::Bridge {
                conn: 0..=u32::MAX,
                ..
            }
        ));
        assert!(matches!(
            harness.service.route("abcdefghijkl", host).await.unwrap(),
            Route::Bridge { .. }
        ));
        assert!(matches!(
            harness
                .service
                .route("abcdefghijkl", &format!("web.{host}"))
                .await
                .unwrap(),
            Route::Rejected {
                outcome: "no_bridge",
                tunnel_exists: true
            }
        ));
        harness.advance(STALE_BRIDGE_MS + 1);
        assert!(matches!(
            harness
                .service
                .route("abcdefghijkl", &format!("api.{host}"))
                .await
                .unwrap(),
            Route::Rejected {
                outcome: "no_bridge",
                ..
            }
        ));
        assert_eq!(harness.record().await.state, TunnelState::Offline);
    }

    #[tokio::test]
    async fn rejects_bad_attaches() {
        let Some(harness) = Harness::new().await else {
            return;
        };
        let mut record = harness.tunnel(T0 + 80 * DAY_MS, None).await;
        let (bridge, _rx) = harness.bridge().await;
        assert_eq!(harness.attach(&bridge, &[]).await, Err("invalid_route"));
        assert_eq!(
            harness.attach(&bridge, &["a.b"]).await,
            Err("invalid_route")
        );
        assert!(matches!(
            harness
                .service
                .attach("abcdefghijkl", &bridge, "wrong", vec!["@".into()], None)
                .await
                .unwrap(),
            Attach::Error("bad_token", _)
        ));
        record.certificate = Some(CertificateInfo {
            id: "cert_1".into(),
            state: CertificateState::Issuing,
        });
        harness.service.store.put_tunnel(&record, T0).await.unwrap();
        harness.service.invalidate("abcdefghijkl").await;
        assert_eq!(harness.attach(&bridge, &["@"]).await, Err("cert_not_ready"));
    }

    #[tokio::test]
    async fn deleting_closes_bridges() {
        let Some(mut harness) = Harness::new().await else {
            return;
        };
        harness.tunnel(T0 + 80 * DAY_MS, None).await;
        let (bridge, mut rx) = harness.bridge().await;
        harness.attach(&bridge, &["api"]).await.unwrap();
        assert!(matches!(
            harness
                .service
                .remove("abcdefghijkl", "token")
                .await
                .unwrap(),
            Lookup::Ok(())
        ));
        assert_eq!(closes(&mut rx), vec![(1000, "deleted".to_owned())]);
        assert!(harness.record().await.deleted_at.is_some());
        assert_eq!(harness.events("tunnel.deleted")[0]["age_ms"], DAY_MS);
        assert!(matches!(
            harness.service.info("abcdefghijkl", "token").await.unwrap(),
            Lookup::NotFound
        ));
        // The ID can be created again.
        assert!(
            harness
                .service
                .create("abcdefghijkl", hash_token("t"))
                .await
                .unwrap()
                .is_some()
        );
    }

    #[tokio::test]
    async fn resumes_imported_issuance_after_a_grace_period() {
        let Some(harness) = Harness::new().await else {
            return;
        };
        let mut record = harness.tunnel(T0 + 80 * DAY_MS, None).await;
        record.certificate = Some(CertificateInfo {
            id: "cert_1".into(),
            state: CertificateState::Issuing,
        });
        record.certificate_started_at = Some(iso(T0 - 5 * MINUTE_MS));
        harness.service.store.put_tunnel(&record, T0).await.unwrap();
        let grace = crate::jobs::ORPHAN_GRACE_MS;
        assert_eq!(
            harness
                .service
                .resume_orphaned_issuance(grace)
                .await
                .unwrap(),
            0
        );
        harness.advance(10 * MINUTE_MS);
        assert_eq!(
            harness
                .service
                .resume_orphaned_issuance(grace)
                .await
                .unwrap(),
            1
        );
        assert!(harness.service.store.job_exists("cert_1").await.unwrap());
        assert_eq!(
            harness
                .service
                .resume_orphaned_issuance(grace)
                .await
                .unwrap(),
            0
        );

        // Abandoned long ago: left for the client to bind again.
        let mut abandoned = record.clone();
        abandoned.id = "abandonedtun".into();
        abandoned.certificate_id = Some("cert_old".into());
        abandoned.certificate_started_at = Some(iso(T0 - 3 * DAY_MS));
        harness
            .service
            .store
            .put_tunnel(&abandoned, T0)
            .await
            .unwrap();
        assert_eq!(
            harness
                .service
                .resume_orphaned_issuance(grace)
                .await
                .unwrap(),
            0
        );
    }
}
