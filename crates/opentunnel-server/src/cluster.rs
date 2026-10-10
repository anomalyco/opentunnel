//! Many machines sharing one database (Fly, one machine per region). A bridge attaches to whichever machine is
//! nearest its client and a visitor lands on whichever is nearest the visitor, so:
//!
//! - every machine records the routes its bridges serve in the `bridges` table (the registry), refreshes its
//!   rows every heartbeat and removes them when bridges close; rows that stop being refreshed (a crashed
//!   machine) are ignored after three heartbeats;
//! - a visitor for a route with no bridge here is forwarded over the private network to the machine holding
//!   it: a one-line header, then the ClientHello, then both directions copied as they are;
//! - control that used to stay in one process (closing a deleted tunnel's bridges, route conflicts between
//!   clients sharing a tunnel) goes to the other machine over a small HTTP API on the same internal listener.
//!
//! The internal listener only binds the private network and every request carries the shared secret.

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use hyper::body::Incoming;
use hyper::{Method, Request, Response, StatusCode, header};
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tracing::{debug, info, warn};

use crate::clock::Clock;
use crate::crypto::{hash_token, token_matches};
use crate::http::{Body, Stats, count, json_response, response};
use crate::relay::{self, Accepted, Origin};
use crate::service::Service;
use crate::store::{BridgeLocation, MachineBridges, Store};

/// The first line of a forwarded connection: `OPENTUNNEL-FORWARD/1 <token> <tunnel> <route> <visitor>\n`.
pub const FORWARD_MAGIC: &[u8] = b"OPENTUNNEL-FORWARD/1 ";
/// The receiving machine's answer, before any data: it has the bridge and the stream follows.
pub const FORWARD_ACCEPTED: u8 = b'1';
/// It has no bridge for the route (any more); the sender may look again.
pub const FORWARD_REFUSED: u8 = b'0';
const MAX_HEADER: usize = 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
/// The receiver may need to load the tunnel from the database before it answers.
const ACK_TIMEOUT: Duration = Duration::from_secs(10);
const CONTROL_TIMEOUT: Duration = Duration::from_secs(3);
const LOCATION_TTL: Duration = Duration::from_secs(30);
const MISSING_TTL: Duration = Duration::from_secs(10);
/// A machine that could not be reached is skipped for this long.
const DOWN_TTL: Duration = Duration::from_secs(30);
const COPY_BUFFER: usize = 32 * 1024;

/// A machine holding a route.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Location {
    pub machine_id: String,
    pub region: String,
    pub address: String,
}

impl From<&BridgeLocation> for Location {
    fn from(row: &BridgeLocation) -> Self {
        Self {
            machine_id: row.machine_id.clone(),
            region: row.region.clone(),
            address: row.address.clone(),
        }
    }
}

type CacheKey = (String, String);

pub struct Cluster {
    pub machine_id: String,
    pub region: String,
    /// Where other machines reach this one, set once the internal listener is bound.
    address: OnceLock<String>,
    token: String,
    token_hash: String,
    store: Store,
    clock: Clock,
    http: reqwest::Client,
    pub heartbeat_ms: u64,
    pub stats: Arc<Stats>,
    locations: Mutex<HashMap<CacheKey, (Option<Location>, Instant)>>,
    down: Mutex<HashMap<String, Instant>>,
    /// Bridge rows whose removal failed, retried by the heartbeat.
    pending_removals: Mutex<HashSet<(String, u64)>>,
}

#[derive(Serialize, Deserialize)]
struct HeldRoutes {
    routes: Vec<String>,
}

impl Cluster {
    pub fn new(
        machine_id: String,
        region: String,
        token: String,
        store: Store,
        clock: Clock,
        heartbeat_ms: u64,
        stats: Arc<Stats>,
    ) -> Result<Self> {
        anyhow::ensure!(
            !token.is_empty() && !token.contains(char::is_whitespace),
            "INTERNAL_TOKEN must be set (without whitespace) with INTERNAL_LISTEN"
        );
        anyhow::ensure!(heartbeat_ms > 0, "CLUSTER_HEARTBEAT_MS must be positive");
        let http = reqwest::Client::builder()
            .connect_timeout(CONTROL_TIMEOUT)
            .timeout(CONTROL_TIMEOUT)
            .no_proxy()
            .build()?;
        Ok(Self {
            machine_id,
            region,
            address: OnceLock::new(),
            token_hash: hash_token(&token),
            token,
            store,
            clock,
            http,
            heartbeat_ms,
            stats,
            locations: Mutex::new(HashMap::new()),
            down: Mutex::new(HashMap::new()),
            pending_removals: Mutex::new(HashSet::new()),
        })
    }

