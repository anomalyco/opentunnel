//! Tunnels: what the Worker's per-tunnel Durable Object did. Each tunnel has an entry whose async lock
//! serializes its record changes, as the Durable Object's single thread did, and which holds its live bridges.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::Result;
use bytes::Bytes;
use opentunnel::protocol::api::{CertificateInfo, CertificateState, TunnelState};
use opentunnel::protocol::bridge::{HEARTBEAT_MS, IDLE_TIMEOUT_MS};
use serde_json::json;
use tokio::sync::{Notify, Semaphore, mpsc, watch};
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use crate::analytics::{self, Analytics, ClientInfo};
use crate::clock::{Clock, DAY_MS, HOUR_MS, MINUTE_MS, iso, parse_iso};
use crate::cluster::Cluster;
use crate::crypto::{token_matches, uuid};
use crate::record::{Renewal, StoredTunnel, TunnelView};
use crate::retry;
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
/// Issuance that failed transiently is queued again only when it failed less than this long ago.
pub const RETRY_FAILED_MAX_AGE_MS: u64 = 7 * DAY_MS;
/// 2026-10-14T06:00:00Z, after attempts started deactivating authorizations left pending. First issuance queued
/// before then that ended on a pending authorization is queued once more.
pub const AUTHZ_PENDING_FIX_MS: u64 = 1_791_957_600_000;
/// A bridge silent for this long is gone: its client pings every heartbeat and gives up after the idle timeout.
pub const STALE_BRIDGE_MS: u64 = IDLE_TIMEOUT_MS + HEARTBEAT_MS;
/// After a failed refresh, cached records are used without asking the database for this long.
const REFRESH_BACKOFF_MS: u64 = 5_000;
/// Idle cached entries (no bridges) are dropped after this long, so a tunnel found missing is not read again on
/// every connection from scanners or the clients of deleted tunnels.
pub const MISSING_TTL_MS: u64 = 30_000;
/// While the mesh is not complete (a peer starting or unreachable), its events may be missed: routing then trusts "missing" for `MISSING_TTL_MS` and "certificate not ready" for this long.
const NOT_READY_TTL_MS: u64 = 5_000;
/// With every peer linked, the machine that creates or changes a tunnel tells the others at once (mesh events),
/// so cached answers need no expiry for correctness; this only bounds a bug.
pub const SAFETY_TTL_MS: u64 = 10 * MINUTE_MS;
/// How long an attach waits for the database before it fails (or goes on with a cached record), well inside the
/// client's 10 s connect timeout, so clients back off instead of reconnecting the moment they gave up.
const ATTACH_STORAGE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(4);
/// An attach uses the record (and alarm) read this recently instead of reading them again.
const ATTACH_REREAD_MS: u64 = 2_000;
/// `lastConnectedAt` is written on attach only when it is older than this (or the stored state is not online).
/// It only decides whether a tunnel counts as active for renewals (90 days), so an hour is plenty precise, and
/// reconnecting clients do not rewrite their record every time.
pub const LAST_CONNECTED_INTERVAL_MS: u64 = HOUR_MS;
/// Bridges told to reconnect per second at shutdown: about what a machine attaches in a second.
const DRAIN_RATE: usize = 5_000;
/// The longest a shutdown spreads telling bridges to reconnect, well inside `SHUTDOWN_DRAIN_MS` (10 s).
const DRAIN_SPREAD: std::time::Duration = std::time::Duration::from_secs(5);
const DRAIN_STEP: std::time::Duration = std::time::Duration::from_millis(100);
/// Attaches doing their bookkeeping (`lastConnectedAt`, the renewal check) in the database at once. In a
/// reconnect storm nearly every attach writes (bridges stay up for hours, so their `lastConnectedAt` is old), and
/// unbounded those writes took the whole pool from the reads attaches wait on. Bookkeeping may finish late.
const BOOKKEEPING_WRITES: usize = 10;

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
    /// The other machines, when this is one of many.
    cluster: std::sync::OnceLock<Arc<Cluster>>,
    /// Limits on creating tunnels and issuing certificates; none when unset (tests).
    limits: std::sync::OnceLock<Arc<crate::limits::Limits>>,
    /// When refreshing a cached record last failed, Unix ms.
    refresh_failed_at: AtomicU64,
    /// Bumped when mesh events may have been missed: routing reads cached entries of older generations again.
    generation: AtomicU64,
    /// How long tunnel connections may stay quiet.
    timeouts: std::sync::OnceLock<crate::net::Timeouts>,
    /// Set once the server is shutting down: bridges that arrive are told to reconnect elsewhere.
    draining: AtomicBool,
    /// Attach bookkeeping writing to the database at once.
    bookkeeping: tokio::sync::Semaphore,
    bridge_limits: std::sync::OnceLock<BridgeLimits>,
    /// Bytes of connection data held in memory on this machine, as permits taken from `Limits::buffered_bytes`.
    buffer: std::sync::OnceLock<Arc<Semaphore>>,
}

/// What one bridge, tunnel, or this machine may hold.
#[derive(Debug, Clone, Copy)]
pub struct BridgeLimits {
    pub conns_per_bridge: usize,
    pub conns_per_tunnel: usize,
    pub buffered_bytes: usize,
}

impl Default for BridgeLimits {
    fn default() -> Self {
        Self {
            conns_per_bridge: 256,
            conns_per_tunnel: 1024,
            buffered_bytes: 256 * 1024 * 1024,
        }
    }
}

/// Routes one tunnel's bridges on this machine may claim together.
pub const MAX_TUNNEL_ROUTES: usize = 256;

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
    /// When `record` was last read from the database, Unix ms.
    checked_at: u64,
    /// Another machine changed the tunnel since: routing reads it again before trusting the cached copy.
    stale: bool,
    /// The service's generation when `record` was read.
    generation: u64,
    bridges: Vec<Arc<Bridge>>,
    sequence: u32,
    /// The renewal alarm read with `record`, and `checked_at` then.
    alarm: Option<(u64, Option<u64>)>,
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
    /// A visitor's data, holding its share of the bridge's and the machine's budget until written.
    Data(Bytes, crate::bridge::Held),
    /// The answer to a WebSocket ping from the client.
    Pong(Bytes),
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
    /// Bytes from the client waiting for visitors, at most `bridge::BRIDGE_BUDGET`.
    pub inbound_budget: Arc<Semaphore>,
    /// Bytes from visitors waiting for the client's socket, at most `bridge::OUTBOUND_BUDGET`.
    pub outbound_budget: Arc<Semaphore>,
    /// The machine's budget, shared by every bridge.
    pub buffer: Arc<Semaphore>,
    /// When the writer last sent the client anything, in `bridge::ticks`.
    pub sent_at: Arc<AtomicU64>,
    /// Public connections carried, from routing until both their directions ended: unlike `channels`, which a
    /// connection leaves once the client ends or resets it.
    pub visitors: Arc<AtomicUsize>,
}

/// A public connection's place in its bridge's `visitors`, given back when dropped.
pub struct VisitorSlot(Arc<AtomicUsize>);

