use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use opentunnel::protocol::bridge::{decode_data_frame, encode_data_frame};
use opentunnel::protocol::{ClientMessage, ServerMessage};
use opentunnel::{
    Client, ClientOptions, Event, Identity, ProxyProtocol, Route, Routes, Storage, Tunnel,
};
use rcgen::{CertificateParams, KeyPair};
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, ServerName};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::http::HeaderValue;

const HOSTNAME: &str = "demo.test";
const TOKEN: &str = "secret-token";

fn identity() -> Identity {
    let key = KeyPair::generate().unwrap();
    let params =
        CertificateParams::new(vec![HOSTNAME.to_owned(), format!("*.{HOSTNAME}")]).unwrap();
    let certificate = params.self_signed(&key).unwrap();
    Identity {
        id: "demo".into(),
        hostname: HOSTNAME.into(),
        token: TOKEN.into(),
        private_key: key.serialize_pem(),
        certificate: certificate.pem(),
        chain: String::new(),
        certificate_expiry: "2099-01-01T00:00:00.000Z".into(),
    }
}

async fn echo_server() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap().to_string();
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let mut buffer = [0u8; 1024];
                loop {
                    let read = socket.read(&mut buffer).await.unwrap_or(0);
                    if read == 0 {
                        return;
                    }
                    let mut reply = b"echo:".to_vec();
                    reply.extend_from_slice(&buffer[..read]);
                    socket.write_all(&reply).await.unwrap();
                }
            });
        }
    });
    address
}

type Bridge = WebSocketStream<TcpStream>;

/// The certificate the fake API reports, as (certificate, chain).
type ServedCertificate = Arc<Mutex<Option<(String, String)>>>;

/// Serves the certificate endpoint and accepts bridge sessions, handing each
/// attached socket to the test.
async fn fake_relay(
    attach_reply: impl Fn() -> ServerMessage + Send + 'static,
) -> (
    String,
    mpsc::Receiver<(Bridge, Vec<String>)>,
    ServedCertificate,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let (sessions, receiver) = mpsc::channel(8);
    let served: ServedCertificate = Arc::default();
    let certificate = served.clone();
    tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut head = [0u8; 64];
            let read = stream.peek(&mut head).await.unwrap();
            if String::from_utf8_lossy(&head[..read])
                .starts_with("GET /api/tunnel/demo/certificate")
            {
                let body = match certificate.lock().unwrap().clone() {
                    Some((certificate, chain)) => serde_json::json!({
                        "id": "cert_renewed",
                        "state": { "type": "ready", "certificate": certificate, "chain": chain, "expiry": "2099-06-01T00:00:00.000Z" },
                    })
                    .to_string(),
                    None => String::new(),
                };
                let status = if body.is_empty() {
                    "404 Not Found"
                } else {
                    "200 OK"
                };
                let mut request = vec![0u8; 4096];
                let _ = stream.read(&mut request).await;
                let response = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
                continue;
            }
            #[allow(clippy::result_large_err)]
            let callback = |request: &Request, mut response: Response| {
                assert_eq!(request.uri().path(), "/api/tunnel/demo/connect");
                response.headers_mut().insert(
                    "sec-websocket-protocol",
                    HeaderValue::from_static("opentunnel"),
                );
                Ok(response)
            };
            let mut socket = tokio_tungstenite::accept_hdr_async(stream, callback)
                .await
                .unwrap();
            let Some(Ok(Message::Text(text))) = socket.next().await else {
                panic!("expected attach")
            };
            let ClientMessage::Attach { token, routes, .. } = serde_json::from_str(&text).unwrap()
            else {
                panic!("expected attach")
            };
            assert_eq!(token, TOKEN);
            let reply = attach_reply();
            let attached = matches!(reply, ServerMessage::Attached { .. });
            socket
                .send(Message::text(serde_json::to_string(&reply).unwrap()))
                .await
                .unwrap();
            if attached {
                sessions.send((socket, routes)).await.unwrap();
            }
        }
    });
    (base, receiver, served)
}

fn attached() -> ServerMessage {
    ServerMessage::Attached {
        session: "sess_test".into(),
        routes: vec![],
        heartbeat_ms: 15_000,
        idle_timeout_ms: 45_000,
    }
}

/// Saves `identity` to a fresh storage directory and connects it.
fn connect(base: &str, identity: &Identity, routes: Routes) -> (Tunnel, Storage) {
    let storage = Storage::at(std::env::temp_dir().join(format!(
        "opentunnel-test-{}-{}",
        std::process::id(),
        rand_suffix()
    )));
    storage.save("default", identity).unwrap();
    let client = Client::new(ClientOptions {
        api: Some(base.parse().unwrap()),
        storage: Some(storage.clone()),
    });
    (client.connect("default", routes).unwrap(), storage)
}

