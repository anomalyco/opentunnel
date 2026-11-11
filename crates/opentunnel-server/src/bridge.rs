//! One bridge WebSocket session: attach, heartbeats, and connection data, per `docs/protocol.md`.

use std::collections::HashSet;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures_util::FutureExt;
use opentunnel::protocol::bridge::{CONN_ID_SIZE, HEARTBEAT_MS, IDLE_TIMEOUT_MS, MAX_PAYLOAD_SIZE};
use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc};
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, warn};

use crate::analytics::ClientInfo;
use crate::service::{Attach, Bridge, ChannelHandle, Inbound, Outbound, Outcome, Service};
use crate::websocket::{self, Message};

/// The client must attach within this long after the upgrade.
pub const ATTACH_TIMEOUT: Duration = Duration::from_secs(10);
/// The largest message before attach: an attach with every route it may claim fits many times over.
pub const MAX_MESSAGE: usize = 64 * 1024;
/// The largest message once attached: a data frame with the protocol's largest payload. Both clients send at
/// most that; larger messages close the bridge with 1009.
pub const MAX_FRAME: usize = CONN_ID_SIZE + MAX_PAYLOAD_SIZE;
/// Routes one attach may claim.
pub const MAX_ROUTES: usize = 128;
/// Bytes from the client one public connection may have waiting for its visitor.
pub const CHANNEL_BUDGET: usize = 512 * 1024;
/// Bytes from the client all of one bridge's connections may have waiting for their visitors.
pub const BRIDGE_BUDGET: usize = 4 * 1024 * 1024;
/// Bytes from visitors one bridge may have waiting for its socket. Visitor reads wait beyond it.
pub const OUTBOUND_BUDGET: usize = 1024 * 1024;
/// Messages queued for one bridge's socket.
const OUTBOUND_QUEUE: usize = 256;
/// A bridge whose socket accepts nothing for this long is closed.
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);
/// The longest the bridge reader waits for visitors to take data (over budget, it stops reading: backpressure on
/// the client), before it resets those that took nothing for this long and the one it waited for.
const STALL: Duration = Duration::from_secs(5);
/// While the reader waits, how often it checks whether the client heard from the server lately.
const KEEPALIVE_CHECK: Duration = Duration::from_secs(1);
/// A visitor that acknowledged this many bytes since the last check is reading, however slowly its writes
/// complete (`relay::write_watched`).
pub const PROGRESS: usize = 64 * 1024;

/// Milliseconds on a monotonic clock, for comparing times across tasks.
pub fn ticks() -> u64 {
    static BASE: OnceLock<Instant> = OnceLock::new();
    BASE.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// A share of the budgets for bytes held in memory, given back when dropped (once the bytes were written).
#[derive(Debug)]
pub struct Held {
    _local: OwnedSemaphorePermit,
    _bridge: Option<OwnedSemaphorePermit>,
    _global: OwnedSemaphorePermit,
    /// The connection's `drained_at`, for data from the client.
    drained_at: Option<Arc<AtomicU64>>,
}

impl Held {
    /// The connection's `drained_at`, for data from the client.
    pub fn drained_at(&self) -> Option<&AtomicU64> {
        self.drained_at.as_deref()
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        if let Some(drained_at) = &self.drained_at {
            drained_at.store(ticks(), Ordering::Relaxed);
        }
    }
}

fn permits(len: usize) -> u32 {
    u32::try_from(len).expect("frames are smaller than 4 GiB")
}

/// Takes a visitor's share of the bridge's outbound budget and the machine's, waiting while either is spent.
pub async fn hold_outbound(bridge: &Bridge, len: usize) -> Option<Held> {
    let permits = permits(len);
    let local = bridge
        .outbound_budget
        .clone()
        .acquire_many_owned(permits)
        .await
        .ok()?;
    let global = bridge
        .buffer
        .clone()
        .acquire_many_owned(permits)
        .await
        .ok()?;
    Some(Held {
        _local: local,
        _bridge: None,
        _global: global,
        drained_at: None,
    })
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerControl<'a> {
    Attached {
        session: &'a str,
        routes: &'a [String],
        heartbeat_ms: u64,
        idle_timeout_ms: u64,
    },
    AttachError {
        code: &'a str,
    },
    Open {
        conn: u32,
        peer: &'a str,
        sni: &'a str,
        alpn: &'a str,
    },
    Ping {
        time_sent: u64,
    },
    Pong {
        time_sent: &'a Value,
    },
    End {
        conn: u32,
    },
    Reset {
        conn: u32,
        code: &'a str,
    },
}

impl ServerControl<'_> {
    pub fn message(&self) -> Outbound {
        Outbound::Text(serde_json::to_string(self).expect("control messages serialize"))
    }
}