impl Drop for VisitorSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
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

    /// The public connections this bridge may carry at once: what its client advertised, at most `limit`.
    pub fn conn_limit(&self, limit: usize) -> usize {
        match self.state.lock().expect("bridge lock").max_conns {
            Some(max_conns) => usize::try_from(max_conns).unwrap_or(limit).clamp(1, limit),
            None => limit,
        }
    }
}

/// Data from a tunnel client for one public connection.
#[derive(Debug)]
pub enum Inbound {
    /// Data, holding its share of the connection's, the bridge's and the machine's budget until written.
    Data(Bytes, crate::bridge::Held),
    End,
}

#[derive(Clone)]
pub struct ChannelHandle {
    /// Unbounded in messages: bounded in bytes by `budget`.
    pub inbound: mpsc::UnboundedSender<Inbound>,
    pub finish: Arc<Finish>,
    pub bytes_out: Arc<AtomicU64>,
    /// Bytes from the client waiting for this visitor, at most `bridge::CHANNEL_BUDGET`.
    pub budget: Arc<Semaphore>,
    /// When this visitor last took data, or when data started waiting for it, in `bridge::ticks`.
    pub drained_at: Arc<AtomicU64>,
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
    InvalidHostname {
        provided: String,
        expected: String,
    },
    Unavailable(String),
    /// The tunnel requested too many new certificates lately: try again after this many ms.
    RateLimited(u64),
    /// Too many certificate jobs are pending: try again later.
    Backlogged,
}

pub enum Attach {
    Attached {
        session: String,
        routes: Vec<String>,
        /// Bookkeeping for after `attached` is sent: [`Service::after_attach`].
        followup: AttachFollowup,
    },
    Error(&'static str, &'static str),
}

/// What an attach read that its bookkeeping needs.
pub struct AttachFollowup {
    /// The tunnel's renewal alarm, when it was read with the record (`None`: not read).
    alarm: Option<Option<u64>>,
}