    pub fn set_address(&self, address: String) {
        let _ = self.address.set(address);
    }

    pub fn address(&self) -> &str {
        self.address.get().map_or("", String::as_str)
    }

    pub fn authorized(&self, token: &str) -> bool {
        !token.is_empty() && token_matches(token, &self.token_hash)
    }

    /// Rows refreshed since this are live; older ones belong to a machine that stopped (three heartbeats).
    pub fn live_since(&self) -> u64 {
        self.clock.now_ms().saturating_sub(3 * self.heartbeat_ms)
    }

    fn is_down(&self, machine_id: &str) -> bool {
        let mut down = self.down.lock().expect("down lock");
        down.retain(|_, at| at.elapsed() < DOWN_TTL);
        down.contains_key(machine_id)
    }

    fn mark_down(&self, machine_id: &str) {
        self.down
            .lock()
            .expect("down lock")
            .insert(machine_id.to_owned(), Instant::now());
    }

    fn forget(&self, tunnel: &str) {
        self.locations
            .lock()
            .expect("locations lock")
            .retain(|(cached, _), _| cached != tunnel);
    }

    // --- Registry ----------------------------------------------------------------------------------------

    /// Records a bridge's routes. Returns false when the database was unavailable; the heartbeat retries.
    pub async fn publish(&self, tunnel: &str, bridge_id: u64, routes: &[String]) -> bool {
        let location = BridgeLocation {
            tunnel_id: tunnel.to_owned(),
            route: String::new(),
            machine_id: self.machine_id.clone(),
            bridge_id,
            region: self.region.clone(),
            address: self.address().to_owned(),
            updated_at: self.clock.now_ms(),
        };
        match self.store.put_bridge(&location, routes).await {
            Ok(()) => true,
            Err(error) => {
                warn!(tunnel, error = %format!("{error:#}"), "could not record a bridge in the registry");
                false
            }
        }
    }

    /// Removes a bridge's routes; retried by the heartbeat when the database is unavailable.
    pub async fn unpublish(&self, tunnel: &str, bridge_id: u64) {
        if let Err(error) = self
            .store
            .delete_bridge(tunnel, &self.machine_id, bridge_id)
            .await
        {
            warn!(tunnel, error = %format!("{error:#}"), "could not remove a bridge from the registry");
            self.pending_removals
                .lock()
                .expect("removals lock")
                .insert((tunnel.to_owned(), bridge_id));
        }
    }

    /// Live rows of a tunnel on other machines.
    async fn elsewhere(&self, tunnel: &str, route: Option<&str>) -> Result<Vec<BridgeLocation>> {
        Ok(self
            .store
            .bridge_locations(tunnel, route, self.live_since())
            .await?
            .into_iter()
            .filter(|row| row.machine_id != self.machine_id)
            .collect())
    }

    /// Whether another machine has a live bridge for the tunnel, for the API's `state`.
    pub async fn online_elsewhere(&self, tunnel: &str) -> bool {
        match self.elsewhere(tunnel, None).await {
            Ok(rows) => rows.iter().any(|row| !self.is_down(&row.machine_id)),
            Err(error) => {
                debug!(tunnel, %error, "registry lookup failed");
                false
            }
        }
    }

    /// The machine holding a tunnel's route, from the cache unless `refresh`.
    pub async fn locate(&self, tunnel: &str, route: &str, refresh: bool) -> Option<Location> {
        let key = (tunnel.to_owned(), route.to_owned());
        if !refresh
            && let Some((location, at)) = self.locations.lock().expect("locations lock").get(&key)
        {
            let ttl = if location.is_some() {
                LOCATION_TTL
            } else {
                MISSING_TTL
            };
            if at.elapsed() < ttl
                && location
                    .as_ref()
                    .is_none_or(|location| !self.is_down(&location.machine_id))
            {
                return location.clone();
            }
        }
        let location = match self.elsewhere(tunnel, Some(route)).await {
            Ok(rows) => rows
                .iter()
                .find(|row| !self.is_down(&row.machine_id))
                .map(Location::from),
            Err(error) => {
                debug!(tunnel, %error, "registry lookup failed");
                return None;
            }
        };
        self.locations
            .lock()
            .expect("locations lock")
            .insert(key, (location.clone(), Instant::now()));
        location
    }

