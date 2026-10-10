//! The temporary migration paths against a fake Worker: public connections for tunnels whose client is still
//! on the Worker go to its `/api/relay`, and unknown tunnels are imported from its export endpoint on first use.

mod common;

use std::convert::Infallible;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use common::TestServer;
use futures_util::{SinkExt, StreamExt};
use http_body_util::Full;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::Role;

const TOKEN: &str = "rly_pulled";

fn client_hello(sni: &str) -> Vec<u8> {
    let u16be = |n: usize| [(n >> 8) as u8, n as u8];
    let name = sni.as_bytes();
    let mut names = vec![0u8];
    names.extend(u16be(name.len()));
    names.extend(name);
    let mut list = u16be(names.len()).to_vec();
    list.extend(names);
    let mut extensions = vec![0, 0];
    extensions.extend(u16be(list.len()));
    extensions.extend(list);
    let mut hello = vec![3, 3];
    hello.extend([0u8; 32]);
    hello.extend([0, 0, 2, 0x13, 1, 1, 0]);
    hello.extend(u16be(extensions.len()));
    hello.extend(extensions);
    let mut handshake = vec![1, 0];
    handshake.extend(u16be(hello.len()));
    handshake.extend(hello);
    let mut record = vec![0x16, 3, 1];
    record.extend(u16be(handshake.len()));
    record.extend(handshake);
    record
}

#[derive(Default)]
struct Worker {
    relayed: Mutex<Vec<String>>,
    exports: Mutex<Vec<String>>,
}

fn pulled_record() -> serde_json::Value {
    serde_json::json!({
        "version": 1,
        "id": "pulledtunnel",
        "hostname": "pulledtunnel.opentunnel.test",
        "tokenHash": opentunnel_server::crypto::hash_token(TOKEN),
        "state": "offline",
        "createdAt": "2026-10-09T00:00:00.000Z"
    })
}

async fn fake_worker() -> (String, Arc<Worker>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let worker = Arc::new(Worker::default());
    let state = worker.clone();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let state = state.clone();
            tokio::spawn(async move {
                let service = hyper::service::service_fn(
                    move |mut request: Request<hyper::body::Incoming>| {
                        let state = state.clone();
                        async move {
                            let path = request.uri().path().to_owned();
                            if path == "/api/relay" {
                                assert!(
                                    request
                                        .uri()
                                        .query()
                                        .unwrap()
                                        .contains("token=relay-secret")
                                );
                                let key =
                                    request.headers()["sec-websocket-key"].as_bytes().to_owned();
                                let upgrade = hyper::upgrade::on(&mut request);
                                let state = state.clone();
                                tokio::spawn(async move {
                                    let upgraded = upgrade.await.unwrap();
                                    let mut socket = WebSocketStream::from_raw_socket(
                                        TokioIo::new(upgraded),
                                        Role::Server,
                                        None,
                                    )
                                    .await;
                                    // The Worker parses the ClientHello, routes it, and answers.
                                    let Some(Ok(Message::Binary(hello))) = socket.next().await
                                    else {
                                        return;
                                    };
                                    state
                                        .relayed
                                        .lock()
                                        .unwrap()
                                        .push(String::from_utf8_lossy(&hello).into_owned());
                                    socket
                                        .send(Message::Binary(Bytes::from(format!(
                                            "relayed {} bytes",
                                            hello.len()
                                        ))))
                                        .await
                                        .unwrap();
                                    socket
                                        .send(Message::text(r#"{"type":"end"}"#))
                                        .await
                                        .unwrap();
                                    let _ = socket.close(None).await;
                                });
                                let mut response = Response::new(Full::new(Bytes::new()));
                                *response.status_mut() = hyper::StatusCode::SWITCHING_PROTOCOLS;
                                let headers = response.headers_mut();
                                headers.insert("upgrade", "websocket".parse().unwrap());
                                headers.insert("connection", "Upgrade".parse().unwrap());
                                headers.insert(
                                    "sec-websocket-accept",
                                    derive_accept_key(&key).parse().unwrap(),
                                );
                                return Ok::<_, Infallible>(response);
                            }
                            assert_eq!(path, "/api/admin/export");
                            assert_eq!(request.headers()["authorization"], "Bearer export-secret");
                            let body = http_body_util::BodyExt::collect(request.into_body())
                                .await
                                .unwrap()
                                .to_bytes();
                            let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
                            let name = body["names"][0].as_str().unwrap().to_owned();
                            state.exports.lock().unwrap().push(name.clone());
                            let record = (name == "pulledtunnel").then(pulled_record);
                            let reply = serde_json::json!({
                                "records": [{ "objectId": "hex", "name": name, "record": record, "alarm": null }]
                            });
                            let mut response =
                                Response::new(Full::new(Bytes::from(reply.to_string())));
                            response
                                .headers_mut()
                                .insert("content-type", "application/json".parse().unwrap());
                            Ok(response)
                        }
                    },
                );
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service)
                    .with_upgrades()
                    .await;
            });
        }
    });
    (url, worker)
}

#[tokio::test(flavor = "multi_thread")]
async fn hands_connections_without_a_local_bridge_to_the_worker() {
    let (url, worker) = fake_worker().await;
    let dir = tempfile::tempdir().unwrap();
    let legacy = format!("--legacy-worker-url={url}");
    let Some(server) = TestServer::start(
        dir.path(),
        &[
            &legacy,
            "--relay-token=relay-secret",
            "--legacy-export-token=export-secret",
        ],
    )
    .await
    else {
        return;
    };

    let hello = client_hello("api.stillonwrkr.opentunnel.test");
    let mut visitor = TcpStream::connect(server.tls).await.unwrap();
    visitor.write_all(&hello).await.unwrap();
    let mut reply = String::new();
    visitor.read_to_string(&mut reply).await.unwrap();
    assert_eq!(reply, format!("relayed {} bytes", hello.len()));
    assert_eq!(
        worker.relayed.lock().unwrap().as_slice(),
        [String::from_utf8_lossy(&hello).into_owned()]
    );
    assert_eq!(
        server
            .server
            .app
            .stats
            .legacy_forwarded
            .load(std::sync::atomic::Ordering::Relaxed),
        1
    );
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn imports_unknown_tunnels_from_the_worker_on_first_use() {
    let (url, worker) = fake_worker().await;
    let dir = tempfile::tempdir().unwrap();
    let legacy = format!("--legacy-worker-url={url}");
    let Some(server) = TestServer::start(
        dir.path(),
        &[
            &legacy,
            "--relay-token=relay-secret",
            "--legacy-export-token=export-secret",
        ],
    )
    .await
    else {
        return;
    };
    let http = reqwest::Client::new();
    let response = http
        .get(format!("{}/api/tunnel/pulledtunnel", server.api))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["hostname"], "pulledtunnel.opentunnel.test");
    assert!(
        server
            .service()
            .store
            .tunnel("pulledtunnel")
            .await
            .unwrap()
            .is_some()
    );

    // Misses are remembered, and IDs that cannot be tunnels are never looked up.
    for _ in 0..3 {
        let response = http
            .get(format!("{}/api/tunnel/missingtunnl", server.api))
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 404);
    }
    let response = http
        .get(format!("{}/api/tunnel/x", server.api))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 404);
    let exports = worker.exports.lock().unwrap().clone();
    assert_eq!(exports, ["pulledtunnel", "missingtunnl"]);
    server.stop().await;
}
