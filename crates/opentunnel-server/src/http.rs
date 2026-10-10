//! HTTP for the API domain: the tunnel API with the Worker's exact paths, status codes and bodies, the bridge
//! WebSocket upgrade, `/health`, and the website.

use std::convert::Infallible;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::header::{self, HeaderMap, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::Serialize;
use serde_json::{Value, json};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::{Role, WebSocketConfig};
use tracing::warn;

use crate::analytics;
use crate::crypto::{hash_token, slug, token};
use crate::service::{Bind, CertificateLookup, Lookup, Service};
use crate::website::{Resolved, Website};

pub type Body = Full<Bytes>;

const OPENAPI: &str = include_str!("openapi.json");
const MAX_BODY: usize = 1024 * 1024;
const MAX_FRAME: usize = 1024 * 1024;

/// Subprotocols this server speaks, newest first.
const SUBPROTOCOLS: &[&str] = &["opentunnel"];

pub struct App {
    pub service: Service,
    pub website: Website,
    pub admin: Option<Arc<dyn Admin>>,
    pub stats: Arc<Stats>,
}

#[derive(Default)]
pub struct Stats {
    /// Public connections handed to the legacy Worker because nothing here served them.
    pub legacy_forwarded: AtomicU64,
    pub tunnel_connections: AtomicU64,
}

/// The server's own admin endpoints under `/api/admin/*`, behind a bearer secret.
pub trait Admin: Send + Sync {
    fn authorized(&self, token: &str) -> bool;
    fn handle(
        &self,
        app: Arc<App>,
        path: String,
        body: Bytes,
    ) -> futures_util::future::BoxFuture<'static, Response<Body>>;
}

pub fn response(status: StatusCode) -> Response<Body> {
    let mut response = Response::new(Full::new(Bytes::new()));
    *response.status_mut() = status;
    response
}

pub fn json_response(status: StatusCode, body: &impl Serialize) -> Response<Body> {
    let mut response = Response::new(Full::new(Bytes::from(
        serde_json::to_vec(body).expect("responses serialize"),
    )));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response
}

pub fn text_response(status: StatusCode, text: &str) -> Response<Body> {
    let mut response = Response::new(Full::new(Bytes::from(text.to_owned())));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain;charset=UTF-8"),
    );
    response
}

fn unauthorized() -> Response<Body> {
    ordered(
        StatusCode::UNAUTHORIZED,
        &[("_tag", "UnauthorizedError".into()), ("message", "Invalid bearer token".into())],
    )
}

fn tunnel_not_found(id: &str) -> Response<Body> {
    ordered(
        StatusCode::NOT_FOUND,
        &[
            ("_tag", "TunnelNotFoundError".into()),
            ("tunnelID", id.into()),
            ("message", "Tunnel not found".into()),
        ],
    )
}

fn unavailable(message: impl ToString) -> Response<Body> {
    ordered(
        StatusCode::SERVICE_UNAVAILABLE,
        &[
            ("_tag", "ServiceUnavailableError".into()),
            ("message", message.to_string().into()),
        ],
    )
}

/// A JSON object with its keys in the given order.
fn ordered(status: StatusCode, fields: &[(&str, Value)]) -> Response<Body> {
    let mut out = String::from("{");
    for (index, (key, value)) in fields.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(&serde_json::to_string(key).expect("keys serialize"));
        out.push(':');
        out.push_str(&serde_json::to_string(value).expect("values serialize"));
    }
    out.push('}');
    let mut response = Response::new(Full::new(Bytes::from(out)));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response
}

fn bearer(headers: &HeaderMap) -> String {
    let value = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    match value.get(..7) {
        Some(scheme) if scheme.eq_ignore_ascii_case("bearer ") => value[7..].to_owned(),
        _ => String::new(),
    }
}

fn user_agent(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
}