    // --- Forwarding --------------------------------------------------------------------------------------

    /// Carries a visitor to the machine holding the route. Gives the connection back when no machine has it.
    pub async fn forward(&self, accepted: Accepted, tunnel: &str, route: &str) -> Option<Accepted> {
        let mut tried: Option<Location> = None;
        for attempt in 0..2 {
            let Some(location) = self.locate(tunnel, route, attempt > 0).await else {
                return Some(accepted);
            };
            if tried.as_ref() == Some(&location) {
                return Some(accepted);
            }
            match self.open(&location, &accepted, tunnel, route).await {
                Ok(Some(internal)) => {
                    count(&self.stats.forwarded_out);
                    splice(accepted, internal).await;
                    return None;
                }
                Ok(None) => {
                    debug!(tunnel, route, machine = %location.machine_id, "the machine no longer holds the route");
                }
                Err(error) => {
                    warn!(tunnel, machine = %location.machine_id, address = %location.address, %error, "forwarding failed");
                    self.mark_down(&location.machine_id);
                }
            }
            count(&self.stats.forward_failures);
            self.forget(tunnel);
            tried = Some(location);
        }
        Some(accepted)
    }

    /// Connects, sends the header and the ClientHello, and waits for the answer. `None`: refused.
    async fn open(
        &self,
        location: &Location,
        accepted: &Accepted,
        tunnel: &str,
        route: &str,
    ) -> Result<Option<TcpStream>> {
        let mut stream =
            tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(&location.address))
                .await
                .context("connecting timed out")??;
        let _ = stream.set_nodelay(true);
        let mut header = Vec::with_capacity(128 + accepted.initial.len());
        header.extend_from_slice(FORWARD_MAGIC);
        header.extend_from_slice(
            format!("{} {tunnel} {route} {}\n", self.token, accepted.peer).as_bytes(),
        );
        header.extend_from_slice(&accepted.initial);
        stream.write_all(&header).await?;
        let mut answer = [0u8; 1];
        let read = tokio::time::timeout(ACK_TIMEOUT, stream.read(&mut answer))
            .await
            .context("no answer")??;
        Ok((read == 1 && answer[0] == FORWARD_ACCEPTED).then_some(stream))
    }

    // --- Control -----------------------------------------------------------------------------------------

    fn url(&self, location: &Location, path: &str) -> String {
        format!("http://{}{path}", location.address)
    }

    /// Whether another machine's live bridge holds any of `routes`. Rows of machines that cannot be reached
    /// or no longer hold the route (a crash, or a bridge closing) do not count.
    pub async fn held_elsewhere(&self, tunnel: &str, routes: &[String]) -> bool {
        let rows = match self.elsewhere(tunnel, None).await {
            Ok(rows) => rows,
            Err(error) => {
                warn!(tunnel, error = %format!("{error:#}"), "route check across machines failed");
                return false;
            }
        };
        let mut machines: Vec<Location> = Vec::new();
        for row in rows.iter().filter(|row| routes.contains(&row.route)) {
            let location = Location::from(row);
            if !machines.contains(&location) && !self.is_down(&location.machine_id) {
                machines.push(location);
            }
        }
        for location in machines {
            let path = format!("/internal/tunnel/{tunnel}/routes");
            let held = self
                .http
                .get(self.url(&location, &path))
                .bearer_auth(&self.token)
                .send()
                .await
                .and_then(reqwest::Response::error_for_status);
            let held = match held {
                Ok(response) => response.json::<HeldRoutes>().await,
                Err(error) => Err(error),
            };
            match held {
                Ok(held) if held.routes.iter().any(|route| routes.contains(route)) => return true,
                Ok(_) => {}
                Err(error) => {
                    warn!(tunnel, machine = %location.machine_id, %error, "could not ask a machine about its routes");
                    // A slow answer may be the other machine checking this one for the same tunnel.
                    if error.is_connect() {
                        self.mark_down(&location.machine_id);
                    }
                }
            }
        }
        false
    }

    /// After a tunnel is deleted: closes its bridges on other machines and removes its rows.
    pub async fn close_elsewhere(&self, tunnel: &str) {
        self.forget(tunnel);
        let rows = match self.elsewhere(tunnel, None).await {
            Ok(rows) => rows,
            Err(error) => {
                warn!(tunnel, error = %format!("{error:#}"), "could not find a deleted tunnel's bridges");
                return;
            }
        };
        let mut machines: Vec<Location> = Vec::new();
        for row in &rows {
            let location = Location::from(row);
            if !machines.contains(&location) {
                machines.push(location);
            }
        }
        let path = format!("/internal/tunnel/{tunnel}/close");
        let closes = machines.iter().map(|location| {
            let request = self
                .http
                .post(self.url(location, &path))
                .bearer_auth(&self.token)
                .send();
            async move {
                if let Err(error) = request.await.and_then(reqwest::Response::error_for_status) {
                    // Its heartbeat notices the deletion within a minute.
                    warn!(tunnel, machine = %location.machine_id, %error, "could not close a deleted tunnel's bridges");
                }
            }
        });
        futures_util::future::join_all(closes).await;
        if let Err(error) = self.store.delete_tunnel_bridges(tunnel).await {
            warn!(tunnel, error = %format!("{error:#}"), "could not remove a deleted tunnel's bridges");
        }
    }

    /// The registry's view of every machine, for `/api/admin/stats`.
    pub async fn machines(&self) -> Result<Vec<MachineBridges>> {
        self.store.machine_bridges(self.live_since()).await
    }

    // --- Lifecycle ---------------------------------------------------------------------------------------

    /// Removes rows a previous run of this machine left (it crashed), before anything attaches.
    pub async fn start(&self) -> Result<()> {
        let removed = self.store.delete_machine_bridges(&self.machine_id).await?;
        info!(machine = %self.machine_id, region = %self.region, address = %self.address(), removed, "joined the cluster");
        Ok(())
    }

    /// Removes this machine's rows on a clean shutdown, so other machines stop forwarding here at once.
    pub async fn shutdown(&self) {
        if let Err(error) = self.store.delete_machine_bridges(&self.machine_id).await {
            warn!(error = %format!("{error:#}"), "could not remove this machine's bridges from the registry");
        }
    }

    /// One heartbeat: refreshes this machine's rows, records bridges the registry missed, retries failed
    /// removals, closes bridges of tunnels deleted elsewhere (if that machine could not reach this one), and
    /// drops rows of machines that are long gone.
    pub async fn heartbeat(&self, service: &Service) -> Result<()> {
        let now = self.clock.now_ms();
        self.store.refresh_bridges(&self.machine_id, now).await?;
        let live = service.republish(self).await;
        let removals: Vec<(String, u64)> = self
            .pending_removals
            .lock()
            .expect("removals lock")
            .drain()
            .collect();
        for (tunnel, bridge_id) in removals {
            self.unpublish(&tunnel, bridge_id).await;
        }
        for tunnel in self.store.deleted_tunnels(&live).await? {
            info!(
                tunnel,
                "closing the bridges of a tunnel deleted on another machine"
            );
            service.close_deleted(&tunnel).await;
        }
        self.store
            .delete_expired_bridges(now.saturating_sub(10 * 3 * self.heartbeat_ms))
            .await?;
        Ok(())
    }
}