fn rand_suffix() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

async fn send_open(bridge: &mut Bridge, conn: u32, sni: &str) {
    send_open_from(bridge, conn, sni, "203.0.113.9").await;
}

async fn send_open_from(bridge: &mut Bridge, conn: u32, sni: &str, peer: &str) {
    let open = ServerMessage::Open {
        conn,
        peer: peer.into(),
        sni: sni.into(),
        alpn: String::new(),
    };
    bridge
        .send(Message::text(serde_json::to_string(&open).unwrap()))
        .await
        .unwrap();
}

async fn pump(bridge: Bridge, conn: u32, relay_side: DuplexStream) -> Vec<ClientMessage> {
    let (mut sink, mut stream) = bridge.split();
    let (mut relay_read, mut relay_write) = tokio::io::split(relay_side);
    let upload = tokio::spawn(async move {
        let mut buffer = vec![0u8; 32 * 1024];
        loop {
            let read = relay_read.read(&mut buffer).await.unwrap_or(0);
            if read == 0 {
                return;
            }
            let frame = Message::binary(encode_data_frame(conn, &buffer[..read]));
            if sink.send(frame).await.is_err() {
                return;
            }
        }
    });
    let mut controls = Vec::new();
    while let Some(Ok(message)) = stream.next().await {
        match message {
            Message::Binary(frame) => {
                let (id, payload) = decode_data_frame(&frame).unwrap();
                assert_eq!(id, conn);
                let _ = relay_write.write_all(payload).await;
            }
            Message::Text(text) => {
                let message: ClientMessage = serde_json::from_str(&text).unwrap();
                let done = matches!(
                    message,
                    ClientMessage::End { .. } | ClientMessage::Reset { .. }
                );
                controls.push(message);
                if done {
                    break;
                }
            }
            _ => {}
        }
    }
    upload.abort();
    controls
}

fn connector(identity: &Identity) -> tokio_rustls::TlsConnector {
    let mut roots = rustls::RootCertStore::empty();
    roots
        .add(CertificateDer::from_pem_slice(identity.certificate.as_bytes()).unwrap())
        .unwrap();
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_root_certificates(roots)
    .with_no_client_auth();
    tokio_rustls::TlsConnector::from(Arc::new(config))
}

#[tokio::test]
async fn forwards_tls_to_route_target() {
    let target = echo_server().await;
    let (base, mut sessions, _) = fake_relay(attached).await;
    let identity = identity();
    let routes: Routes = [("api".into(), target.into())].into();
    let (tunnel, _) = connect(&base, &identity, routes);

    let (mut bridge, attached_routes) = sessions.recv().await.unwrap();
    assert_eq!(attached_routes, vec!["api".to_string()]);

    let (public, relay_side) = tokio::io::duplex(64 * 1024);
    send_open(&mut bridge, 7, &format!("api.{HOSTNAME}")).await;
    let pumping = tokio::spawn(pump(bridge, 7, relay_side));

    let name = ServerName::try_from(format!("api.{HOSTNAME}")).unwrap();
    let mut tls = connector(&identity).connect(name, public).await.unwrap();
    tls.write_all(b"hello").await.unwrap();
    tls.flush().await.unwrap();
    let mut reply = [0u8; 10];
    tls.read_exact(&mut reply).await.unwrap();
    assert_eq!(&reply, b"echo:hello");

    let (mut reader, mut writer) = tokio::io::split(tls);
    let large = vec![b'x'; 200_000];
    let expected = large.len();
    let writing = tokio::spawn(async move {
        writer.write_all(&large).await.unwrap();
        writer.flush().await.unwrap();
        writer
    });
    let mut received = 0;
    let mut buffer = vec![0u8; 64 * 1024];
    while received < expected {
        let read = reader.read(&mut buffer).await.unwrap();
        received += buffer[..read].iter().filter(|byte| **byte == b'x').count();
    }
    let mut tls = reader.unsplit(writing.await.unwrap());

    tls.shutdown().await.unwrap();
    drop(tls);
    let controls = tokio::time::timeout(Duration::from_secs(5), pumping)
        .await
        .unwrap()
        .unwrap();
    assert!(
        controls.iter().any(|message| matches!(
            message,
            ClientMessage::End { conn: 7 } | ClientMessage::Reset { conn: 7, .. }
        )),
        "{controls:?}"
    );
    tunnel.close().await.unwrap();
}