pub fn data_frame(conn: u32, payload: &[u8]) -> Outbound {
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&conn.to_be_bytes());
    frame.extend_from_slice(payload);
    Outbound::Binary(Bytes::from(frame))
}

/// A data frame for a visitor's data, holding its budget until written.
pub fn data_message(conn: u32, payload: &[u8], held: Held) -> Outbound {
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&conn.to_be_bytes());
    frame.extend_from_slice(payload);
    Outbound::Data(Bytes::from(frame), held)
}

/// Runs a bridge session on an upgraded socket until it closes.
pub async fn run<R, W>(
    service: Service,
    tunnel_id: String,
    reader: websocket::Reader<R>,
    writer: websocket::Writer<W>,
    client: ClientInfo,
) where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (tx, rx) = mpsc::channel(OUTBOUND_QUEUE);
    let bridge = match Box::pin(service.register_bridge(&tunnel_id, tx, client)).await {
        Ok(Some(bridge)) => bridge,
        Ok(None) => return,
        Err(error) => {
            warn!(%error, tunnel = %tunnel_id, "failed to register a bridge");
            return;
        }
    };
    let cancel = bridge.cancel.clone();
    let mut writer = tokio::spawn(write(writer, rx, cancel.clone(), bridge.sent_at.clone()));
    let mut followup = None;
    // A panic while reading must still clean up below: otherwise the bridge stays registered and its writer
    // keeps the socket open forever.
    let (code, clean) =
        AssertUnwindSafe(read(&service, &tunnel_id, &bridge, reader, &mut followup))
            .catch_unwind()
            .await
            .unwrap_or_else(|_| {
                error!(tunnel = %tunnel_id, "bridge reader panicked");
                bridge.close(1011, "internal error");
                (1011, false)
            });
    // Cleaned up at once, even while the attach's bookkeeping still waits for the database (it skips a bridge
    // that is gone): a reconnecting client's new bridge would otherwise conflict with this one for its routes.
    if let Err(error) = Box::pin(service.bridge_closed(&tunnel_id, &bridge, code, clean)).await {
        warn!(%error, tunnel = %tunnel_id, "failed to clean up a bridge");
    }
    drop(bridge);
    // Let a queued close go out before the socket drops. The queue only ends once every holder of the bridge
    // is gone, so the writer is then told to stop: otherwise it would keep the socket forever.
    if tokio::time::timeout(Duration::from_secs(1), &mut writer)
        .await
        .is_err()
    {
        cancel.cancel();
    }
    if let Some(followup) = followup {
        let _ = followup.await;
    }
}

async fn write<W>(
    mut writer: websocket::Writer<W>,
    mut rx: mpsc::Receiver<Outbound>,
    cancel: CancellationToken,
    sent_at: Arc<AtomicU64>,
) where
    W: AsyncWrite + Unpin,
{
    loop {
        let message = tokio::select! {
            message = rx.recv() => message,
            _ = cancel.cancelled() => None,
        };
        let Some(message) = message else {
            // The session is over and the server sent no close: close the WebSocket, then the stream.
            let _ = tokio::time::timeout(Duration::from_secs(1), async {
                writer.close(None).await?;
                writer.shutdown().await
            })
            .await;
            return;
        };
        let last = matches!(message, Outbound::Close(..));
        let sent = tokio::time::timeout(WRITE_TIMEOUT, async {
            match &message {
                Outbound::Text(text) => writer.text(text).await,
                Outbound::Binary(data) | Outbound::Data(data, _) => writer.binary(data).await,
                Outbound::Pong(data) => writer.pong(data).await,
                Outbound::Close(code, reason) => writer.close(Some((*code, reason))).await,
            }
        })
        .await;
        drop(message);
        match sent {
            Ok(Ok(())) if !last => sent_at.store(ticks(), Ordering::Relaxed),
            Ok(Ok(())) => return,
            Ok(Err(error)) => {
                debug!(%error, "bridge write failed");
                cancel.cancel();
                return;
            }
            Err(_) => {
                warn!("bridge write timed out");
                cancel.cancel();
                return;
            }
        }
    }
}