pub async fn run_heartbeat(service: Service, cluster: Arc<Cluster>) {
    let mut interval = tokio::time::interval(Duration::from_millis(cluster.heartbeat_ms));
    interval.tick().await;
    loop {
        interval.tick().await;
        if let Err(error) = cluster.heartbeat(&service).await {
            warn!(error = %format!("{error:#}"), "cluster heartbeat failed");
        }
    }
}

/// Copies both directions between a visitor and the machine it was forwarded to.
async fn splice(accepted: Accepted, mut internal: TcpStream) {
    let mut visitor = accepted.stream;
    let copied = tokio::io::copy_bidirectional_with_sizes(
        &mut visitor,
        &mut internal,
        COPY_BUFFER,
        COPY_BUFFER,
    )
    .await;
    if copied.is_err() {
        // The other machine reset the connection (the bridge reset it, or went away): pass the reset on.
        let _ = visitor.set_zero_linger();
        let _ = internal.set_zero_linger();
    }
}

// --- The internal listener ---------------------------------------------------------------------------------

/// Accepts forwarded visitors and control requests from other machines.
pub async fn serve_internal(listener: TcpListener, service: Service, cluster: Arc<Cluster>) {
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(error) => {
                warn!(%error, "internal accept failed");
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
        };
        let service = service.clone();
        let cluster = cluster.clone();
        tokio::spawn(async move {
            if let Err(error) = internal_connection(stream, peer, service, cluster).await {
                debug!(%error, %peer, "internal connection rejected");
            }
        });
    }
}