/// `decodeURIComponent`, keeping the input when it is not valid percent-encoded UTF-8.
pub fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let (Some(high), Some(low)) = (
                (bytes[index + 1] as char).to_digit(16),
                (bytes[index + 2] as char).to_digit(16),
            )
        {
            out.push((high * 16 + low) as u8);
            index += 3;
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| value.to_owned())
}

/// Reads a JSON payload the way the Worker's API did: a non-JSON content type is 415, an unreadable or
/// mistyped body a bare 400.
async fn payload(request: Request<Incoming>) -> Result<Value, Response<Body>> {
    if let Some(content_type) = request.headers().get(header::CONTENT_TYPE) {
        let content_type = content_type.to_str().unwrap_or_default();
        let mime = content_type.split(';').next().unwrap_or_default().trim();
        if !mime.eq_ignore_ascii_case("application/json") {
            let mut response = text_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                &format!("Unsupported content-type: {mime}"),
            );
            // The Worker's API sent a bare `text/plain` here.
            response
                .headers_mut()
                .insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain"));
            return Err(response);
        }
    }
    let body = match Limited::new(request.into_body(), MAX_BODY).collect().await {
        Ok(body) => body.to_bytes(),
        Err(_) => return Err(response(StatusCode::BAD_REQUEST)),
    };
    serde_json::from_slice(&body).map_err(|_| response(StatusCode::BAD_REQUEST))
}

impl App {
    pub async fn handle(self: Arc<Self>, request: Request<Incoming>) -> Response<Body> {
        let path = request.uri().path().to_owned();
        if path == "/health" {
            return json_response(StatusCode::OK, &json!({ "ok": true }));
        }
        if let Some(id) = connect_path(&path)
            && request.method() == Method::GET
        {
            return self.upgrade(percent_decode(id), request).await;
        }
        if let Some(rest) = path.strip_prefix("/api/admin/")
            && let Some(admin) = &self.admin
        {
            let token = bearer(request.headers());
            if request.method() != Method::POST || !admin.authorized(&token) {
                return response(StatusCode::NOT_FOUND);
            }
            let rest = match request.uri().query() {
                Some(query) => format!("{rest}?{query}"),
                None => rest.to_owned(),
            };
            let body = match Limited::new(request.into_body(), 64 * 1024 * 1024).collect().await {
                Ok(body) => body.to_bytes(),
                Err(_) => return response(StatusCode::BAD_REQUEST),
            };
            return admin.clone().handle(self.clone(), rest, body).await;
        }
        if path.starts_with("/api/") || path == "/openapi.json" {
            return self.api(request).await;
        }
        self.static_file(&request)
    }

    fn static_file(&self, request: &Request<Incoming>) -> Response<Body> {
        if request.method() != Method::GET && request.method() != Method::HEAD {
            return text_response(StatusCode::NOT_FOUND, "Not found");
        }
        match self.website.resolve(request.uri().path()) {
            Resolved::File(asset) => {
                let matches = request
                    .headers()
                    .get(header::IF_NONE_MATCH)
                    .and_then(|value| value.to_str().ok())
                    .is_some_and(|value| value.split(',').any(|tag| tag.trim() == asset.etag));
                let mut response = if matches {
                    response(StatusCode::NOT_MODIFIED)
                } else {
                    let mut response = Response::new(Full::new(asset.body.clone()));
                    response.headers_mut().insert(
                        header::CONTENT_TYPE,
                        HeaderValue::from_static(asset.content_type),
                    );
                    response
                };
                let headers = response.headers_mut();
                headers.insert(
                    header::ETAG,
                    HeaderValue::from_str(&asset.etag).expect("etags are ASCII"),
                );
                headers.insert(
                    header::CACHE_CONTROL,
                    HeaderValue::from_static(if asset.immutable {
                        "public, max-age=31536000, immutable"
                    } else {
                        "public, max-age=0, must-revalidate"
                    }),
                );
                response
            }
            Resolved::Redirect(location) => {
                let location = match request.uri().query() {
                    Some(query) => format!("{location}?{query}"),
                    None => location,
                };
                let mut response = response(StatusCode::TEMPORARY_REDIRECT);
                if let Ok(location) = HeaderValue::from_str(&location) {
                    response.headers_mut().insert(header::LOCATION, location);
                }
                response
            }
            Resolved::NotFound => text_response(StatusCode::NOT_FOUND, "Not found"),
        }
    }