/// Reads until the session ends. Returns the close code and whether the close handshake completed.
async fn read<R>(
    service: &Service,
    tunnel_id: &str,
    bridge: &Arc<Bridge>,
    mut reader: websocket::Reader<R>,
    followup: &mut Option<tokio::task::JoinHandle<()>>,
) -> (u16, bool)
where
    R: AsyncRead + Unpin,
{
    reader.set_max_message(MAX_MESSAGE);
    let attach_deadline = tokio::time::sleep(ATTACH_TIMEOUT);
    tokio::pin!(attach_deadline);
    let mut attached = false;
    let mut attach_expired = false;
    loop {
        let next = tokio::select! {
            next = reader.next() => next,
            _ = bridge.cancel.cancelled() => {
                return (bridge.snapshot().server_close.unwrap_or(1006), false);
            }
            _ = &mut attach_deadline, if !attached && !attach_expired => {
                attach_expired = true;
                bridge.close(1008, "attach timeout");
                continue;
            }
        };
        let message = match next {
            Ok(Some(message)) => message,
            Err(websocket::Error::TooLarge(what)) => {
                debug!(what, "bridge message too large");
                bridge.close(1009, "message too big");
                // The rest of the message is still arriving: read it away briefly, so the close is not lost to a
                // reset of a socket closed with unread data.
                reader.discard(Duration::from_secs(1)).await;
                return (1009, false);
            }
            Err(error) => {
                debug!(%error, "bridge read failed");
                return (1006, false);
            }
            Ok(None) => return (bridge.snapshot().server_close.unwrap_or(1006), false),
        };
        if let Message::Close(code) = message {
            return (code, true);
        }
        // Once the server has closed the session, only the client's close matters.
        if bridge.is_closing() {
            continue;
        }
        if let Message::Ping(data) = message {
            let _ = bridge.tx.try_send(Outbound::Pong(data));
            continue;
        }
        bridge.touch(service.now());
        match message {
            Message::Binary(frame) => {
                if !attached {
                    bridge.close(1008, "attach required");
                    continue;
                }
                data(bridge, frame).await;
            }
            Message::Text(text) => {
                // A `Value` (not a `Map`): indexing a missing key yields `Null` instead of panicking.
                let control: Option<Value> = serde_json::from_str(&text).ok();
                let Some(control) =
                    control.filter(|control| control.is_object() && control["type"].is_string())
                else {
                    bridge.close(1008, "invalid control");
                    continue;
                };
                if !attached {
                    *followup = Box::pin(attach(service, tunnel_id, bridge, &control)).await;
                    attached = followup.is_some();
                    if attached {
                        reader.set_max_message(MAX_FRAME);
                    }
                    continue;
                }
                handle_control(service, tunnel_id, bridge, &control).await;
            }
            Message::Close(_) | Message::Ping(_) | Message::Pong(_) => {}
        }
    }
}

async fn send(bridge: &Bridge, message: Outbound) {
    let _ = bridge.tx.send(message).await;
}