async fn internal_connection(
    mut stream: TcpStream,
    peer: SocketAddr,
    service: Service,
    cluster: Arc<Cluster>,
) -> Result<()> {
    let mut buffer = Vec::with_capacity(4096);
    let line_end = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Some(end) = buffer.iter().position(|byte| *byte == b'\n') {
                return Ok(end);
            }
            if buffer.len() >= MAX_HEADER || stream.read_buf(&mut buffer).await? == 0 {
                bail!("no header");
            }
        }
    })
    .await
    .context("header timeout")??;
    if !buffer.starts_with(FORWARD_MAGIC) {
        let io = crate::tls::Replay::new(buffer, stream);
        let handler = hyper::service::service_fn(move |request| {
            let service = service.clone();
            let cluster = cluster.clone();
            async move { Ok::<_, std::convert::Infallible>(control(request, service, cluster).await) }
        });
        let _ = hyper::server::conn::http1::Builder::new()
            .serve_connection(TokioIo::new(io), handler)
            .await;
        return Ok(());
    }
    let line = std::str::from_utf8(&buffer[FORWARD_MAGIC.len()..line_end])?;
    let mut fields = line.split(' ');
    let (Some(token), Some(tunnel), Some(_route), Some(visitor)) =
        (fields.next(), fields.next(), fields.next(), fields.next())
    else {
        bail!("malformed forward header");
    };
    if !cluster.authorized(token) {
        bail!("forward with a bad token from {peer}");
    }
    let tunnel = tunnel.to_owned();
    let visitor: SocketAddr = visitor.parse().context("forwarded visitor address")?;
    let rest = buffer.split_off(line_end + 1);
    let accepted = relay::accept_with(stream, visitor, false, rest).await?;
    if relay::tunnel_id(&accepted.sni, &service.domain).as_deref() != Some(tunnel.as_str()) {
        bail!("forwarded ClientHello is for another tunnel");
    }
    count(&cluster.stats.forwarded_in);
    relay::route_tunnel(&service, accepted, Origin::Forwarded).await
}

async fn control(
    request: Request<Incoming>,
    service: Service,
    cluster: Arc<Cluster>,
) -> Response<Body> {
    let token = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or("");
    if !cluster.authorized(token) {
        return response(StatusCode::UNAUTHORIZED);
    }
    let path = request.uri().path().to_owned();
    let Some(rest) = path.strip_prefix("/internal/tunnel/") else {
        return response(StatusCode::NOT_FOUND);
    };
    let Some((tunnel, action)) = rest.split_once('/') else {
        return response(StatusCode::NOT_FOUND);
    };
    match (request.method(), action) {
        (&Method::GET, "routes") => match service.held_routes(tunnel).await {
            Ok(routes) => json_response(StatusCode::OK, &HeldRoutes { routes }),
            Err(error) => json_response(
                StatusCode::SERVICE_UNAVAILABLE,
                &json!({ "error": format!("{error:#}") }),
            ),
        },
        (&Method::POST, "close") => {
            info!(
                tunnel,
                "closing the bridges of a tunnel deleted on another machine"
            );
            service.close_deleted(tunnel).await;
            response(StatusCode::NO_CONTENT)
        }
        _ => response(StatusCode::NOT_FOUND),
    }
}