    async fn api(&self, request: Request<Incoming>) -> Response<Body> {
        let path = request.uri().path().to_owned();
        if path == "/openapi.json" {
            return if matches!(*request.method(), Method::GET | Method::HEAD) {
                let mut response = Response::new(Full::new(Bytes::from_static(OPENAPI.as_bytes())));
                response.headers_mut().insert(
                    header::CONTENT_TYPE,
                    HeaderValue::from_static("application/json"),
                );
                response
            } else {
                response(StatusCode::NOT_FOUND)
            };
        }
        // The Worker's router ignored empty segments, so `/api//tunnel/x/` is `/api/tunnel/x`.
        let segments: Vec<String> = path
            .split('/')
            .filter(|segment| !segment.is_empty())
            .map(percent_decode)
            .collect();
        let segments: Vec<&str> = segments.iter().map(String::as_str).collect();
        let method = request.method().clone();
        let get = method == Method::GET || method == Method::HEAD;
        match segments.as_slice() {
            ["api", "tunnel"] if method == Method::POST => self.create(request).await,
            ["api", "tunnel", id] if get => {
                let token = bearer(request.headers());
                match self.service.info(id, &token).await {
                    Ok(Lookup::Ok(view)) => json_response(StatusCode::OK, &view),
                    Ok(Lookup::Unauthorized) => unauthorized(),
                    Ok(Lookup::NotFound) => tunnel_not_found(id),
                    Err(error) => unavailable(error),
                }
            }
            ["api", "tunnel", id] if method == Method::DELETE => {
                let token = bearer(request.headers());
                match self.service.remove(id, &token).await {
                    Ok(Lookup::Ok(())) => response(StatusCode::NO_CONTENT),
                    Ok(Lookup::Unauthorized) => unauthorized(),
                    Ok(Lookup::NotFound) => tunnel_not_found(id),
                    Err(error) => unavailable(error),
                }
            }
            ["api", "tunnel", id, "certificate"] if method == Method::POST => {
                let id = (*id).to_owned();
                self.bind(id, request).await
            }
            ["api", "tunnel", id, "certificate"] if get => {
                let token = bearer(request.headers());
                match self.service.certificate(id, &token).await {
                    Ok(CertificateLookup::Ok(info)) => json_response(StatusCode::OK, &info),
                    Ok(CertificateLookup::Unauthorized) => unauthorized(),
                    Ok(CertificateLookup::NoCertificate) => ordered(
                        StatusCode::NOT_FOUND,
                        &[
                            ("_tag", "CertificateNotFoundError".into()),
                            ("tunnelID", (*id).into()),
                            ("message", "Certificate not found".into()),
                        ],
                    ),
                    Ok(CertificateLookup::NotFound) => tunnel_not_found(id),
                    Err(error) => unavailable(error),
                }
            }
            // The API's own handler for the bridge path, reached only when the exact path did not match.
            ["api", "tunnel", _, "connect"] if get => json_response(StatusCode::OK, &true),
            _ => response(StatusCode::NOT_FOUND),
        }
    }