#[tokio::test]
async fn resets_unknown_routes() {
    let target = echo_server().await;
    let (base, mut sessions, _) = fake_relay(attached).await;
    let (tunnel, _) = connect(&base, &identity(), [("api".into(), target.into())].into());
    let (mut bridge, _) = sessions.recv().await.unwrap();
    send_open(&mut bridge, 3, &format!("admin.{HOSTNAME}")).await;
    let reply = loop {
        let Some(Ok(Message::Text(text))) = bridge.next().await else {
            panic!("bridge closed")
        };
        let message: ClientMessage = serde_json::from_str(&text).unwrap();
        if !matches!(message, ClientMessage::Ping { .. }) {
            break message;
        }
    };
    assert_eq!(
        reply,
        ClientMessage::Reset {
            conn: 3,
            code: "unknown_route".into()
        }
    );
    tunnel.close().await.unwrap();
}

#[tokio::test]
async fn resets_connections_beyond_max_conns() {
    let target = echo_server().await;
    let (base, mut sessions, _) = fake_relay(attached).await;
    let (tunnel, _) = connect(&base, &identity(), [("api".into(), target.into())].into());
    let (mut bridge, _) = sessions.recv().await.unwrap();
    for conn in 1..=257 {
        send_open(&mut bridge, conn, &format!("api.{HOSTNAME}")).await;
    }
    let reply = loop {
        let Some(Ok(Message::Text(text))) = bridge.next().await else {
            panic!("bridge closed")
        };
        let message: ClientMessage = serde_json::from_str(&text).unwrap();
        if !matches!(message, ClientMessage::Ping { .. }) {
            break message;
        }
    };
    assert_eq!(
        reply,
        ClientMessage::Reset {
            conn: 257,
            code: "too_many_connections".into()
        }
    );
    tunnel.close().await.unwrap();
}

#[tokio::test]
async fn reconnects_after_bridge_closes() {
    let target = echo_server().await;
    let (base, mut sessions, _) = fake_relay(attached).await;
    let (tunnel, _) = connect(&base, &identity(), [("api".into(), target.into())].into());
    let mut events = tunnel.subscribe();
    let (mut bridge, _) = sessions.recv().await.unwrap();
    bridge.close(None).await.unwrap();
    let (_second, _) = tokio::time::timeout(Duration::from_secs(5), sessions.recv())
        .await
        .unwrap()
        .unwrap();
    let mut saw_reconnecting = false;
    while let Ok(event) = events.try_recv() {
        saw_reconnecting |= matches!(event, Event::Reconnecting { .. });
    }
    assert!(saw_reconnecting);
    tunnel.close().await.unwrap();
}

#[tokio::test]
async fn reattaches_when_route_names_change() {
    let target = echo_server().await;
    let (base, mut sessions, _) = fake_relay(attached).await;
    let (tunnel, _) = connect(
        &base,
        &identity(),
        [("api".into(), target.clone().into())].into(),
    );
    let (_first, routes) = sessions.recv().await.unwrap();
    assert_eq!(routes, vec!["api".to_string()]);

    tunnel
        .set_routes([("api".into(), "127.0.0.1:9".into())].into())
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(300), sessions.recv())
            .await
            .is_err(),
        "changing a target must not re-attach"
    );

    tunnel
        .set_routes(
            [
                ("api".into(), target.clone().into()),
                ("@".into(), target.into()),
            ]
            .into(),
        )
        .unwrap();
    let (_second, routes) = tokio::time::timeout(Duration::from_secs(5), sessions.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(routes, vec!["@".to_string(), "api".to_string()]);
    tunnel.close().await.unwrap();
}

#[tokio::test]
async fn stops_on_fatal_attach_error() {
    let (base, _sessions, _) = fake_relay(|| ServerMessage::AttachError {
        code: "bad_token".into(),
    })
    .await;
    let (mut tunnel, _) = connect(
        &base,
        &identity(),
        [("api".into(), "127.0.0.1:1".into())].into(),
    );
    let result = tokio::time::timeout(Duration::from_secs(5), tunnel.wait())
        .await
        .unwrap();
    assert!(matches!(result, Err(opentunnel::Error::Attach(code)) if code == "bad_token"));
}

