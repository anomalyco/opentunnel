//! Public TCP: reads the ClientHello, then either terminates TLS for the API domain or carries the raw stream
//! over the tunnel's bridge without decrypting it.

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use anyhow::{Result, bail};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::net::tcp::{ReadHalf, WriteHalf};
use tokio::sync::watch;
use tracing::debug;

use crate::bridge::{ServerControl, data_frame};
use crate::cluster::{Cluster, FORWARD_ACCEPTED, FORWARD_REFUSED};
use crate::proxy_protocol;
use crate::service::{Inbound, Outcome, Route, Service};
use crate::sni::{CLIENT_HELLO_LIMIT, Hello, parse_client_hello};

const CLIENT_HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_PAYLOAD: usize = opentunnel::protocol::bridge::MAX_PAYLOAD_SIZE;

/// The start of a public connection, read before deciding where it goes.
pub struct Accepted {
    pub stream: TcpStream,
    /// The visitor, from the PROXY header when one was required.
    pub peer: SocketAddr,
    /// Everything read after the PROXY header, starting with the ClientHello.
    pub initial: Vec<u8>,
    pub sni: String,
    pub alpn: String,
}

/// Reads the optional PROXY header and the ClientHello, within the ClientHello timeout.
pub async fn accept(stream: TcpStream, peer: SocketAddr, proxy_protocol: bool) -> Result<Accepted> {
    accept_with(stream, peer, proxy_protocol, Vec::with_capacity(4096)).await
}

/// [`accept`], after `buffer` was already read from the stream.
pub async fn accept_with(
    mut stream: TcpStream,
    peer: SocketAddr,
    proxy_protocol: bool,
    mut buffer: Vec<u8>,
) -> Result<Accepted> {
    tokio::time::timeout(CLIENT_HELLO_TIMEOUT, async move {
        let mut peer = peer;
        let mut start = 0;
        if proxy_protocol {
            loop {
                match proxy_protocol::parse(&buffer) {
                    proxy_protocol::Header::Complete { length, source } => {
                        if let Some(source) = source {
                            peer = source;
                        }
                        start = length;
                        break;
                    }
                    proxy_protocol::Header::Invalid => bail!("invalid PROXY protocol header"),
                    proxy_protocol::Header::Incomplete => {
                        if buffer.len() > 536 || stream.read_buf(&mut buffer).await? == 0 {
                            bail!("connection closed before the PROXY header");
                        }
                    }
                }
            }
        }
        loop {
            match parse_client_hello(&buffer[start..]) {
                Hello::Complete { server_name, alpn } => {
                    buffer.drain(..start);
                    return Ok(Accepted {
                        stream,
                        peer,
                        initial: buffer,
                        sni: server_name,
                        alpn,
                    });
                }
                Hello::Invalid(reason) => bail!("{reason}"),
                Hello::Incomplete => {
                    if buffer.len() - start >= CLIENT_HELLO_LIMIT {
                        bail!("ClientHello exceeded inspection limit");
                    }
                    if stream.read_buf(&mut buffer).await? == 0 {
                        bail!("Connection closed before ClientHello");
                    }
                }
            }
        }
    })
    .await
    .unwrap_or_else(|_| bail!("ClientHello timeout"))
}

/// The tunnel ID in `<id>.<domain>` or `<route>.<id>.<domain>`.
pub fn tunnel_id(hostname: &str, domain: &str) -> Option<String> {
    let labels = hostname.strip_suffix(domain)?.strip_suffix('.')?;
    let labels: Vec<&str> = labels.split('.').collect();
    if labels.is_empty() || labels.len() > 2 {
        return None;
    }
    let id = *labels.last()?;
    (!id.is_empty()).then(|| id.to_owned())
}

/// The route in `<id>.<domain>` (`@`) or `<route>.<id>.<domain>`.
pub fn route_name(hostname: &str, id: &str, domain: &str) -> Option<String> {
    let labels = hostname.strip_suffix(domain)?.strip_suffix('.')?;
    if labels == id {
        return Some("@".into());
    }
    let route = labels.strip_suffix(id)?.strip_suffix('.')?;
    (!route.is_empty() && !route.contains('.')).then(|| route.to_owned())
}