    async fn create(&self, request: Request<Incoming>) -> Response<Body> {
        let client = analytics::client(user_agent(request.headers()));
        let body = match payload(request).await {
            Ok(body) => body,
            Err(response) => return response,
        };
        let Value::Object(body) = body else {
            return response(StatusCode::BAD_REQUEST);
        };
        match body.get("name") {
            None | Some(Value::Null) => {}
            Some(Value::String(_)) => {
                return ordered(
                    StatusCode::BAD_REQUEST,
                    &[
                        ("_tag", "InvalidRequestError".into()),
                        (
                            "message",
                            "Custom tunnel names are not supported; omit name to get a random hostname"
                                .into(),
                        ),
                    ],
                );
            }
            Some(_) => return response(StatusCode::BAD_REQUEST),
        }
        let id = slug();
        let token = token();
        match self.service.create(&id, hash_token(&token)).await {
            Ok(Some(tunnel)) => {
                let mut event = json!({ "tunnel_id": id });
                for (key, value) in client.fields() {
                    event[key] = value;
                }
                self.service.analytics.publish("tunnel.created", event);
                #[derive(Serialize)]
                struct Created {
                    tunnel: crate::record::TunnelView,
                    token: String,
                }
                json_response(StatusCode::CREATED, &Created { tunnel, token })
            }
            Ok(None) => ordered(
                StatusCode::CONFLICT,
                &[
                    ("_tag", "HostnameUnavailableError".into()),
                    ("name", id.into()),
                    ("message", "Hostname is unavailable".into()),
                ],
            ),
            Err(error) => unavailable(error),
        }
    }

    async fn bind(&self, id: String, request: Request<Incoming>) -> Response<Body> {
        let token = bearer(request.headers());
        let body = match payload(request).await {
            Ok(body) => body,
            Err(response) => return response,
        };
        let Some(csr) = body.get("csr").and_then(Value::as_str) else {
            return response(StatusCode::BAD_REQUEST);
        };
        match self.service.bind_certificate(&id, &token, csr).await {
            Ok(Bind::Ok(info)) => json_response(StatusCode::ACCEPTED, &info),
            Ok(Bind::Unauthorized) => unauthorized(),
            Ok(Bind::NotFound) => tunnel_not_found(&id),
            Ok(Bind::InvalidRequest(message)) => ordered(
                StatusCode::BAD_REQUEST,
                &[
                    ("_tag", "InvalidRequestError".into()),
                    ("message", message.into()),
                ],
            ),
            Ok(Bind::InvalidHostname { provided, expected }) => ordered(
                StatusCode::BAD_REQUEST,
                &[
                    ("_tag", "InvalidHostnameError".into()),
                    ("provided", provided.into()),
                    ("expected", expected.into()),
                    ("message", "CSR hostname does not match tunnel hostname".into()),
                ],
            ),
            Ok(Bind::InProgress) => ordered(
                StatusCode::CONFLICT,
                &[
                    ("_tag", "CertificateInProgressError".into()),
                    ("tunnelID", id.into()),
                    ("message", "Certificate issuance is already in progress".into()),
                ],
            ),
            Ok(Bind::Unavailable(message)) => unavailable(message),
            Err(error) => unavailable(error),
        }
    }

