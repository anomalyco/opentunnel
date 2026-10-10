//! One bridge WebSocket session: attach, heartbeats, and connection data, per `docs/protocol.md`.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use opentunnel::protocol::bridge::{HEARTBEAT_MS, IDLE_TIMEOUT_MS};
use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tracing::{debug, warn};

use crate::analytics::ClientInfo;
use crate::service::{Attach, Bridge, Inbound, Outbound, Outcome, Service};

/// The client must attach within this long after the upgrade.
pub const ATTACH_TIMEOUT: Duration = Duration::from_secs(10);
/// Messages queued for one bridge's socket. Visitor uploads wait when it is full, which is the backpressure.
const OUTBOUND_QUEUE: usize = 256;
/// A bridge whose socket accepts nothing for this long is closed.
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);
/// How long the bridge reader waits for one visitor to take data before resetting that connection.
const STALLED_CHANNEL_TIMEOUT: Duration = Duration::from_secs(30);

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

/// Runs a bridge session on an upgraded socket until it closes.
pub async fn run<S>(service: Service, tunnel_id: String, socket: WebSocketStream<S>, client: ClientInfo)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (tx, rx) = mpsc::channel(OUTBOUND_QUEUE);
    let bridge = match service.register_bridge(&tunnel_id, tx, client).await {
        Ok(Some(bridge)) => bridge,
        Ok(None) => return,
        Err(error) => {
            warn!(%error, tunnel = %tunnel_id, "failed to register a bridge");
            return;
        }
    };
    let (sink, stream) = socket.split();
    let writer = tokio::spawn(write(sink, rx, bridge.clone()));
    let (code, clean) = read(&service, &tunnel_id, &bridge, stream).await;
    if let Err(error) = service.bridge_closed(&tunnel_id, &bridge, code, clean).await {
        warn!(%error, tunnel = %tunnel_id, "failed to clean up a bridge");
    }
    // Let a queued close go out before the socket drops.
    let _ = tokio::time::timeout(Duration::from_secs(1), async {
        drop(bridge);
        writer.await
    })
    .await;
}

async fn write<S>(
    mut sink: futures_util::stream::SplitSink<WebSocketStream<S>, Message>,
    mut rx: mpsc::Receiver<Outbound>,
    bridge: Arc<Bridge>,
) where
    S: AsyncRead + AsyncWrite + Unpin,
{
    loop {
        let message = tokio::select! {
            message = rx.recv() => message,
            _ = bridge.cancel.cancelled() => None,
        };
        let Some(message) = message else {
            let _ = tokio::time::timeout(Duration::from_secs(1), sink.close()).await;
            return;
        };
        let (message, last) = match message {
            Outbound::Text(text) => (Message::text(text), false),
            Outbound::Binary(data) => (Message::Binary(data), false),
            Outbound::Close(code, reason) => (
                Message::Close(Some(CloseFrame {
                    code: CloseCode::from(code),
                    reason: reason.into(),
                })),
                true,
            ),
        };
        match tokio::time::timeout(WRITE_TIMEOUT, sink.send(message)).await {
            Ok(Ok(())) if !last => {}
            Ok(Ok(())) => return,
            Ok(Err(error)) => {
                debug!(%error, "bridge write failed");
                bridge.cancel.cancel();
                return;
            }
            Err(_) => {
                warn!("bridge write timed out");
                bridge.cancel.cancel();
                return;
            }
        }
    }
}

/// Reads until the session ends. Returns the close code and whether the close handshake completed.
async fn read<S>(
    service: &Service,
    tunnel_id: &str,
    bridge: &Arc<Bridge>,
    mut stream: futures_util::stream::SplitStream<WebSocketStream<S>>,
) -> (u16, bool)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let attach_deadline = tokio::time::sleep(ATTACH_TIMEOUT);
    tokio::pin!(attach_deadline);
    let mut attached = false;
    let mut attach_expired = false;
    loop {
        let next = tokio::select! {
            next = stream.next() => next,
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
            Some(Ok(message)) => message,
            Some(Err(error)) => {
                debug!(%error, "bridge read failed");
                return (1006, false);
            }
            None => return (bridge.snapshot().server_close.unwrap_or(1006), false),
        };
        if let Message::Close(frame) = &message {
            let code = frame.as_ref().map_or(1005, |frame| u16::from(frame.code));
            return (code, true);
        }
        // Once the server has closed the session, only the client's close matters.
        if bridge.is_closing() {
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
                let control: Option<serde_json::Map<String, Value>> =
                    serde_json::from_str(text.as_str()).ok();
                let Some(control) = control.filter(|control| control["type"].is_string()) else {
                    bridge.close(1008, "invalid control");
                    continue;
                };
                if !attached {
                    attached = attach(service, tunnel_id, bridge, &control).await;
                    continue;
                }
                handle_control(service, tunnel_id, bridge, &control).await;
            }
            Message::Close(_) | Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => {}
        }
    }
}

async fn send(bridge: &Bridge, message: Outbound) {
    let _ = bridge.tx.send(message).await;
}

/// Handles the first control message. Returns whether the bridge attached.
async fn attach(
    service: &Service,
    tunnel_id: &str,
    bridge: &Arc<Bridge>,
    control: &serde_json::Map<String, Value>,
) -> bool {
    let (Some("attach"), Some(token)) = (control["type"].as_str(), control["token"].as_str())
    else {
        bridge.close(1008, "attach required");
        return false;
    };
    let routes = match control.get("routes") {
        Some(Value::Array(routes)) => {
            let mut unique: Vec<String> = Vec::new();
            for route in routes.iter().filter_map(Value::as_str) {
                if !unique.iter().any(|existing| existing == route) {
                    unique.push(route.to_owned());
                }
            }
            unique
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
        Ok(Attach::Attached { session, routes }) => {
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
            true
        }
        Ok(Attach::Error(code, reason)) => {
            send(bridge, ServerControl::AttachError { code }.message()).await;
            bridge.close(1008, reason);
            false
        }
        Err(error) => {
            warn!(%error, tunnel = %tunnel_id, "attach failed");
            bridge.close(1011, "internal error");
            false
        }
    }
}

async fn handle_control(
    service: &Service,
    tunnel_id: &str,
    bridge: &Arc<Bridge>,
    control: &serde_json::Map<String, Value>,
) {
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
            let Some(conn) = control["conn"].as_u64().and_then(|conn| u32::try_from(conn).ok())
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
                let inbound = channel.inbound.clone();
                tokio::spawn(async move {
                    let _ = tokio::time::timeout(STALLED_CHANNEL_TIMEOUT, inbound.send(Inbound::End))
                        .await;
                });
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
    let sent = match channel.inbound.try_send(Inbound::Data(payload)) {
        Ok(()) => true,
        Err(mpsc::error::TrySendError::Closed(_)) => true,
        Err(mpsc::error::TrySendError::Full(Inbound::Data(payload))) => {
            tokio::time::timeout(STALLED_CHANNEL_TIMEOUT, channel.inbound.send(Inbound::Data(payload)))
                .await
                .is_ok()
        }
        Err(mpsc::error::TrySendError::Full(Inbound::End)) => true,
    };
    if !sent {
        // A visitor that stops reading would otherwise stall every connection sharing this bridge.
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
}