/// Where a public connection goes.
pub enum Route {
    Bridge {
        bridge: Arc<Bridge>,
        conn: u32,
        tunnel_id: String,
        finish: Arc<Finish>,
        abort: watch::Receiver<bool>,
        inbound: mpsc::UnboundedReceiver<Inbound>,
        bytes_out: Arc<AtomicU64>,
        slot: VisitorSlot,
    },
    /// Nothing serves it here; the outcome is reported if the tunnel exists.
    Rejected {
        tunnel_exists: bool,
        outcome: &'static str,
    },
}

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
            cluster: std::sync::OnceLock::new(),
            limits: std::sync::OnceLock::new(),
            refresh_failed_at: AtomicU64::new(0),
            generation: AtomicU64::new(0),
            timeouts: std::sync::OnceLock::new(),
            draining: AtomicBool::new(false),
            bookkeeping: tokio::sync::Semaphore::new(BOOKKEEPING_WRITES),
            bridge_limits: std::sync::OnceLock::new(),
            buffer: std::sync::OnceLock::new(),
        }))
    }

    pub fn set_timeouts(&self, timeouts: crate::net::Timeouts) {
        let _ = self.timeouts.set(timeouts);
    }

    /// Must be called before the first bridge registers.
    pub fn set_bridge_limits(&self, limits: BridgeLimits) {
        let _ = self.bridge_limits.set(limits);
    }

    pub fn bridge_limits(&self) -> BridgeLimits {
        self.bridge_limits.get().copied().unwrap_or_default()
    }

    fn buffer(&self) -> Arc<Semaphore> {
        self.buffer
            .get_or_init(|| Arc::new(Semaphore::new(self.bridge_limits().buffered_bytes)))
            .clone()
    }

    /// Bytes of connection data held in memory now, both directions.
    pub fn buffered_bytes(&self) -> usize {
        self.bridge_limits().buffered_bytes - self.buffer().available_permits()
    }

    pub fn timeouts(&self) -> crate::net::Timeouts {
        self.timeouts.get().copied().unwrap_or_default()
    }

    pub fn set_cluster(&self, cluster: Arc<Cluster>) {
        let _ = self.cluster.set(cluster);
    }

    pub fn cluster(&self) -> Option<&Arc<Cluster>> {
        self.cluster.get()
    }

    pub fn set_limits(&self, limits: Arc<crate::limits::Limits>) {
        let _ = self.limits.set(limits);
    }

    pub fn limits(&self) -> Option<&Arc<crate::limits::Limits>> {
        self.limits.get()
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
            let loaded = self.store.tunnel_with_alarm(&entry.id).await?;
            let now = self.now();
            (state.record, state.revision, state.alarm) = match loaded {
                Some(loaded) => (
                    Some(loaded.loaded.record),
                    loaded.loaded.revision,
                    Some((now, loaded.alarm)),
                ),
                None => (None, 0, None),
            };
            state.loaded = true;
            state.checked_at = now;
            state.stale = false;
            state.generation = self.generation.load(Ordering::SeqCst);
        }
        Ok(state)
    }

    /// Locks a tunnel with its current record. With other machines writing to the same database, a cached
    /// record may be stale, so it is read again; when that fails, the cached copy is used (a database outage).
    /// A single machine is the only writer, so it keeps using its cache.
    pub async fn lock_fresh<'a>(
        &self,
        entry: &'a Entry,
    ) -> Result<tokio::sync::MutexGuard<'a, EntryState>> {
        if self.cluster().is_none() {
            return self.lock(entry).await;
        }
        let state = entry.state.lock().await;
        if !state.loaded {
            drop(state);
            return self.lock(entry).await;
        }
        Ok(self.refresh(entry, state).await)
    }

    /// Locks a tunnel for routing. A cached record that is live with a ready certificate cannot be wrong about
    /// routing (deletes elsewhere close bridges here), so only a missing or not yet ready one is read again: at
    /// once when another machine said it changed (created, deleted, certificate bound or ready) or a mesh link
    /// came up (events may have been missed), otherwise after `SAFETY_TTL_MS`, or the short TTLs while the mesh
    /// is not complete.
    pub async fn lock_routable<'a>(
        &self,
        entry: &'a Entry,
    ) -> Result<tokio::sync::MutexGuard<'a, EntryState>> {
        if self.cluster().is_none() {
            return self.lock(entry).await;
        }
        let state = entry.state.lock().await;
        if !state.loaded {
            drop(state);
            return self.lock(entry).await;
        }
        if state.stale {
            return Ok(self.refresh(entry, state).await);
        }
        if state
            .record()
            .is_some_and(|record| record.certificate_ready())
        {
            return Ok(state);
        }
        if state.generation < self.generation.load(Ordering::SeqCst) {
            return Ok(self.refresh(entry, state).await);
        }
        let complete = self
            .cluster()
            .is_some_and(|cluster| cluster.mesh.complete());
        let ttl = match state.record() {
            _ if complete => SAFETY_TTL_MS,
            Some(_) => NOT_READY_TTL_MS,
            None => MISSING_TTL_MS,
        };
        if self.now().saturating_sub(state.checked_at) < ttl {
            return Ok(state);
        }
        Ok(self.refresh(entry, state).await)
    }

    /// Locks a tunnel for an attach, with its record and alarm read in one round trip (on many machines). When
    /// the database does not answer in time, a cached record is used; without one the attach fails.
    async fn lock_for_attach<'a>(
        &self,
        entry: &'a Entry,
    ) -> Result<(tokio::sync::MutexGuard<'a, EntryState>, AttachFollowup)> {
        let unread = AttachFollowup { alarm: None };
        if self.cluster().is_none() {
            return Ok((self.lock(entry).await?, unread));
        }
        let mut state = entry.state.lock().await;
        let now = self.now();
        if state.loaded
            && now.saturating_sub(self.refresh_failed_at.load(Ordering::Relaxed))
                < REFRESH_BACKOFF_MS
        {
            return Ok((state, unread));
        }
        let generation = self.generation.load(Ordering::SeqCst);
        // Read moments ago, by the upgrade that let this bridge in (a tunnel new to this machine): reading it
        // again would only double the attach's round trips to the database.
        if let Some((read_at, alarm)) = state.alarm
            && state.loaded
            && !state.stale
            && state.generation == generation
            && read_at == state.checked_at
            && now.saturating_sub(read_at) < ATTACH_REREAD_MS
        {
            return Ok((state, AttachFollowup { alarm: Some(alarm) }));
        }
        let snapshot = self
            .store
            .attach_snapshot(&entry.id, ATTACH_STORAGE_TIMEOUT)
            .await;
        match snapshot {
            Ok(Some(snapshot)) => {
                state.record = Some(snapshot.loaded.record);
                state.revision = snapshot.loaded.revision;
                state.alarm = Some((now, snapshot.alarm));
                state.loaded = true;
                state.checked_at = now;
                state.stale = false;
                state.generation = generation;
                Ok((
                    state,
                    AttachFollowup {
                        alarm: Some(snapshot.alarm),
                    },
                ))
            }
            Ok(None) => {
                state.record = None;
                state.revision = 0;
                state.loaded = true;
                state.checked_at = now;
                state.stale = false;
                state.generation = generation;
                Ok((state, unread))
            }
            Err(error) if state.loaded => {
                self.refresh_failed_at.store(now, Ordering::Relaxed);
                warn!(tunnel = %entry.id, error = %format!("{error:#}"), "attaching with a cached record");
                Ok((state, unread))
            }
            Err(error) => Err(error),
        }
    }

    async fn refresh<'a>(
        &self,
        entry: &'a Entry,
        mut state: tokio::sync::MutexGuard<'a, EntryState>,
    ) -> tokio::sync::MutexGuard<'a, EntryState> {
        let now = self.now();
        if now.saturating_sub(self.refresh_failed_at.load(Ordering::Relaxed)) < REFRESH_BACKOFF_MS {
            return state;
        }
        let generation = self.generation.load(Ordering::SeqCst);
        match self.store.tunnel(&entry.id).await {
            Ok(loaded) => {
                (state.record, state.revision) = match loaded {
                    Some(loaded) => (Some(loaded.record), loaded.revision),
                    None => (None, 0),
                };
                state.checked_at = now;
                state.stale = false;
                state.generation = generation;
            }
            Err(error) => {
                self.refresh_failed_at.store(now, Ordering::Relaxed);
                warn!(tunnel = %entry.id, error = %format!("{error:#}"), "using a cached record");
            }
        }
        state
    }

    /// Drops cached entries nobody is using, that have no bridges and that were not read recently (so tunnels
    /// found missing stay known as missing for `MISSING_TTL_MS`).
    pub fn collect_idle(&self) {
        let now = self.now();
        let mut tunnels = self.tunnels.lock().expect("tunnels lock");
        tunnels.retain(|_, entry| {
            if Arc::strong_count(entry) > 1 {
                return true;
            }
            match entry.state.try_lock() {
                Ok(state) => {
                    !state.bridges.is_empty()
                        || (state.loaded && now.saturating_sub(state.checked_at) < MISSING_TTL_MS)
                }
                Err(_) => true,
            }
        });
    }

    /// Marks a cached tunnel as changed by another machine, so routing reads it again before trusting it. The
    /// cached copy stays for when the database cannot be reached. Nothing to do if it is not cached here.
    pub async fn expire(&self, id: &str) {
        let entry = self.tunnels.lock().expect("tunnels lock").get(id).cloned();
        if let Some(entry) = entry {
            entry.state.lock().await.stale = true;
        }
    }

    /// Mesh events may have been missed (a link came up): cached "missing" and "not ready" answers are read again
    /// before routing trusts them.
    pub fn forget_cached_answers(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    /// Tells the other machines something they act on: a tunnel changed in a way routing cares about, or a job
    /// was added.
    fn announce(&self, event: crate::mesh::Event) {
        if let Some(cluster) = self.cluster() {
            cluster.mesh.publish(event);
        }
    }

    /// Wakes the job runner here, and on the other machines.
    fn job_added(&self) {
        self.jobs.notify_one();
        self.announce(crate::mesh::Event::JobEnqueued);
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
        let mut state = self.lock_fresh(&entry).await?;
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
        self.announce(crate::mesh::Event::TunnelCreated { tunnel: id.into() });
        // A recreated ID must not inherit the deleted tunnel's alarm.
        self.store.set_alarm(id, None).await?;
        Ok(Some(self.view(&state, &record)))
    }

    pub async fn info(&self, id: &str, token: &str) -> Result<Lookup<TunnelView>> {
        let entry = self.entry(id);
        let state = self.lock_fresh(&entry).await?;
        let Some(record) = state.record() else {
            return Ok(Lookup::NotFound);
        };
        if !token_matches(token, &record.token_hash) {
            return Ok(Lookup::Unauthorized);
        }
        let mut view = self.view(&state, record);
        // A bridge on another machine counts too.
        if view.state == TunnelState::Offline
            && let Some(cluster) = self.cluster()
            && cluster.online_elsewhere(id)
        {
            view.state = TunnelState::Online;
        }
        Ok(Lookup::Ok(view))
    }

    pub async fn certificate(&self, id: &str, token: &str) -> Result<CertificateLookup> {
        let entry = self.entry(id);
        let state = self.lock_fresh(&entry).await?;
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
        let mut state = self.lock_fresh(&entry).await?;
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
        // A new certificate: an ACME order and DNS changes on the shared account, so it is limited.
        if let Some(limits) = self.limits() {
            if limits.backlogged().await {
                return Ok(Bind::Backlogged);
            }
            if let crate::limits::Verdict::Limited { retry_after_ms } = limits.issuance(id).await? {
                return Ok(Bind::RateLimited(retry_after_ms));
            }
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
        self.announce(crate::mesh::Event::CertificateChanged { tunnel: id.into() });
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
        let mut state = self.lock_fresh(&entry).await?;
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
        // Bridges attached to other machines close too.
        self.announce(crate::mesh::Event::TunnelDeleted { tunnel: id.into() });
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
            self.job_added();
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
        let mut state = self.lock_fresh(&entry).await?;
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
                    self.announce(crate::mesh::Event::CertificateChanged {
                        tunnel: tunnel_id.into(),
                    });
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
        if matches!(input, CertificateState::Ready { .. }) {
            self.announce(crate::mesh::Event::CertificateChanged {
                tunnel: tunnel_id.into(),
            });
        }
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

    /// Whether the tunnel still waits for certificate `certificate_id`: it exists, is not deleted, and the
    /// certificate is its current one or its renewal.
    pub async fn wants_certificate(&self, tunnel_id: &str, certificate_id: &str) -> Result<bool> {
        let entry = self.entry(tunnel_id);
        let state = self.lock_fresh(&entry).await?;
        Ok(state.record().is_some_and(|record| {
            record.certificate_id.as_deref() == Some(certificate_id)
                || record
                    .renewal
                    .as_ref()
                    .is_some_and(|renewal| renewal.certificate_id == certificate_id)
        }))
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
        let mut state = self.lock_fresh(&entry).await?;
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
    async fn on_attached(
        &self,
        state: &mut EntryState,
        record: StoredTunnel,
        alarm: Option<Option<u64>>,
    ) -> Result<()> {
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
        } else if match alarm {
            Some(alarm) => alarm,
            None => self.store.alarm(&record.id).await?,
        }
        .is_none()
        {
            self.schedule_renewal(&record).await
        } else {
            Ok(())
        }
    }

    /// Resumes issuance that has no job: records restored mid-issuance from an export (whose jobs are not in
    /// it). Only issuance older than `grace_ms` is resumed, so a job being added right now is not raced.
    pub async fn resume_orphaned_issuance(&self, grace_ms: u64) -> Result<usize> {
        let now = self.now();
        let mut resumed = 0;
        for candidate in self.store.issuing_tunnels().await? {
            let entry = self.entry(&candidate.id);
            let state = self.lock_fresh(&entry).await?;
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

    /// Queues first issuance again where it gave up early on a transient error (as every job did before
    /// transient errors were retried for a day) and the tunnel still waits for that certificate. The tunnel shows
    /// `issuing` again, so clients that poll it see it become ready. A job requeued like this starts a new retry
    /// window, so it is requeued at most once.
    ///
    /// Also queues first issuance again, once, that was queued before `AUTHZ_PENDING_FIX_MS` and failed or keeps
    /// failing with an ACME authorization still pending: ZeroSSL reused a stuck authorization for every attempt,
    /// which attempts now deactivate.
    pub async fn retry_failed_issuance(&self) -> Result<usize> {
        let now = self.now();
        let mut requeued = 0;
        let mut seen = std::collections::HashSet::new();
        for job in self
            .store
            .failed_issue_jobs(now.saturating_sub(RETRY_FAILED_MAX_AGE_MS))
            .await?
        {
            let gave_up_early =
                job.updated_at.saturating_sub(job.created_at) < retry::RETRY_WINDOW_MS / 2;
            if !gave_up_early
                || !matches!(
                    retry::classify_reason(&job.last_error),
                    retry::Class::Transient { .. }
                )
            {
                continue;
            }
            let Some(tunnel) = &job.tunnel_id else {
                continue;
            };
            let entry = self.entry(tunnel);
            let mut state = self.lock_fresh(&entry).await?;
            let Some(record) = state.record().cloned() else {
                continue;
            };
            let waiting = !record.is_deleted()
                && record.certificate_id.as_deref() == Some(&job.certificate_id)
                && record.certificate.as_ref().is_some_and(|certificate| {
                    certificate.id == job.certificate_id
                        && matches!(certificate.state, CertificateState::Failed { .. })
                });
            if !waiting
                || !self
                    .store
                    .requeue_failed_job(&job.certificate_id, now)
                    .await?
            {
                continue;
            }
            info!(tunnel, certificate = %job.certificate_id, reason = %job.last_error, "retrying certificate issuance that failed transiently");
            let issuing = StoredTunnel {
                certificate: Some(CertificateInfo {
                    id: job.certificate_id.clone(),
                    state: CertificateState::Issuing,
                }),
                ..record
            };
            // Should this fail, the job still runs and records the certificate when it is ready.
            if let Err(error) = self.save(&mut state, issuing).await {
                warn!(tunnel, %error, "failed to show requeued issuance as issuing");
            }
            seen.insert(job.certificate_id.clone());
            requeued += 1;
        }
        for job in self
            .store
            .authz_pending_issue_jobs(
                AUTHZ_PENDING_FIX_MS,
                now.saturating_sub(RETRY_FAILED_MAX_AGE_MS),
            )
            .await?
        {
            if seen.contains(&job.certificate_id) {
                continue;
            }
            let Some(tunnel) = &job.tunnel_id else {
                continue;
            };
            let entry = self.entry(tunnel);
            let mut state = self.lock_fresh(&entry).await?;
            let Some(record) = state.record().cloned() else {
                continue;
            };
            let waiting = record.certificate_id.as_deref() == Some(&job.certificate_id)
                && record.certificate.as_ref().is_some_and(|certificate| {
                    certificate.id == job.certificate_id
                        && !matches!(certificate.state, CertificateState::Ready { .. })
                });
            if !waiting
                || !self
                    .store
                    .requeue_job_queued_before(&job.certificate_id, AUTHZ_PENDING_FIX_MS, now)
                    .await?
            {
                continue;
            }
            info!(tunnel, certificate = %job.certificate_id, status = %job.status, reason = %job.last_error, "retrying certificate issuance stuck on a pending authorization");
            if record.certificate.as_ref().is_some_and(|certificate| {
                matches!(certificate.state, CertificateState::Failed { .. })
            }) {
                let issuing = StoredTunnel {
                    certificate: Some(CertificateInfo {
                        id: job.certificate_id.clone(),
                        state: CertificateState::Issuing,
                    }),
                    ..record
                };
                if let Err(error) = self.save(&mut state, issuing).await {
                    warn!(tunnel, %error, "failed to show requeued issuance as issuing");
                }
            }
            requeued += 1;
        }
        if requeued > 0 {
            self.job_added();
        }
        Ok(requeued)
    }

    // --- Bridges -----------------------------------------------------------------------------------------

    /// Whether the tunnel exists, for the WebSocket upgrade.
    pub async fn exists(&self, id: &str) -> Result<bool> {
        let entry = self.entry(id);
        let state = self.lock_routable(&entry).await?;
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
        let mut state = self.lock_routable(&entry).await?;
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
            inbound_budget: Arc::new(Semaphore::new(crate::bridge::BRIDGE_BUDGET)),
            outbound_budget: Arc::new(Semaphore::new(crate::bridge::OUTBOUND_BUDGET)),
            buffer: self.buffer(),
            sent_at: Arc::new(AtomicU64::new(crate::bridge::ticks())),
            visitors: Arc::new(AtomicUsize::new(0)),
        });
        state.bridges.push(bridge.clone());
        // Checked under the entry lock that `drain` also takes, so no bridge is missed.
        if self.draining.load(Ordering::SeqCst) {
            send_drain(&bridge, DRAIN_REASON);
        }
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
        let (mut state, followup) = self.lock_for_attach(&entry).await?;
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
        self.retire_stale(&mut state);
        let held: usize = state
            .attached()
            .filter(|candidate| candidate.id != bridge.id)
            .map(|candidate| candidate.snapshot().routes.len())
            .sum();
        if held + routes.len() > MAX_TUNNEL_ROUTES {
            return Ok(Attach::Error("too_many_routes", "too many routes"));
        }
        let conflict = state.bridges.iter().any(|candidate| {
            candidate.id != bridge.id && routes.iter().any(|route| candidate.claims(route))
        });
        if conflict {
            return Ok(Attach::Error("route_conflict", "route conflict"));
        }
        // Routes are exclusive across machines too: the mesh table names the machines to ask, and only one of
        // those still holding a route is a conflict. Two machines attaching the same route in the same instant
        // may both succeed; visitors then reach the newer one, and the older keeps its own region's visitors.
        if let Some(cluster) = self.cluster()
            && cluster.held_elsewhere(id, &routes).await
        {
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
        // Every other machine can send visitors here from the moment the client hears `attached`.
        if let Some(cluster) = self.cluster() {
            cluster.mesh.attached(id, bridge.id, &routes, now);
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
        Ok(Attach::Attached {
            session,
            routes,
            followup,
        })
    }

    /// The bookkeeping of an attach, once the client has `attached`: records the connection on the record
    /// (`lastConnectedAt`, at most every `LAST_CONNECTED_INTERVAL_MS`) and checks the renewal. None of it delays
    /// or fails the attach: a failed record write or renewal check happens again on the next attach or alarm.
    pub async fn after_attach(&self, id: &str, bridge: &Arc<Bridge>, followup: AttachFollowup) {
        let recent = |record: &StoredTunnel, now: u64| {
            record.state == TunnelState::Online
                && record
                    .last_connected_at
                    .as_deref()
                    .and_then(parse_iso)
                    .is_some_and(|at| now.saturating_sub(at) < LAST_CONNECTED_INTERVAL_MS)
        };
        let record = async {
            let entry = self.entry(id);
            let writes = followup.alarm.is_none() || {
                let state = entry.state.lock().await;
                state
                    .record()
                    .is_some_and(|record| !recent(record, self.now()))
            };
            // Taken before the entry's lock, so routing never waits for a slot.
            let _slot = if writes {
                Some(self.bookkeeping.acquire().await)
            } else {
                None
            };
            let mut state = entry.state.lock().await;
            let Some(record) = state.record().cloned() else {
                return;
            };
            if !bridge.is_attached() {
                return;
            }
            let now = self.now();
            let recent = recent(&record, now);
            let record = if recent {
                record
            } else {
                let connected = StoredTunnel {
                    state: TunnelState::Online,
                    last_connected_at: Some(iso(now)),
                    ..record
                };
                if let Err(error) = self.save(&mut state, connected.clone()).await {
                    warn!(tunnel = %id, error = %format!("{error:#}"), "could not record the connection");
                    return;
                }
                connected
            };
            if let Err(error) = self.on_attached(&mut state, record, followup.alarm).await {
                warn!(tunnel = %id, error = %format!("{error:#}"), "renewal check on attach failed");
            }
        };
        record.await;
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
        let mut state = entry.state.lock().await;
        state.bridges.retain(|candidate| candidate.id != bridge.id);
        let snapshot = bridge.snapshot();
        // Bridges that never attached have nothing to clean up; retired ones were cleaned up when retired.
        if !snapshot.attached || snapshot.detached {
            return Ok(());
        }
        bridge.state.lock().expect("bridge lock").detached = true;
        bridge.finish_channels(Outcome::BridgeDisconnected);
        crate::metrics::bridge_detach(crate::metrics::detach_reason(snapshot.server_close, clean));
        self.publish_disconnected(id, &snapshot, code, clean);
        if let Some(cluster) = self.cluster() {
            cluster.mesh.detached(id, bridge.id);
        }
        Ok(())
    }

    /// Retires attached bridges whose client is gone. A client that vanishes without a close (sleep, a network
    /// change) leaves its socket open until TCP notices, which can take very long. Until then the bridge would
    /// keep its routes, so the client's reconnects get `route_conflict`, and it would swallow every public
    /// connection routed to it.
    ///
    /// Neither this nor a closing bridge writes the record: its stored `state` is informational (the API computes
    /// it from live bridges), so it is set online with `lastConnectedAt` and left as it is when bridges go.
    fn retire_stale(&self, state: &mut EntryState) {
        let now = self.now();
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
            crate::metrics::bridge_detach("idle_retire");
            if let Some(id) = &id {
                self.publish_disconnected(id, &snapshot, 1001, false);
                if let Some(cluster) = self.cluster() {
                    cluster.mesh.detached(id, bridge.id);
                }
            }
        }
    }

    /// Retires silent bridges across all tunnels; the Durable Object only did this lazily.
    pub async fn sweep(&self) -> Result<()> {
        for entry in self.entries() {
            let mut state = entry.state.lock().await;
            if state.bridges.is_empty() {
                continue;
            }
            self.retire_stale(&mut state);
        }
        self.collect_idle();
        Ok(())
    }

    /// Picks the bridge for a public connection and registers the connection on it.
    pub async fn route(&self, id: &str, sni: &str) -> Result<Route> {
        let entry = self.entry(id);
        let mut state = self.lock_routable(&entry).await?;
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
        self.retire_stale(&mut state);
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
        let limits = self.bridge_limits();
        let tunnel_conns: usize = state
            .bridges
            .iter()
            .map(|bridge| bridge.visitors.load(Ordering::Relaxed))
            .sum();
        if bridge.visitors.load(Ordering::Relaxed) >= bridge.conn_limit(limits.conns_per_bridge)
            || tunnel_conns >= limits.conns_per_tunnel
        {
            return Ok(Route::Rejected {
                tunnel_exists: true,
                outcome: "too_many_connections",
            });
        }
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
        bridge.visitors.fetch_add(1, Ordering::Relaxed);
        let slot = VisitorSlot(bridge.visitors.clone());
        let (finish, abort) = Finish::new();
        let (inbound_tx, inbound) = mpsc::unbounded_channel();
        let bytes_out = Arc::new(AtomicU64::new(0));
        bridge.channels.lock().expect("channels lock").insert(
            conn,
            ChannelHandle {
                inbound: inbound_tx,
                finish: finish.clone(),
                bytes_out: bytes_out.clone(),
                budget: Arc::new(Semaphore::new(crate::bridge::CHANNEL_BUDGET)),
                drained_at: Arc::new(AtomicU64::new(crate::bridge::ticks())),
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
            slot,
        })
    }

    /// Closes this machine's bridges of a tunnel deleted elsewhere, and forgets its cached record. Returns
    /// whether it had any.
    pub async fn close_deleted(&self, id: &str) -> bool {
        let entry = self.tunnels.lock().expect("tunnels lock").get(id).cloned();
        let Some(entry) = entry else {
            return false;
        };
        let mut state = entry.state.lock().await;
        for bridge in &state.bridges {
            bridge.finish_channels(Outcome::Deleted);
            bridge.close(1000, "deleted");
        }
        state.loaded = false;
        state.record = None;
        state.revision = 0;
        !state.bridges.is_empty()
    }

    /// The routes this machine's live bridges hold for a tunnel, for another machine's attach.
    pub async fn held_routes(&self, id: &str) -> Result<Vec<String>> {
        let entry = self.entry(id);
        let mut state = entry.state.lock().await;
        if state.bridges.is_empty() {
            return Ok(Vec::new());
        }
        self.retire_stale(&mut state);
        Ok(state
            .attached()
            .filter(|bridge| !bridge.is_closing())
            .flat_map(|bridge| bridge.snapshot().routes)
            .collect())
    }

    /// Closes the bridges here of tunnels deleted while a deletion could have been missed (a mesh link was down).
    pub async fn close_deleted_tunnels(&self) -> Result<()> {
        let mut live = Vec::new();
        for entry in self.entries() {
            if entry.state.lock().await.attached().next().is_some() {
                live.push(entry.id.clone());
            }
        }
        if live.is_empty() {
            return Ok(());
        }
        for tunnel in self.store.deleted_tunnels(&live).await? {
            info!(
                tunnel,
                "closing the bridges of a tunnel deleted on another machine"
            );
            self.close_deleted(&tunnel).await;
        }
        Ok(())
    }

    /// Closes every bridge, for shutdown. Clients treat `drain` as a reason to reconnect.
    /// Tells every bridge to reconnect elsewhere (`drain`, then close 1012), and every bridge that arrives from
    /// now on as soon as it registers.
    /// Tells every bridge to reconnect elsewhere, and any that arrives from now on. Many bridges are told over up
    /// to `DRAIN_SPREAD`, `DRAIN_RATE` a second: all at once, they all reached the machines they move to within
    /// a quarter of a second (the clients' first retry), far more than one machine attaches at a time.
    pub async fn drain(&self) {
        self.draining.store(true, Ordering::SeqCst);
        let mut bridges = Vec::new();
        for entry in self.entries() {
            let state = entry.state.lock().await;
            bridges.extend(state.bridges.iter().cloned());
        }
        let steps = (DRAIN_SPREAD.as_millis() / DRAIN_STEP.as_millis()) as usize;
        let per_step = (DRAIN_RATE * DRAIN_STEP.as_millis() as usize / 1000)
            .max(bridges.len().div_ceil(steps.max(1)))
            .max(1);
        for (index, chunk) in bridges.chunks(per_step).enumerate() {
            if index > 0 {
                tokio::time::sleep(DRAIN_STEP).await;
            }
            for bridge in chunk {
                send_drain(bridge, DRAIN_REASON);
            }
        }
    }

    pub fn is_draining(&self) -> bool {
        self.draining.load(Ordering::SeqCst)
    }

    /// Ready certificates of tunnels with an attached bridge here that expire before `before` (or have
    /// expired), for the metrics: a renewal that keeps failing shows up here weeks before visitors notice.
    pub fn expiring_certificates(&self, before: u64) -> usize {
        self.entries()
            .iter()
            .filter_map(|entry| {
                let state = entry.state.try_lock().ok()?;
                state.attached().next()?;
                let expiry = parse_iso(state.record()?.ready_expiry()?)?;
                (expiry < before).then_some(())
            })
            .count()
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

    /// Every registered bridge, attached or not.
    pub async fn registered_bridges(&self) -> usize {
        let mut count = 0;
        for entry in self.entries() {
            count += entry.state.lock().await.bridges.len();
        }
        count
    }
}

/// Why bridges are drained: the only reason there is.
const DRAIN_REASON: &str = "server restarting";

fn send_drain(bridge: &Bridge, reason: &str) {
    let message = serde_json::to_string(&json!({ "type": "drain", "reason": reason }))
        .expect("drain serializes");
    let _ = bridge.tx.try_send(Outbound::Text(message));
    bridge.close(1012, reason);
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

        /// One of many machines sharing the database.
        async fn clustered() -> Option<Self> {
            let harness = Self::new().await?;
            harness
                .service
                .set_cluster(Arc::new(test_cluster(harness.service.clock.clone())));
            Some(harness)
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
                Attach::Attached {
                    session, followup, ..
                } => {
                    self.service
                        .after_attach("abcdefghijkl", bridge, followup)
                        .await;
                    Ok(session)
                }
                Attach::Error(code, _) => Err(code),
            }
        }
    }

    fn test_cluster(clock: Clock) -> Cluster {
        Cluster::new(
            "machine-a".into(),
            "nrt".into(),
            "secret".into(),
            clock,
            Arc::new(crate::http::Stats::default()),
            crate::mesh::MeshConfig::default(),
        )
        .unwrap()
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
        // The stored state is informational and not rewritten when bridges go; the API's comes from live bridges.
        assert_eq!(harness.record().await.state, TunnelState::Online);
        assert!(matches!(
            harness.service.info("abcdefghijkl", "token").await.unwrap(),
            Lookup::Ok(TunnelView {
                state: TunnelState::Offline,
                ..
            })
        ));
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

    #[tokio::test]
    async fn queues_transiently_failed_issuance_again_once() {
        let Some(harness) = Harness::new().await else {
            return;
        };
        let store = &harness.service.store;
        let base = harness.tunnel(T0 + 80 * DAY_MS, None).await;
        // A failed job and its tunnel, which shows the failure.
        let failed = async |id: &str, certificate: &str, reason: &str, deleted: bool| {
            let mut record = base.clone();
            record.id = id.into();
            record.certificate_id = Some(certificate.into());
            record.certificate = Some(CertificateInfo {
                id: certificate.into(),
                state: CertificateState::Failed {
                    reason: reason.into(),
                },
            });
            if deleted {
                record.deleted_at = Some(iso(T0));
            }
            store.put_tunnel(&record, T0).await.unwrap();
            let job = Job {
                certificate_id: certificate.into(),
                tunnel_id: Some(id.into()),
                kind: JobKind::Issue,
                identifiers: vec![record.hostname.clone()],
                csr: "CSR".into(),
                attempts: 0,
                created_at: T0 - 2 * MINUTE_MS,
            };
            store.add_job(job, T0 - 2 * MINUTE_MS).await.unwrap();
            store
                .claim_job(certificate, "old", T0 - MINUTE_MS)
                .await
                .unwrap()
                .unwrap();
            store
                .finish_job(
                    certificate,
                    "old",
                    "failed",
                    Some(reason.into()),
                    T0 - MINUTE_MS,
                )
                .await
                .unwrap();
        };
        failed(
            "noncenonce01",
            "cert_nonce",
            "ACME server returned no nonce",
            false,
        )
        .await;
        failed(
            "duplicatedns",
            "cert_dns",
            "An identical record already exists.",
            false,
        )
        .await;
        failed(
            "rejectedname",
            "cert_rejected",
            "urn:ietf:params:acme:error:rejectedIdentifier: DNS identifier is invalid | HTTP 400 | {}",
            false,
        )
        .await;
        failed(
            "deletedtunnl",
            "cert_deleted",
            "ACME server returned no nonce",
            true,
        )
        .await;
        // The client already bound another certificate.
        failed(
            "rebound00000",
            "cert_old",
            "ACME server returned no nonce",
            false,
        )
        .await;
        let mut rebound = store.tunnel("rebound00000").await.unwrap().unwrap().record;
        rebound.certificate_id = Some("cert_new".into());
        rebound.certificate = Some(CertificateInfo {
            id: "cert_new".into(),
            state: CertificateState::Issuing,
        });
        store.put_tunnel(&rebound, T0).await.unwrap();

        harness.advance(MINUTE_MS);
        assert_eq!(harness.service.retry_failed_issuance().await.unwrap(), 2);
        for (id, certificate) in [("noncenonce01", "cert_nonce"), ("duplicatedns", "cert_dns")] {
            assert!(store.job_pending(certificate).await.unwrap());
            let record = store.tunnel(id).await.unwrap().unwrap().record;
            assert_eq!(record.certificate.unwrap().state, CertificateState::Issuing);
        }
        for certificate in ["cert_rejected", "cert_deleted", "cert_old"] {
            assert!(!store.job_pending(certificate).await.unwrap());
        }
        // Requeued jobs are due now, with a new retry window.
        let due = store
            .claim_due_jobs("new", harness.service.now(), 10)
            .await
            .unwrap();
        let mut ids: Vec<_> = due.iter().map(|job| job.certificate_id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, ["cert_dns", "cert_nonce"]);
        assert!(
            due.iter()
                .all(|job| job.attempts == 0 && job.created_at == harness.service.now())
        );
        assert_eq!(harness.service.retry_failed_issuance().await.unwrap(), 0);

        // Should one fail again after its whole retry window, it stays failed.
        harness.advance(retry::RETRY_WINDOW_MS);
        let now = harness.service.now();
        store
            .finish_job(
                "cert_nonce",
                "new",
                "failed",
                Some("ACME server returned no nonce".into()),
                now,
            )
            .await
            .unwrap();
        let mut record = store.tunnel("noncenonce01").await.unwrap().unwrap().record;
        record.certificate = Some(CertificateInfo {
            id: "cert_nonce".into(),
            state: CertificateState::Failed {
                reason: "ACME server returned no nonce".into(),
            },
        });
        store.put_tunnel(&record, now).await.unwrap();
        harness.service.invalidate("noncenonce01").await;
        assert_eq!(harness.service.retry_failed_issuance().await.unwrap(), 0);
        assert!(!store.job_pending("cert_nonce").await.unwrap());
    }

    #[tokio::test]
    async fn queues_issuance_stuck_on_a_pending_authorization_again_once() {
        let Some(harness) = Harness::new().await else {
            return;
        };
        let store = &harness.service.store;
        let base = harness.tunnel(T0 + 80 * DAY_MS, None).await;
        const PENDING: &str = "ACME authorization ended in pending";
        let queued = AUTHZ_PENDING_FIX_MS - DAY_MS;
        // A job queued before the fix whose attempts ended on a pending authorization: `failed` gave up after its
        // retry window, otherwise it is still retrying (and maybe running).
        let stuck = async |id: &str, state: CertificateState, status: &str, queued: u64| {
            let mut record = base.clone();
            record.id = id.into();
            let certificate = format!("cert_{id}");
            record.certificate_id = Some(certificate.clone());
            record.certificate = Some(CertificateInfo {
                id: certificate.clone(),
                state,
            });
            store.put_tunnel(&record, T0).await.unwrap();
            let job = Job {
                certificate_id: certificate.clone(),
                tunnel_id: Some(id.into()),
                kind: JobKind::Issue,
                identifiers: vec![record.hostname.clone()],
                csr: "CSR".into(),
                attempts: 0,
                created_at: queued,
            };
            store.add_job(job, queued).await.unwrap();
            let updated = T0 - HOUR_MS;
            store
                .claim_job(&certificate, "old", updated)
                .await
                .unwrap()
                .unwrap();
            if status == "failed" {
                store
                    .finish_job(&certificate, "old", "failed", Some(PENDING.into()), updated)
                    .await
                    .unwrap();
            } else {
                store
                    .retry_job(&certificate, "old", 30, T0, PENDING.into(), updated)
                    .await
                    .unwrap();
            }
            if status == "running" {
                store
                    .claim_job(&certificate, "busy", T0)
                    .await
                    .unwrap()
                    .unwrap();
            }
            certificate
        };
        let failed = || CertificateState::Failed {
            reason: PENDING.into(),
        };
        let challenge = || CertificateState::Challenge {
            token: "t".into(),
            key: "k".into(),
        };
        let gave_up = stuck("gaveup000000", failed(), "failed", queued).await;
        let retrying = stuck("retrying0000", challenge(), "pending", queued).await;
        let running = stuck("running00000", challenge(), "running", queued).await;
        let after_fix = stuck(
            "afterfix0000",
            failed(),
            "failed",
            AUTHZ_PENDING_FIX_MS + HOUR_MS,
        )
        .await;
        let ready = stuck(
            "readynow0000",
            base.certificate.clone().unwrap().state,
            "failed",
            queued,
        )
        .await;
        let deleted = stuck("deleted00000", failed(), "failed", queued).await;
        let mut record = store.tunnel("deleted00000").await.unwrap().unwrap().record;
        record.deleted_at = Some(iso(T0));
        store.put_tunnel(&record, T0).await.unwrap();

        assert_eq!(harness.service.retry_failed_issuance().await.unwrap(), 2);
        let record = store.tunnel("gaveup000000").await.unwrap().unwrap().record;
        assert_eq!(record.certificate.unwrap().state, CertificateState::Issuing);
        let record = store.tunnel("retrying0000").await.unwrap().unwrap().record;
        assert_eq!(record.certificate.unwrap().state, challenge());
        let due = store
            .claim_due_jobs("new", harness.service.now(), 10)
            .await
            .unwrap();
        let mut ids: Vec<_> = due.iter().map(|job| job.certificate_id.clone()).collect();
        ids.sort();
        assert_eq!(ids, [gave_up.clone(), retrying.clone()]);
        assert!(
            due.iter()
                .all(|job| job.attempts == 0 && job.created_at == T0)
        );
        for certificate in [&after_fix, &ready, &deleted] {
            assert!(!store.job_pending(certificate).await.unwrap());
        }
        // The running one is left to finish; it is not taken from its server.
        assert!(store.job_pending(&running).await.unwrap());
        store
            .finish_job(&running, "busy", "done", None, T0)
            .await
            .unwrap();

        // Once only: they fail again on a pending authorization after their retry window, and stay failed.
        harness.advance(retry::RETRY_WINDOW_MS);
        let now = harness.service.now();
        for certificate in [&gave_up, &retrying] {
            store
                .finish_job(certificate, "new", "failed", Some(PENDING.into()), now)
                .await
                .unwrap();
        }
        let mut record = store.tunnel("gaveup000000").await.unwrap().unwrap().record;
        record.certificate = Some(CertificateInfo {
            id: gave_up.clone(),
            state: failed(),
        });
        store.put_tunnel(&record, now).await.unwrap();
        harness.service.invalidate("gaveup000000").await;
        assert_eq!(harness.service.retry_failed_issuance().await.unwrap(), 0);
        assert!(!store.job_pending(&gave_up).await.unwrap());
        assert!(!store.job_pending(&retrying).await.unwrap());
    }

    #[tokio::test]
    async fn trusts_a_missing_tunnel_until_told_otherwise() {
        let Some(harness) = Harness::clustered().await else {
            return;
        };
        let host = "abcdefghijkl.opentunnel.test";
        let missing = async || {
            matches!(
                harness.service.route("abcdefghijkl", host).await.unwrap(),
                Route::Rejected {
                    tunnel_exists: false,
                    ..
                }
            )
        };
        assert!(missing().await);
        assert!(!harness.service.exists("abcdefghijkl").await.unwrap());
        // Created behind this machine's back: with every peer linked (none here), the cached answer stands until
        // an event says otherwise, and only the safety TTL ends it without one.
        harness.tunnel(T0 + 80 * DAY_MS, None).await;
        harness.service.collect_idle();
        assert!(missing().await);
        harness.advance(MISSING_TTL_MS);
        assert!(!harness.service.exists("abcdefghijkl").await.unwrap());
        harness.service.expire("abcdefghijkl").await;
        assert!(harness.service.exists("abcdefghijkl").await.unwrap());
        assert!(!missing().await);

        // A link coming up (events may have been missed) makes every cached answer stale.
        assert!(!harness.service.exists("otherone0000").await.unwrap());
        let mut other = harness.record().await;
        other.id = "otherone0000".into();
        other.hostname = "otherone0000.opentunnel.test".into();
        harness.service.store.put_tunnel(&other, T0).await.unwrap();
        assert!(!harness.service.exists("otherone0000").await.unwrap());
        harness.service.forget_cached_answers();
        assert!(harness.service.exists("otherone0000").await.unwrap());

        // And the safety TTL.
        assert!(!harness.service.exists("thirdone0000").await.unwrap());
        other.id = "thirdone0000".into();
        other.hostname = "thirdone0000.opentunnel.test".into();
        harness.service.store.put_tunnel(&other, T0).await.unwrap();
        harness.advance(SAFETY_TTL_MS);
        assert!(harness.service.exists("thirdone0000").await.unwrap());
    }

    /// A TCP proxy to the database that holds every client write for `delay`, like a database a round trip of
    /// `delay` away (Tokyo to us-east-1). Returns the URL that goes through it.
    async fn distant_database(url: &str, delay: std::time::Duration) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut url = url::Url::parse(url).unwrap();
        let target = format!("{}:{}", url.host_str().unwrap(), url.port().unwrap_or(3306));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((client, _)) = listener.accept().await {
                let target = target.clone();
                tokio::spawn(async move {
                    let Ok(server) = tokio::net::TcpStream::connect(&target).await else {
                        return;
                    };
                    let _ = client.set_nodelay(true);
                    let _ = server.set_nodelay(true);
                    let (mut client_read, mut client_write) = client.into_split();
                    let (mut server_read, mut server_write) = server.into_split();
                    tokio::spawn(async move {
                        let _ = tokio::io::copy(&mut server_read, &mut client_write).await;
                    });
                    let mut buffer = vec![0u8; 64 * 1024];
                    loop {
                        let Ok(read) = client_read.read(&mut buffer).await else {
                            return;
                        };
                        if read == 0 {
                            return;
                        }
                        tokio::time::sleep(delay).await;
                        if server_write.write_all(&buffer[..read]).await.is_err() {
                            return;
                        }
                    }
                });
            }
        });
        url.set_host(Some("127.0.0.1")).unwrap();
        url.set_port(Some(port)).unwrap();
        url.to_string()
    }

    /// An attach must not wait for one database round trip after another: with the database 100 ms away it
    /// answers after about one, however many statements its bookkeeping takes afterwards.
    #[tokio::test]
    async fn attaches_within_one_database_round_trip() {
        const RTT: std::time::Duration = std::time::Duration::from_millis(100);
        let Some(direct) = crate::store::test_database_url().await else {
            return;
        };
        crate::install_crypto_provider();
        crate::store::Store::open(&direct).await.unwrap();
        let store = crate::store::Store::connect(&distant_database(&direct, RTT).await, 8).unwrap();
        // Open the pool's connections first, so the measurement has no handshakes in it.
        let warm: Vec<_> = (0..4).map(|_| store.meta("warm")).collect();
        futures_util::future::join_all(warm).await;
        let (clock, _now) = Clock::manual(T0);
        let (analytics, _events) = Analytics::channel(clock.clone());
        let service = Service::new(
            "opentunnel.test".into(),
            store.clone(),
            clock.clone(),
            analytics,
        );
        service.set_cluster(Arc::new(test_cluster(clock)));
        let harness = Harness {
            service,
            now: Arc::new(AtomicU64::new(T0)),
            events: mpsc::channel(1).1,
        };
        harness.tunnel(T0 + 80 * DAY_MS, Some(T0 - DAY_MS)).await;
        store
            .set_alarm("abcdefghijkl", Some(T0 + 50 * DAY_MS))
            .await
            .unwrap();
        // The first attach on connections that have not prepared any statement, then another.
        for attempt in ["first", "second"] {
            let (bridge, _rx) = harness.bridge().await;
            let started = std::time::Instant::now();
            let attached = harness
                .service
                .attach("abcdefghijkl", &bridge, "token", vec!["@".into()], None)
                .await
                .unwrap();
            let elapsed = started.elapsed();
            eprintln!(
                "{attempt} attach answered after {elapsed:?} with a {RTT:?} database round trip"
            );
            assert!(elapsed < RTT * 2, "{attempt} attach took {elapsed:?}");
            let Attach::Attached { followup, .. } = attached else {
                panic!("not attached");
            };
            // The bookkeeping afterwards runs its statements side by side.
            let started = std::time::Instant::now();
            harness
                .service
                .after_attach("abcdefghijkl", &bridge, followup)
                .await;
            let elapsed = started.elapsed();
            eprintln!("{attempt} attach bookkeeping took {elapsed:?}");
            assert!(elapsed < RTT * 4, "{attempt} bookkeeping took {elapsed:?}");
            // Announced to the mesh, without the database.
            let mesh = &harness.service.cluster().unwrap().mesh;
            assert_eq!(mesh.table_sizes()[0].1, 1);
            // Closing does not wait for the database at all.
            let started = std::time::Instant::now();
            harness
                .service
                .bridge_closed("abcdefghijkl", &bridge, 1000, true)
                .await
                .unwrap();
            assert!(
                started.elapsed() < RTT,
                "closing took {:?}",
                started.elapsed()
            );
            assert_eq!(mesh.table_sizes()[0].1, 0);
        }
        assert!(harness.record().await.last_connected_at.is_some());
    }
}