    async fn upgrade(&self, id: String, mut request: Request<Incoming>) -> Response<Body> {
        match self.service.exists(&id).await {
            Ok(true) => {}
            Ok(false) => return text_response(StatusCode::NOT_FOUND, "Tunnel not found"),
            Err(error) => return unavailable(error),
        }
        let headers = request.headers();
        let websocket = headers
            .get(header::UPGRADE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.eq_ignore_ascii_case("websocket"));
        if !websocket {
            return text_response(StatusCode::UPGRADE_REQUIRED, "Expected WebSocket upgrade");
        }
        let offered: Vec<String> = headers
            .get_all(header::SEC_WEBSOCKET_PROTOCOL)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .flat_map(|value| value.split(','))
            .map(|value| value.trim().to_owned())
            .collect();
        let Some(protocol) = SUBPROTOCOLS
            .iter()
            .find(|protocol| offered.iter().any(|offered| offered == *protocol))
        else {
            return text_response(
                StatusCode::UPGRADE_REQUIRED,
                "Expected opentunnel WebSocket subprotocol",
            );
        };
        let Some(key) = headers.get(header::SEC_WEBSOCKET_KEY) else {
            return text_response(StatusCode::BAD_REQUEST, "Missing Sec-WebSocket-Key");
        };
        let accept = derive_accept_key(key.as_bytes());
        let client = analytics::client(user_agent(headers));
        let service = self.service.clone();
        let upgrade = hyper::upgrade::on(&mut request);
        tokio::spawn(async move {
            let upgraded = match upgrade.await {
                Ok(upgraded) => upgraded,
                Err(error) => {
                    warn!(%error, "bridge upgrade failed");
                    return;
                }
            };
            let mut config = WebSocketConfig::default();
            config.max_message_size = Some(MAX_FRAME * 16);
            config.max_frame_size = Some(MAX_FRAME * 16);
            let socket =
                WebSocketStream::from_raw_socket(TokioIo::new(upgraded), Role::Server, Some(config))
                    .await;
            crate::bridge::run(service, id, socket, client).await;
        });
        let mut response = response(StatusCode::SWITCHING_PROTOCOLS);
        let headers = response.headers_mut();
        headers.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
        headers.insert(header::CONNECTION, HeaderValue::from_static("Upgrade"));
        headers.insert(
            header::SEC_WEBSOCKET_ACCEPT,
            HeaderValue::from_str(&accept).expect("accept keys are ASCII"),
        );
        headers.insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            HeaderValue::from_static(protocol),
        );
        response
    }
}

/// The tunnel ID in `/api/tunnel/<id>/connect`, matched exactly as the Worker matched it.
fn connect_path(path: &str) -> Option<&str> {
    let id = path.strip_prefix("/api/tunnel/")?.strip_suffix("/connect")?;
    (!id.is_empty() && !id.contains('/')).then_some(id)
}

/// Serves HTTP/1.1 and HTTP/2 on one connection, with upgrades for the bridge.
pub async fn serve_connection<I>(app: Arc<App>, io: I)
where
    I: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let service = hyper::service::service_fn(move |request| {
        let app = app.clone();
        async move { Ok::<_, Infallible>(app.handle(request).await) }
    });
    let mut builder =
        hyper_util::server::conn::auto::Builder::new(hyper_util::rt::TokioExecutor::new());
    builder
        .http1()
        .timer(hyper_util::rt::TokioTimer::new())
        .header_read_timeout(std::time::Duration::from_secs(30));
    if let Err(error) = builder
        .serve_connection_with_upgrades(TokioIo::new(io), service)
        .await
    {
        tracing::debug!(%error, "HTTP connection ended");
    }
}

/// Port 80: health checks, and a redirect to HTTPS for everything else.
pub async fn serve_redirect<I>(domain: String, io: I)
where
    I: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let service = hyper::service::service_fn(move |request: Request<Incoming>| {
        let domain = domain.clone();
        async move {
            if request.uri().path() == "/health" {
                return Ok::<_, Infallible>(json_response(StatusCode::OK, &json!({ "ok": true })));
            }
            let path = request
                .uri()
                .path_and_query()
                .map_or("/", |path| path.as_str());
            let mut response = response(StatusCode::MOVED_PERMANENTLY);
            if let Ok(location) = HeaderValue::from_str(&format!("https://{domain}{path}")) {
                response.headers_mut().insert(header::LOCATION, location);
            }
            Ok(response)
        }
    });
    let mut builder =
        hyper_util::server::conn::auto::Builder::new(hyper_util::rt::TokioExecutor::new());
    builder
        .http1()
        .timer(hyper_util::rt::TokioTimer::new())
        .header_read_timeout(std::time::Duration::from_secs(30));
    let _ = builder.serve_connection(TokioIo::new(io), service).await;
}

pub fn count(counter: &AtomicU64) {
    counter.fetch_add(1, Ordering::Relaxed);
}