/// Handles the first control message. Once the bridge attached, returns the task doing the attach's
/// bookkeeping, which runs while the session goes on.
async fn attach(
    service: &Service,
    tunnel_id: &str,
    bridge: &Arc<Bridge>,
    control: &Value,
) -> Option<tokio::task::JoinHandle<()>> {
    let (Some("attach"), Some(token)) = (control["type"].as_str(), control["token"].as_str())
    else {
        bridge.close(1008, "attach required");
        return None;
    };
    let routes = match control.get("routes") {
        // Refused before anything else, the token included: no client claims this many.
        Some(Value::Array(routes)) if routes.len() > MAX_ROUTES => {
            crate::metrics::bridge_attach("too_many_routes");
            send(
                bridge,
                ServerControl::AttachError {
                    code: "too_many_routes",
                }
                .message(),
            )
            .await;
            bridge.close(1008, "too many routes");
            return None;
        }
        Some(Value::Array(routes)) => {
            let mut seen = HashSet::new();
            routes
                .iter()
                .filter_map(Value::as_str)
                .filter(|route| seen.insert(*route))
                .map(str::to_owned)
                .collect()
        }
        // Legacy clients attach the base hostname.
        _ => vec!["@".to_owned()],
    };
    let max_conns = control
        .get("client")
        .and_then(|client| client.get("max_conns"))
        .and_then(Value::as_u64);
    match service
        .attach(tunnel_id, bridge, token, routes, max_conns)
        .await
    {
        Ok(Attach::Attached {
            session,
            routes,
            followup,
        }) => {
            crate::metrics::bridge_attach("ok");
            send(
                bridge,
                ServerControl::Attached {
                    session: &session,
                    routes: &routes,
                    heartbeat_ms: HEARTBEAT_MS,
                    idle_timeout_ms: IDLE_TIMEOUT_MS,
                }
                .message(),
            )
            .await;
            let service = service.clone();
            let tunnel_id = tunnel_id.to_owned();
            let bridge = bridge.clone();
            Some(tokio::spawn(async move {
                service.after_attach(&tunnel_id, &bridge, followup).await;
            }))
        }
        Ok(Attach::Error(code, reason)) => {
            crate::metrics::bridge_attach(code);
            send(bridge, ServerControl::AttachError { code }.message()).await;
            bridge.close(1008, reason);
            None
        }
        Err(error) => {
            crate::metrics::bridge_attach("error");
            warn!(%error, tunnel = %tunnel_id, "attach failed");
            bridge.close(1011, "internal error");
            None
        }
    }
}

async fn handle_control(service: &Service, tunnel_id: &str, bridge: &Arc<Bridge>, control: &Value) {
    match control["type"].as_str() {
        Some("ping") if control["time_sent"].is_number() => {
            send(
                bridge,
                ServerControl::Pong {
                    time_sent: &control["time_sent"],
                }
                .message(),
            )
            .await;
            service.report_active(tunnel_id, bridge);
        }
        Some(kind @ ("end" | "reset")) => {
            let Some(conn) = control["conn"]
                .as_u64()
                .and_then(|conn| u32::try_from(conn).ok())
            else {
                return;
            };
            let channel = bridge.channels.lock().expect("channels lock").remove(&conn);
            let Some(channel) = channel else { return };
            if kind == "reset" {
                channel.finish.finish(Outcome::Reset, true);
            } else {
                channel.finish.finish(Outcome::Closed, false);
                // Queued after the data, so the visitor gets everything before the half-close.
                let _ = channel.inbound.send(Inbound::End);
            }
        }
        _ => {}
    }
}

async fn data(bridge: &Arc<Bridge>, frame: Bytes) {
    if frame.len() < 4 {
        return;
    }
    let conn = u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]);
    let channel = bridge
        .channels
        .lock()
        .expect("channels lock")
        .get(&conn)
        .cloned();
    let Some(channel) = channel else { return };
    let payload = frame.slice(4..);
    channel
        .bytes_out
        .fetch_add(payload.len() as u64, Ordering::Relaxed);
    let Some(held) = hold_inbound(bridge, conn, &channel, payload.len()).await else {
        return;
    };
    // Unbounded in messages, bounded in bytes by `held`. A visitor that is gone drops the data and its share.
    let _ = channel.inbound.send(Inbound::Data(payload, held));
}

