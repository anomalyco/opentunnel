//! A running tunnel: one bridge session at a time, reconnecting with backoff.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::protocol::bridge::{
    self, ClientInfo, ClientMessage, ConnId, ServerMessage, Transport, codes,
};
use crate::protocol::names::{parse_target, route_for_sni};
use futures_util::{SinkExt, StreamExt};
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, PrivateKeyDer};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{broadcast, mpsc, watch};
use tokio::task::{JoinHandle, JoinSet};
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::{Bytes, Message};
use tracing::{debug, warn};

use crate::api::Api;
use crate::error::{Error, Result};
use crate::identity::Identity;
use crate::protocol::api::CertificateState;
use crate::storage::Storage;

/// Route name (`@` or a subdomain label) to `host:port` target.
pub type Routes = BTreeMap<String, String>;

const MAX_CONNS: u32 = 256;
/// Frames queued for the WebSocket before local sockets stop being read.
const OUTBOUND_QUEUE: usize = 256;
/// Frames queued per public connection before the bridge reader waits.
const INBOUND_QUEUE: usize = 64;
const DUPLEX_BUFFER: usize = 64 * 1024;
/// How long the bridge reader waits for a full connection before resetting it.
const STALLED_CHANNEL_TIMEOUT: Duration = Duration::from_secs(30);
/// How often to check for a renewed certificate: rarely while the current one
/// is fresh, every minute once renewal is due (it completes within minutes).
const CERTIFICATE_CHECK_FRESH: Duration = Duration::from_secs(12 * 60 * 60);
const CERTIFICATE_CHECK_DUE: Duration = Duration::from_secs(60);
const RENEWAL_WINDOW: Duration = Duration::from_secs(30 * 24 * 60 * 60);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Event {
    Connecting {
        attempt: u32,
    },
    Connected {
        session: String,
        routes: Vec<String>,
    },
    Disconnected {
        reason: String,
    },
    Reconnecting {
        attempt: u32,
        delay_ms: u64,
    },
    ConnectionOpened {
        conn: ConnId,
        route: String,
        peer: String,
    },
    ConnectionClosed {
        conn: ConnId,
        route: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    CertificateRenewed {
        expiry: String,
    },
    Stopped {
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum State {
    WaitingRoutes,
    Connecting,
    Connected,
    Reconnecting,
    Stopped,
}

#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub state: State,
    pub hostname: String,
    pub routes: Routes,
    pub session: Option<String>,
    pub connections: usize,
    pub last_error: Option<String>,
    /// Unix milliseconds of the last successful attach.
    pub connected_at: Option<u64>,
}

/// Handle to a running tunnel. Dropping it stops the tunnel.
pub struct Tunnel {
    routes: watch::Sender<Routes>,
    shutdown: watch::Sender<bool>,
    events: broadcast::Sender<Event>,
    status: watch::Receiver<Status>,
    task: Option<JoinHandle<Result<()>>>,
}

impl Tunnel {
    /// Starts a tunnel. Renewed certificates are saved to `storage` under
    /// `profile` when given.
    pub(crate) fn start(
        api: Api,
        identity: Identity,
        routes: Routes,
        storage: Option<(Storage, String)>,
    ) -> Result<Self> {
        for (name, target) in &routes {
            validate_route(name, target)?;
        }
        let acceptor = Arc::new(RwLock::new(acceptor(&identity)?));
        let (routes_tx, routes_rx) = watch::channel(routes.clone());
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let (events, _) = broadcast::channel(1024);
        let (status_tx, status_rx) = watch::channel(Status {
            state: State::Connecting,
            hostname: identity.hostname.clone(),
            routes,
            session: None,
            connections: 0,
            last_error: None,
            connected_at: None,
        });
        tokio::spawn(refresh_certificate(
            api.clone(),
            identity.clone(),
            acceptor.clone(),
            storage,
            shutdown_rx.clone(),
            events.clone(),
        ));
        let supervisor = Supervisor {
            api,
            identity: Arc::new(identity),
            acceptor,
            routes: routes_rx,
            shutdown: shutdown_rx,
            events: events.clone(),
            status: status_tx,
        };
        Ok(Self {
            routes: routes_tx,
            shutdown: shutdown_tx,
            events,
            status: status_rx,
            task: Some(tokio::spawn(supervisor.run())),
        })
    }

    /// Replaces the routes. Changing only targets applies to new connections
    /// immediately; adding or removing names re-attaches the bridge.
    pub fn set_routes(&self, routes: Routes) -> Result<()> {
        for (name, target) in &routes {
            validate_route(name, target)?;
        }
        self.routes.send_replace(routes);
        Ok(())
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }

    pub fn status(&self) -> Status {
        self.status.borrow().clone()
    }

    pub fn status_watch(&self) -> watch::Receiver<Status> {
        self.status.clone()
    }

    /// Waits until the tunnel stops on its own after a fatal error.
    pub async fn wait(&mut self) -> Result<()> {
        match self.task.take() {
            Some(task) => task
                .await
                .map_err(|error| Error::Bridge(error.to_string()))?,
            None => Ok(()),
        }
    }

    pub async fn close(mut self) -> Result<()> {
        self.shutdown.send_replace(true);
        self.wait().await
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.shutdown.send_replace(true);
    }
}

fn validate_route(name: &str, target: &str) -> Result<()> {
    if !crate::protocol::names::is_valid_route(name) {
        return Err(Error::Invalid(format!("invalid route name '{name}'")));
    }
    if parse_target(target).is_none() {
        return Err(Error::Invalid(format!(
            "invalid target '{target}' for route '{name}': use host:port"
        )));
    }
    Ok(())
}

fn acceptor(identity: &Identity) -> Result<TlsAcceptor> {
    let crypto = |error: &dyn std::fmt::Display| Error::Crypto(error.to_string());
    let chain = format!("{}\n{}", identity.certificate, identity.chain);
    let certificates = CertificateDer::pem_slice_iter(chain.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| crypto(&error))?;
    let key = PrivateKeyDer::from_pem_slice(identity.private_key.as_bytes())
        .map_err(|error| crypto(&error))?;
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|error| crypto(&error))?
    .with_no_client_auth()
    .with_single_cert(certificates, key)
    .map_err(|error| crypto(&error))?;
    Ok(TlsAcceptor::from(Arc::new(config)))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn backoff(attempt: u32) -> Duration {
    let base = bridge::RECONNECT_BACKOFF_MIN_MS
        .saturating_mul(1 << attempt.min(16))
        .min(bridge::RECONNECT_BACKOFF_MAX_MS);
    Duration::from_millis(rand::random_range(base / 2..=base))
}

/// Periodically fetches the server's current certificate and, when the server
/// has renewed it, uses it for new connections and saves it.
async fn refresh_certificate(
    api: Api,
    mut identity: Identity,
    acceptor: Arc<RwLock<TlsAcceptor>>,
    storage: Option<(Storage, String)>,
    mut shutdown: watch::Receiver<bool>,
    events: broadcast::Sender<Event>,
) {
    let mut first = true;
    loop {
        if !std::mem::take(&mut first) {
            let wait = if renewal_due(&identity.certificate_expiry) {
                CERTIFICATE_CHECK_DUE
            } else {
                CERTIFICATE_CHECK_FRESH
            };
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = shutdown.changed() => return,
            }
        }
        let Ok(info) = api.certificate(&identity.token, &identity.id).await else {
            continue;
        };
        let CertificateState::Ready {
            certificate,
            chain,
            expiry,
        } = info.state
        else {
            continue;
        };
        if certificate == identity.certificate {
            continue;
        }
        let renewed = Identity {
            certificate,
            chain,
            certificate_expiry: expiry.clone(),
            ..identity.clone()
        };
        match self::acceptor(&renewed) {
            Ok(next) => *acceptor.write().expect("acceptor lock") = next,
            Err(error) => {
                warn!(%error, "ignoring renewed certificate that does not match the key");
                continue;
            }
        }
        if let Some((storage, profile)) = &storage
            && let Err(error) = storage.save(profile, &renewed)
        {
            warn!(%error, "failed to save renewed certificate");
        }
        identity = renewed;
        let _ = events.send(Event::CertificateRenewed { expiry });
    }
}

/// Whether a certificate expiring at `expiry` (ISO-8601) is inside the renewal window.
fn renewal_due(expiry: &str) -> bool {
    humantime::parse_rfc3339_weak(expiry)
        .ok()
        .and_then(|expiry| expiry.duration_since(SystemTime::now()).ok())
        .is_none_or(|remaining| remaining < RENEWAL_WINDOW)
}

#[cfg(test)]
mod tests {
    #[test]
    fn renewal_due() {
        assert!(!super::renewal_due("2099-01-04T23:59:59.000Z"));
        assert!(super::renewal_due("2020-01-04T23:59:59.000Z"));
        assert!(super::renewal_due("not a date"));
    }
}

struct Supervisor {
    api: Api,
    identity: Arc<Identity>,
    acceptor: Arc<RwLock<TlsAcceptor>>,
    routes: watch::Receiver<Routes>,
    shutdown: watch::Receiver<bool>,
    events: broadcast::Sender<Event>,
    status: watch::Sender<Status>,
}

enum SessionEnd {
    Shutdown,
    RoutesChanged,
    Fatal(Error),
    Retry { error: String, attached: bool },
}

impl Supervisor {
    fn emit(&self, event: Event) {
        let _ = self.events.send(event);
    }

    async fn run(mut self) -> Result<()> {
        let mut attempt = 0u32;
        let result = loop {
            if *self.shutdown.borrow() {
                break Ok(());
            }
            if self.routes.borrow_and_update().is_empty() {
                self.status.send_modify(|status| {
                    status.state = State::WaitingRoutes;
                    status.routes.clear();
                });
                tokio::select! {
                    _ = self.shutdown.changed() => {}
                    _ = self.routes.changed() => {}
                }
                continue;
            }

            self.status
                .send_modify(|status| status.state = State::Connecting);
            self.emit(Event::Connecting { attempt });
            let end = self.session().await;
            self.status.send_modify(|status| {
                status.session = None;
                status.connections = 0;
            });
            match end {
                SessionEnd::Shutdown => break Ok(()),
                SessionEnd::RoutesChanged => {
                    self.emit(Event::Disconnected {
                        reason: "routes changed".into(),
                    });
                    attempt = 0;
                }
                SessionEnd::Fatal(error) => break Err(error),
                SessionEnd::Retry { error, attached } => {
                    if attached {
                        attempt = 0;
                    }
                    warn!(%error, "bridge session ended");
                    self.emit(Event::Disconnected {
                        reason: error.clone(),
                    });
                    let delay = backoff(attempt);
                    attempt = attempt.saturating_add(1);
                    self.status.send_modify(|status| {
                        status.state = State::Reconnecting;
                        status.last_error = Some(error);
                    });
                    self.emit(Event::Reconnecting {
                        attempt,
                        delay_ms: delay.as_millis() as u64,
                    });
                    tokio::select! {
                        _ = tokio::time::sleep(delay) => {}
                        _ = self.shutdown.changed() => {}
                    }
                }
            }
        };
        let error = result.as_ref().err().map(ToString::to_string);
        self.status.send_modify(|status| {
            status.state = State::Stopped;
            if error.is_some() {
                status.last_error.clone_from(&error);
            }
        });
        self.emit(Event::Stopped { error });
        result
    }

    async fn session(&mut self) -> SessionEnd {
        let routes = self.routes.borrow_and_update().clone();
        let names: Vec<String> = routes.keys().cloned().collect();
        let mut shutdown = self.shutdown.clone();
        let connect = tokio::time::timeout(
            Duration::from_millis(bridge::CONNECT_TIMEOUT_MS),
            self.attach(&names),
        );
        let (socket, attached) = tokio::select! {
            result = connect => match result {
                Ok(Ok(value)) => value,
                Ok(Err(Error::Attach(code))) if codes::is_fatal_attach_error(&code) => {
                    return SessionEnd::Fatal(Error::Attach(code));
                }
                Ok(Err(error)) => return SessionEnd::Retry { error: error.to_string(), attached: false },
                Err(_) => return SessionEnd::Retry { error: "bridge attach timed out".into(), attached: false },
            },
            _ = shutdown.changed() => return SessionEnd::Shutdown,
        };
        let AttachedSession {
            session,
            heartbeat,
            idle_timeout,
        } = attached;

        self.status.send_modify(|status| {
            status.state = State::Connected;
            status.session = Some(session.clone());
            status.routes = routes.clone();
            status.last_error = None;
            status.connected_at = Some(now_ms());
        });
        self.emit(Event::Connected {
            session,
            routes: names.clone(),
        });

        let (mut sink, mut stream) = socket.split();
        let (outbound, mut outbound_rx) = mpsc::channel::<Message>(OUTBOUND_QUEUE);
        let writer = tokio::spawn(async move {
            while let Some(message) = outbound_rx.recv().await {
                if let Err(error) = sink.send(message).await {
                    return Err(error.to_string());
                }
            }
            let _ = sink.close().await;
            Ok(())
        });

        let targets = Arc::new(std::sync::RwLock::new(routes));
        let mut channels: HashMap<ConnId, Channel> = HashMap::new();
        let mut tasks: JoinSet<(ConnId, Option<String>)> = JoinSet::new();
        let mut heartbeat = tokio::time::interval(heartbeat);
        heartbeat.tick().await;
        let mut last_received = Instant::now();

        let end = loop {
            tokio::select! {
                message = stream.next() => {
                    last_received = Instant::now();
                    let message = match message {
                        Some(Ok(message)) => message,
                        Some(Err(error)) => break retry(error.to_string()),
                        None => break retry("bridge closed".into()),
                    };
                    match message {
                        Message::Binary(frame) => {
                            let Some((conn, payload)) = bridge::decode_data_frame(&frame) else { continue };
                            let Some(channel) = channels.get(&conn) else { continue };
                            let payload = Inbound::Data(Bytes::copy_from_slice(payload));
                            if tokio::time::timeout(STALLED_CHANNEL_TIMEOUT, channel.inbound.send(payload)).await.is_err() {
                                // A local socket that stops reading would otherwise stall every
                                // connection sharing this bridge.
                                let channel = channels.remove(&conn).expect("channel exists");
                                channel.abort.abort();
                                let _ = outbound.send(control(&ClientMessage::Reset {
                                    conn,
                                    code: codes::UPSTREAM_IO_ERROR.into(),
                                })).await;
                                self.status.send_modify(|status| status.connections = channels.len());
                                self.emit(Event::ConnectionClosed { conn, route: channel.route, error: Some("local connection stalled".into()) });
                            }
                        }
                        Message::Text(text) => {
                            let message = match ServerMessage::decode(&text) {
                                Ok(Some(message)) => message,
                                Ok(None) => continue,
                                Err(error) => {
                                    debug!(%error, "ignoring invalid control message");
                                    continue;
                                }
                            };
                            match message {
                                ServerMessage::Open { conn, peer, sni, .. } => {
                                    let route = route_for_sni(&sni, &self.identity.hostname);
                                    let target = route.as_ref().and_then(|route| {
                                        targets.read().expect("targets lock").get(route).cloned()
                                    });
                                    let (Some(route), Some(target)) = (route, target) else {
                                        let _ = outbound.send(control(&ClientMessage::Reset {
                                            conn,
                                            code: codes::UNKNOWN_ROUTE.into(),
                                        })).await;
                                        continue;
                                    };
                                    let (inbound, inbound_rx) = mpsc::channel(INBOUND_QUEUE);
                                    let acceptor = self.acceptor.read().expect("acceptor lock").clone();
                                    let abort = tasks.spawn(run_channel(
                                        conn,
                                        target,
                                        acceptor,
                                        inbound_rx,
                                        outbound.clone(),
                                    ));
                                    channels.insert(conn, Channel { route: route.clone(), inbound, abort });
                                    self.status.send_modify(|status| status.connections = channels.len());
                                    self.emit(Event::ConnectionOpened { conn, route, peer });
                                }
                                ServerMessage::End { conn } => {
                                    if let Some(channel) = channels.get(&conn) {
                                        let _ = channel.inbound.send(Inbound::End).await;
                                    }
                                }
                                ServerMessage::Reset { conn, code } => {
                                    if let Some(channel) = channels.remove(&conn) {
                                        channel.abort.abort();
                                        self.status.send_modify(|status| status.connections = channels.len());
                                        self.emit(Event::ConnectionClosed { conn, route: channel.route, error: Some(code) });
                                    }
                                }
                                ServerMessage::Ping { time_sent } => {
                                    let _ = outbound.send(control(&ClientMessage::Pong { time_sent })).await;
                                }
                                ServerMessage::Drain { reason } => break retry(format!("server draining: {reason}")),
                                ServerMessage::Pong { .. }
                                | ServerMessage::Attached { .. }
                                | ServerMessage::AttachError { .. } => {}
                            }
                        }
                        Message::Close(frame) => {
                            let reason = frame.map(|frame| format!("{} {}", frame.code, frame.reason));
                            break retry(reason.unwrap_or_else(|| "bridge closed".into()));
                        }
                        _ => {}
                    }
                }
                Some(finished) = tasks.join_next() => {
                    let Ok((conn, error)) = finished else { continue };
                    if let Some(channel) = channels.remove(&conn) {
                        self.status.send_modify(|status| status.connections = channels.len());
                        self.emit(Event::ConnectionClosed { conn, route: channel.route, error });
                    }
                }
                _ = heartbeat.tick() => {
                    if last_received.elapsed() > idle_timeout {
                        break retry("bridge idle timeout".into());
                    }
                    let _ = outbound.send(control(&ClientMessage::Ping { time_sent: now_ms() })).await;
                }
                changed = self.routes.changed() => {
                    if changed.is_err() {
                        break SessionEnd::Shutdown;
                    }
                    let next = self.routes.borrow_and_update().clone();
                    if next.keys().eq(names.iter()) {
                        self.status.send_modify(|status| status.routes = next.clone());
                        *targets.write().expect("targets lock") = next;
                    } else {
                        break SessionEnd::RoutesChanged;
                    }
                }
                _ = self.shutdown.changed() => break SessionEnd::Shutdown,
            }
        };

        for (conn, channel) in channels.drain() {
            channel.abort.abort();
            self.emit(Event::ConnectionClosed {
                conn,
                route: channel.route,
                error: Some("bridge disconnected".into()),
            });
        }
        tasks.abort_all();
        drop(outbound);
        writer.abort();
        end
    }

    async fn attach(&self, routes: &[String]) -> Result<(WebSocket, AttachedSession)> {
        let url = self.api.connect_url(&self.identity.id);
        let mut request = url
            .as_str()
            .into_client_request()
            .map_err(|error| Error::Bridge(error.to_string()))?;
        request.headers_mut().insert(
            "sec-websocket-protocol",
            HeaderValue::from_static(bridge::WEBSOCKET_SUBPROTOCOL),
        );
        request.headers_mut().insert(
            "user-agent",
            HeaderValue::from_static(concat!("opentunnel/", env!("CARGO_PKG_VERSION"))),
        );
        let (mut socket, _) = tokio_tungstenite::connect_async(request)
            .await
            .map_err(|error| Error::Bridge(error.to_string()))?;
        socket
            .send(control(&ClientMessage::Attach {
                token: self.identity.token.clone(),
                transport: Transport::Ws,
                routes: routes.to_vec(),
                client: ClientInfo {
                    version: env!("CARGO_PKG_VERSION").into(),
                    max_conns: MAX_CONNS,
                },
            }))
            .await
            .map_err(|error| Error::Bridge(error.to_string()))?;

        while let Some(message) = socket.next().await {
            let message = message.map_err(|error| Error::Bridge(error.to_string()))?;
            let Message::Text(text) = message else {
                continue;
            };
            match ServerMessage::decode(&text) {
                Ok(Some(ServerMessage::Attached {
                    session,
                    heartbeat_ms,
                    idle_timeout_ms,
                    ..
                })) => {
                    let attached = AttachedSession {
                        session,
                        heartbeat: Duration::from_millis(heartbeat_ms.max(1_000)),
                        idle_timeout: Duration::from_millis(idle_timeout_ms.max(5_000)),
                    };
                    return Ok((socket, attached));
                }
                Ok(Some(ServerMessage::AttachError { code })) => return Err(Error::Attach(code)),
                _ => continue,
            }
        }
        Err(Error::Bridge("bridge closed before attach".into()))
    }
}

fn retry(error: String) -> SessionEnd {
    SessionEnd::Retry {
        error,
        attached: true,
    }
}

type WebSocket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;

struct AttachedSession {
    session: String,
    heartbeat: Duration,
    idle_timeout: Duration,
}

struct Channel {
    route: String,
    inbound: mpsc::Sender<Inbound>,
    abort: tokio::task::AbortHandle,
}

enum Inbound {
    Data(Bytes),
    End,
}

fn control(message: &ClientMessage) -> Message {
    Message::text(serde_json::to_string(message).expect("control messages serialize"))
}

/// Terminates TLS for one public connection and forwards it to the target.
async fn run_channel(
    conn: ConnId,
    target: String,
    acceptor: TlsAcceptor,
    mut inbound: mpsc::Receiver<Inbound>,
    outbound: mpsc::Sender<Message>,
) -> (ConnId, Option<String>) {
    let (local, tls_side) = tokio::io::duplex(DUPLEX_BUFFER);
    let (mut local_read, mut local_write) = tokio::io::split(local);

    let receive = tokio::spawn(async move {
        while let Some(item) = inbound.recv().await {
            match item {
                Inbound::Data(payload) => local_write.write_all(&payload).await?,
                Inbound::End => break,
            }
        }
        local_write.shutdown().await
    });

    let send = {
        let outbound = outbound.clone();
        async move {
            let mut buffer = vec![0u8; bridge::MAX_PAYLOAD_SIZE];
            loop {
                let read = local_read
                    .read(&mut buffer)
                    .await
                    .map_err(ChannelError::Io)?;
                let message = if read == 0 {
                    control(&ClientMessage::End { conn })
                } else {
                    Message::binary(bridge::encode_data_frame(conn, &buffer[..read]))
                };
                if outbound.send(message).await.is_err() {
                    return Err(ChannelError::Io(std::io::Error::other("bridge closed")));
                }
                if read == 0 {
                    return Ok(());
                }
            }
        }
    };

    let serve = async move {
        let mut tls = acceptor.accept(tls_side).await.map_err(ChannelError::Io)?;
        let mut upstream = TcpStream::connect(&target)
            .await
            .map_err(ChannelError::Connect)?;
        upstream.set_nodelay(true).ok();
        tokio::io::copy_bidirectional(&mut tls, &mut upstream)
            .await
            .map_err(ChannelError::Io)?;
        Ok(())
    };

    let result = tokio::try_join!(serve, send);
    receive.abort();
    match result {
        Ok(_) => (conn, None),
        Err(error) => {
            let code = match error {
                ChannelError::Connect(_) => codes::UPSTREAM_CONNECT_FAILED,
                ChannelError::Io(_) => codes::UPSTREAM_IO_ERROR,
            };
            let _ = outbound
                .send(control(&ClientMessage::Reset {
                    conn,
                    code: code.into(),
                }))
                .await;
            (conn, Some(error.to_string()))
        }
    }
}

#[derive(Debug, thiserror::Error)]
enum ChannelError {
    #[error("upstream connect failed: {0}")]
    Connect(std::io::Error),
    #[error("{0}")]
    Io(std::io::Error),
}