#[tokio::test]
async fn picks_up_renewed_certificates() {
    let target = echo_server().await;
    let (base, mut sessions, served) = fake_relay(attached).await;
    let original = identity();

    // A renewal reuses the key: same private key, new certificate.
    let key = KeyPair::from_pem(&original.private_key).unwrap();
    let params =
        CertificateParams::new(vec![HOSTNAME.to_owned(), format!("*.{HOSTNAME}")]).unwrap();
    let renewed = params.self_signed(&key).unwrap().pem();
    *served.lock().unwrap() = Some((renewed.clone(), String::new()));

    let (tunnel, storage) = connect(&base, &original, [("api".into(), target.into())].into());
    let mut events = tunnel.subscribe();
    let mut bridge = sessions.recv().await.unwrap().0;
    let expiry = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(Event::CertificateRenewed { expiry }) = events.recv().await {
                return expiry;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(expiry, "2099-06-01T00:00:00.000Z");
    let saved = storage.load("default").unwrap().unwrap();
    assert_eq!(saved.certificate, renewed);
    assert_eq!(saved.private_key, original.private_key);

    // New connections present the renewed certificate.
    let (public, relay_side) = tokio::io::duplex(64 * 1024);
    send_open(&mut bridge, 9, &format!("api.{HOSTNAME}")).await;
    tokio::spawn(pump(bridge, 9, relay_side));
    let renewed_identity = Identity {
        certificate: renewed.clone(),
        ..original
    };
    let name = ServerName::try_from(format!("api.{HOSTNAME}")).unwrap();
    let tls = connector(&renewed_identity)
        .connect(name, public)
        .await
        .unwrap();
    let presented = tls.get_ref().1.peer_certificates().unwrap()[0].clone();
    assert_eq!(
        presented,
        CertificateDer::from_pem_slice(renewed.as_bytes()).unwrap()
    );
    tunnel.close().await.unwrap();
}

/// A target that records everything each connection sends until it closes.
async fn recording_server() -> (String, mpsc::Receiver<Vec<u8>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let (received, receiver) = mpsc::channel(8);
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let received = received.clone();
            tokio::spawn(async move {
                let mut bytes = Vec::new();
                let _ = socket.read_to_end(&mut bytes).await;
                let _ = received.send(bytes).await;
            });
        }
    });
    (address, receiver)
}

/// Sends `payload` through a public TLS connection to `route` and returns what the target got.
async fn deliver(route: Route, peer: &str, payload: &[u8]) -> Vec<u8> {
    let (target, mut received) = recording_server().await;
    let (base, mut sessions, _) = fake_relay(attached).await;
    let identity = identity();
    let route = Route { target, ..route };
    let (tunnel, _) = connect(&base, &identity, [("api".into(), route)].into());
    let (mut bridge, _) = sessions.recv().await.unwrap();
    let (public, relay_side) = tokio::io::duplex(64 * 1024);
    send_open_from(&mut bridge, 5, &format!("api.{HOSTNAME}"), peer).await;
    tokio::spawn(pump(bridge, 5, relay_side));
    let name = ServerName::try_from(format!("api.{HOSTNAME}")).unwrap();
    let mut tls = connector(&identity).connect(name, public).await.unwrap();
    tls.write_all(payload).await.unwrap();
    tls.shutdown().await.unwrap();
    let bytes = tokio::time::timeout(Duration::from_secs(5), received.recv())
        .await
        .unwrap()
        .unwrap();
    drop(tls);
    tunnel.close().await.unwrap();
    bytes
}

#[tokio::test]
async fn default_routes_forward_bytes_unchanged() {
    let payload = b"GET / HTTP/1.1\r\nHost: x\r\n\r\n";
    let received = deliver(Route::new(""), "203.0.113.9:51234", payload).await;
    assert_eq!(received, payload);
}

#[tokio::test]
async fn writes_a_proxy_v1_header_before_the_payload() {
    let route = Route::new("").with_proxy_protocol(Some(ProxyProtocol::V1));
    let received = deliver(route, "203.0.113.9:51234", b"hello").await;
    assert_eq!(
        received,
        b"PROXY TCP4 203.0.113.9 0.0.0.0 51234 443\r\nhello".as_slice()
    );
}

#[tokio::test]
async fn writes_a_proxy_v2_header_before_the_payload() {
    let route = Route::new("").with_proxy_protocol(Some(ProxyProtocol::V2));
    let received = deliver(route, "[2001:db8::1]:443", b"hello").await;
    let header = opentunnel::protocol::proxy::header(
        ProxyProtocol::V2,
        "[2001:db8::1]:443",
        &format!("api.{HOSTNAME}"),
    );
    assert_eq!(&received[..12], b"\r\n\r\n\0\r\nQUIT\n");
    assert_eq!(&received[12..14], &[0x21, 0x21]);
    assert_eq!(&received[..header.len()], header.as_slice());
    assert!(received.ends_with(format!("\x02\x00\x0dapi.{HOSTNAME}hello").as_bytes()));
}