/// Takes the share of the connection's, the bridge's and the machine's budget for data from the client. Over
/// budget, the reader waits (the client's socket backs up) until visitors take data, but never longer than
/// `STALL`: then it resets every connection of the bridge whose visitor took nothing (less than `PROGRESS` bytes)
/// in that time, and this one if its data still does not fit. `None`: the data is dropped, its connection reset.
///
/// The bound matters beyond this bridge's visitors: a client whose bridge the server stops reading fills its own
/// send queue, and released clients then stop reading the bridge too (their read loop waits to queue a ping or a
/// pong), until the server's write timeout closes the bridge.
async fn hold_inbound(
    bridge: &Arc<Bridge>,
    conn: u32,
    channel: &ChannelHandle,
    len: usize,
) -> Option<Held> {
    let permits = permits(len);
    let empty = channel.budget.available_permits() == CHANNEL_BUDGET;
    let try_hold = || {
        let local = channel
            .budget
            .clone()
            .try_acquire_many_owned(permits)
            .ok()?;
        let shared = bridge
            .inbound_budget
            .clone()
            .try_acquire_many_owned(permits)
            .ok()?;
        let global = bridge.buffer.clone().try_acquire_many_owned(permits).ok()?;
        Some(held(channel, empty, local, shared, global))
    };
    if let Some(held) = try_hold() {
        return Some(held);
    }
    if empty {
        // Data starts waiting for this visitor now.
        channel.drained_at.store(ticks(), Ordering::Relaxed);
    }
    // Boxed so it can be dropped, giving back what it took, before trying once more.
    let mut waiting = Box::pin(async {
        let local = acquire(&channel.budget, permits).await?;
        let shared = acquire(&bridge.inbound_budget, permits).await?;
        let global = acquire(&bridge.buffer, permits).await?;
        Some(held(channel, false, local, shared, global))
    });
    let deadline = tokio::time::sleep(STALL);
    tokio::pin!(deadline);
    let mut keepalive = tokio::time::interval(KEEPALIVE_CHECK);
    loop {
        tokio::select! {
            held = &mut waiting => return held,
            () = &mut deadline => break,
            _ = keepalive.tick() => keep_alive(bridge),
            () = bridge.cancel.cancelled() => return None,
        }
    }
    drop(waiting);
    crate::metrics::bridge_backpressure("stall");
    reset_stalled(bridge).await;
    if !bridge
        .channels
        .lock()
        .expect("channels lock")
        .contains_key(&conn)
    {
        return None;
    }
    // The space others gave back may fit it; otherwise this visitor is too slow to wait for.
    if let Some(held) = try_hold() {
        return Some(held);
    }
    reset(bridge, conn, channel).await;
    None
}

async fn acquire(budget: &Arc<Semaphore>, permits: u32) -> Option<OwnedSemaphorePermit> {
    budget.clone().acquire_many_owned(permits).await.ok()
}

fn held(
    channel: &ChannelHandle,
    empty: bool,
    local: OwnedSemaphorePermit,
    shared: OwnedSemaphorePermit,
    global: OwnedSemaphorePermit,
) -> Held {
    if empty {
        // Data starts waiting for this visitor now.
        channel.drained_at.store(ticks(), Ordering::Relaxed);
    }
    Held {
        _local: local,
        _bridge: Some(shared),
        _global: global,
        drained_at: Some(channel.drained_at.clone()),
    }
}

/// While the reader waits on visitors, the client may hear nothing (its pongs wait behind its data): a ping
/// from the server keeps it from deciding the bridge is dead.
fn keep_alive(bridge: &Bridge) {
    let now = ticks();
    if now.saturating_sub(bridge.sent_at.load(Ordering::Relaxed)) < HEARTBEAT_MS {
        return;
    }
    bridge.sent_at.store(now, Ordering::Relaxed);
    let time_sent = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64);
    let _ = bridge
        .tx
        .try_send(ServerControl::Ping { time_sent }.message());
}

/// Resets every connection whose visitor has data waiting and took none (less than `PROGRESS` bytes) for
/// `STALL`.
async fn reset_stalled(bridge: &Bridge) {
    let now = ticks();
    let stall = STALL.as_millis() as u64;
    let stalled: Vec<(u32, ChannelHandle)> = bridge
        .channels
        .lock()
        .expect("channels lock")
        .iter()
        .filter(|(_, channel)| {
            channel.budget.available_permits() < CHANNEL_BUDGET
                && now.saturating_sub(channel.drained_at.load(Ordering::Relaxed)) >= stall
        })
        .map(|(conn, channel)| (*conn, channel.clone()))
        .collect();
    for (conn, channel) in stalled {
        reset(bridge, conn, &channel).await;
    }
}

/// Resets one connection whose visitor does not keep up: a visitor that stops reading would otherwise hold
/// memory and the bridge.
async fn reset(bridge: &Bridge, conn: u32, channel: &ChannelHandle) {
    crate::metrics::bridge_backpressure("reset");
    bridge.channels.lock().expect("channels lock").remove(&conn);
    channel.finish.finish(Outcome::Backpressure, true);
    send(
        bridge,
        ServerControl::Reset {
            conn,
            code: "client_io_error",
        }
        .message(),
    )
    .await;
}