/// What to do with a tunnel connection nothing serves here.
pub trait Fallback: Send + Sync {
    /// Takes the connection, or gives it back.
    fn forward(&self, accepted: Accepted) -> Option<Accepted>;
}

/// Where a tunnel connection came from.
#[derive(Clone, Copy)]
pub enum Origin<'a> {
    /// A visitor on the public port. Without a bridge here it goes to the machine holding one, then to the
    /// legacy fallback.
    Public {
        cluster: Option<&'a Arc<Cluster>>,
        fallback: Option<&'a Arc<dyn Fallback>>,
    },
    /// Forwarded by another machine, which waits for one byte: [`FORWARD_ACCEPTED`] before the stream, or
    /// [`FORWARD_REFUSED`]. Never forwarded again.
    Forwarded,
}

/// Carries a public connection to a tunnel client over its bridge, until both directions end or one side
/// aborts.
pub async fn route_tunnel(service: &Service, accepted: Accepted, origin: Origin<'_>) -> Result<()> {
    let started = service.now();
    let Some(id) = tunnel_id(&accepted.sni, &service.domain) else {
        bail!("SNI is not an OpenTunnel hostname");
    };
    let route = service.route(&id, &accepted.sni).await?;
    let (bridge, conn, tunnel_id, finish, mut abort, inbound, bytes_out) = match route {
        Route::Bridge {
            bridge,
            conn,
            tunnel_id,
            finish,
            abort,
            inbound,
            bytes_out,
        } => (bridge, conn, tunnel_id, finish, abort, inbound, bytes_out),
        Route::Rejected {
            tunnel_exists,
            outcome,
        } => {
            let (cluster, fallback) = match origin {
                Origin::Public { cluster, fallback } => (cluster, fallback),
                Origin::Forwarded => {
                    // The forwarding machine retries elsewhere or rejects it, and reports it.
                    let mut stream = accepted.stream;
                    let _ = stream.write_all(&[FORWARD_REFUSED]).await;
                    debug!(tunnel = %id, outcome, "forwarded connection refused");
                    return Ok(());
                }
            };
            let mut accepted = accepted;
            if outcome == "no_bridge"
                && tunnel_exists
                && let Some(cluster) = cluster
                && let Some(route) = route_name(&accepted.sni, &id, &service.domain)
            {
                match cluster.forward(accepted, &id, &route).await {
                    None => return Ok(()),
                    Some(returned) => accepted = returned,
                }
            }
            if outcome == "no_bridge"
                && let Some(fallback) = fallback
            {
                match fallback.forward(accepted) {
                    None => return Ok(()),
                    Some(returned) => {
                        return reject(service, &id, tunnel_exists, outcome, started, returned)
                            .await;
                    }
                }
            }
            return reject(service, &id, tunnel_exists, outcome, started, accepted).await;
        }
    };

    let Accepted {
        stream,
        peer,
        initial,
        sni,
        alpn,
    } = accepted;
    let mut stream = stream;
    if matches!(origin, Origin::Forwarded) && stream.write_all(&[FORWARD_ACCEPTED]).await.is_err() {
        bridge.channels.lock().expect("channels lock").remove(&conn);
        return Ok(());
    }
    let peer = peer.to_string();
    let _ = bridge
        .tx
        .send(
            ServerControl::Open {
                conn,
                peer: &peer,
                sni: &sni,
                alpn: &alpn,
            }
            .message(),
        )
        .await;
    for chunk in initial.chunks(MAX_PAYLOAD) {
        let _ = bridge.tx.send(data_frame(conn, chunk)).await;
    }
    let bytes_in = initial.len() as u64;

    let _ = stream.set_nodelay(true);
    let (read, write) = stream.split();
    let upload = upload(read, &bridge, conn, &finish, abort.clone());
    let download = download(write, inbound, &bridge, conn, &finish, abort.clone());
    let (uploaded, ()) = tokio::join!(upload, download);
    if *abort.borrow_and_update() {
        // Aborted: drop the socket with a reset rather than a clean close.
        let _ = stream.set_zero_linger();
    }
    bridge.channels.lock().expect("channels lock").remove(&conn);
    finish.finish(Outcome::Closed, false);
    service.analytics.publish(
        "connection.closed",
        serde_json::json!({
            "tunnel_id": tunnel_id,
            "outcome": finish.outcome().unwrap_or(Outcome::Closed).as_str(),
            "duration_ms": service.now().saturating_sub(started),
            "bytes_in": bytes_in + uploaded,
            "bytes_out": bytes_out.load(Ordering::Relaxed),
        }),
    );
    Ok(())
}

async fn reject(
    service: &Service,
    id: &str,
    tunnel_exists: bool,
    outcome: &str,
    started: u64,
    accepted: Accepted,
) -> Result<()> {
    if tunnel_exists {
        service.analytics.publish(
            "connection.closed",
            serde_json::json!({
                "tunnel_id": id,
                "outcome": outcome,
                "duration_ms": service.now().saturating_sub(started),
                "bytes_in": accepted.initial.len(),
                "bytes_out": 0,
            }),
        );
    }
    debug!(tunnel = %id, outcome, "public connection rejected");
    Ok(())
}

/// Visitor to tunnel client. Returns the bytes read after the ClientHello.
async fn upload(
    mut read: ReadHalf<'_>,
    bridge: &crate::service::Bridge,
    conn: u32,
    finish: &crate::service::Finish,
    mut abort: watch::Receiver<bool>,
) -> u64 {
    let mut total = 0u64;
    let mut buffer = vec![0u8; MAX_PAYLOAD];
    loop {
        let read = tokio::select! {
            read = read.read(&mut buffer) => read,
            _ = abort.wait_for(|aborted| *aborted) => return total,
        };
        match read {
            Ok(0) => {
                let _ = bridge.tx.send(ServerControl::End { conn }.message()).await;
                return total;
            }
            Ok(read) => {
                total += read as u64;
                let sent = tokio::select! {
                    sent = bridge.tx.send(data_frame(conn, &buffer[..read])) => sent.is_ok(),
                    _ = abort.wait_for(|aborted| *aborted) => return total,
                };
                if !sent {
                    finish.finish(Outcome::BridgeDisconnected, true);
                    return total;
                }
            }
            Err(_) => {
                let _ = bridge.tx.try_send(
                    ServerControl::Reset {
                        conn,
                        code: "client_io_error",
                    }
                    .message(),
                );
                bridge.channels.lock().expect("channels lock").remove(&conn);
                finish.finish(Outcome::ClientError, true);
                return total;
            }
        }
    }
}

/// Tunnel client to visitor, until the client ends its side.
async fn download(
    mut write: WriteHalf<'_>,
    mut inbound: tokio::sync::mpsc::Receiver<Inbound>,
    bridge: &crate::service::Bridge,
    conn: u32,
    finish: &crate::service::Finish,
    mut abort: watch::Receiver<bool>,
) {
    loop {
        let item = tokio::select! {
            item = inbound.recv() => item,
            _ = abort.wait_for(|aborted| *aborted) => return,
        };
        match item {
            Some(Inbound::Data(data)) => {
                let written = tokio::select! {
                    written = write.write_all(&data) => written,
                    _ = abort.wait_for(|aborted| *aborted) => return,
                };
                if written.is_err() {
                    bridge.channels.lock().expect("channels lock").remove(&conn);
                    let _ = bridge.tx.try_send(
                        ServerControl::Reset {
                            conn,
                            code: "client_io_error",
                        }
                        .message(),
                    );
                    finish.finish(Outcome::ClientError, true);
                    return;
                }
            }
            Some(Inbound::End) | None => {
                let _ = write.shutdown().await;
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_routes() {
        let domain = "opentunnel.xyz";
        assert_eq!(
            tunnel_id("api.abcdefghijkl.opentunnel.xyz", domain).as_deref(),
            Some("abcdefghijkl")
        );
        assert_eq!(
            route_name("abcdefghijkl.opentunnel.xyz", "abcdefghijkl", domain).as_deref(),
            Some("@")
        );
        assert_eq!(
            route_name("api.abcdefghijkl.opentunnel.xyz", "abcdefghijkl", domain).as_deref(),
            Some("api")
        );
        assert_eq!(
            route_name("a.b.abcdefghijkl.opentunnel.xyz", "abcdefghijkl", domain),
            None
        );
        assert_eq!(
            route_name("xabcdefghijkl.opentunnel.xyz", "abcdefghijkl", domain),
            None
        );
    }
}
