//! The real Rust client library against the server, end to end: provisioning, TLS passthrough, shared tunnels,
//! restarts, migrated tunnels, and renewal.

mod common;

use std::time::Duration;

use common::{TestServer, app, eventually, visit};
use opentunnel::protocol::api::CertificateState;
use opentunnel::{Client, ClientOptions, Identity, Routes, State, Storage};

fn client(server: &TestServer, storage: &std::path::Path) -> Client {
    Client::new(ClientOptions {
        api: Some(server.api.parse().unwrap()),
        storage: Some(Storage::at(storage)),
    })
}

fn routes(pairs: &[(&str, &str)]) -> Routes {
    pairs
        .iter()
        .map(|(name, target)| ((*name).to_owned(), (*target).into()))
        .collect()
}

async fn connected(tunnel: &opentunnel::Tunnel) {
    eventually("the tunnel to connect", || async {
        tunnel.status().state == State::Connected
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn provisions_routes_and_deletes() {
    let dir = tempfile::tempdir().unwrap();
    let Some(server) = TestServer::start(dir.path(), &[]).await else {
        return;
    };
    let client = client(&server, &dir.path().join("client"));
    let identity = client.create("default", |_| {}).await.unwrap();
    assert!(identity.hostname.ends_with(".opentunnel.test"));
    assert_eq!(identity.id.len(), 12);

    let target = app("hello from api").await;
    let tunnel = client
        .connect("default", routes(&[("api", &target)]))
        .unwrap();
    connected(&tunnel).await;

    let response = server
        .visit(&format!("api.{}", identity.hostname), "/")
        .await
        .unwrap();
    assert!(response.ends_with("hello from api"), "{response}");

    let info = client
        .api()
        .get(&identity.token, &identity.id)
        .await
        .unwrap();
    assert_eq!(info.state, opentunnel::protocol::api::TunnelState::Online);

    // Unclaimed and unknown routes are refused without reaching an app.
    assert!(server.visit(&identity.hostname, "/").await.is_err());
    assert!(
        server
            .visit(&format!("a.b.{}", identity.hostname), "/")
            .await
            .is_err()
    );

    client.remove("default").await.unwrap();
    eventually("the bridge to close", || async {
        tunnel.status().state != State::Connected
    })
    .await;
    assert!(
        server
            .visit(&format!("api.{}", identity.hostname), "/")
            .await
            .is_err()
    );
    let error = client
        .api()
        .get(&identity.token, &identity.id)
        .await
        .unwrap_err();
    assert!(
        matches!(error, opentunnel::Error::Api { status: 404, .. }),
        "{error}"
    );
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn shares_a_tunnel_between_clients_by_route() {
    let dir = tempfile::tempdir().unwrap();
    let Some(server) = TestServer::start(dir.path(), &[]).await else {
        return;
    };
    let client = client(&server, &dir.path().join("client"));
    let identity = client.create("default", |_| {}).await.unwrap();

    let api = app("from the cli").await;
    let web = app("from an sdk app").await;
    let first = client.connect("default", routes(&[("api", &api)])).unwrap();
    let second = client
        .connect("default", routes(&[("web", &web), ("@", &web)]))
        .unwrap();
    connected(&first).await;
    connected(&second).await;

    let host = &identity.hostname;
    assert!(
        server
            .visit(&format!("api.{host}"), "/")
            .await
            .unwrap()
            .ends_with("from the cli")
    );
    assert!(
        server
            .visit(&format!("web.{host}"), "/")
            .await
            .unwrap()
            .ends_with("from an sdk app")
    );
    assert!(
        server
            .visit(host, "/")
            .await
            .unwrap()
            .ends_with("from an sdk app")
    );

    // A route belongs to one bridge at a time; the other keeps retrying until it is free.
    let third = client.connect("default", routes(&[("api", &web)])).unwrap();
    eventually("route_conflict", || async {
        third
            .status()
            .last_error
            .is_some_and(|error| error.contains("route_conflict"))
    })
    .await;
    first.close().await.unwrap();
    connected(&third).await;
    assert!(
        server
            .visit(&format!("api.{host}"), "/")
            .await
            .unwrap()
            .ends_with("from an sdk app")
    );
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn reconnects_after_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let Some(server) = TestServer::start(dir.path(), &[]).await else {
        return;
    };
    let http = server.http;
    let client = client(&server, &dir.path().join("client"));
    let identity = client.create("default", |_| {}).await.unwrap();
    let target = app("still here").await;
    let tunnel = client
        .connect("default", routes(&[("api", &target)]))
        .unwrap();
    connected(&tunnel).await;
    let session = tunnel.status().session.unwrap();
    server.stop().await;

    let Some(server) =
        TestServer::start_at(dir.path(), &[], http, "127.0.0.1:0".parse().unwrap()).await
    else {
        return;
    };
    eventually("a new session", || async {
        let status = tunnel.status();
        status.state == State::Connected && status.session.as_deref() != Some(session.as_str())
    })
    .await;
    let response = server
        .visit(&format!("api.{}", identity.hostname), "/")
        .await
        .unwrap();
    assert!(response.ends_with("still here"), "{response}");
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_live_tunnels_working_while_the_database_is_down() {
    let dir = tempfile::tempdir().unwrap();
    let Some(proxy) = common::proxied_database(dir.path()).await else {
        return;
    };
    let Some(server) = TestServer::start(dir.path(), &[]).await else {
        return;
    };
    let client = client(&server, &dir.path().join("client"));
    let identity = client.create("default", |_| {}).await.unwrap();
    let target = app("served from memory").await;
    let tunnel = client
        .connect("default", routes(&[("api", &target)]))
        .unwrap();
    connected(&tunnel).await;

    proxy.cut();
    // Visitors still reach the attached client, and the API answers from memory what it can.
    for _ in 0..3 {
        let response = server
            .visit(&format!("api.{}", identity.hostname), "/")
            .await
            .unwrap();
        assert!(response.ends_with("served from memory"), "{response}");
    }
    let info = client
        .api()
        .get(&identity.token, &identity.id)
        .await
        .unwrap();
    assert_eq!(info.state, opentunnel::protocol::api::TunnelState::Online);
    // What needs the database answers 503 instead of failing the server.
    let http = reqwest::Client::new();
    let created = http
        .post(format!("{}/api/tunnel", server.api))
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), 503);
    let body: serde_json::Value = created.json().await.unwrap();
    assert_eq!(body["_tag"], "ServiceUnavailableError");
    assert_eq!(body["message"], "storage unavailable");

    proxy.restore();
    eventually("the database to come back", || async {
        http.post(format!("{}/api/tunnel", server.api))
            .json(&serde_json::json!({}))
            .send()
            .await
            .is_ok_and(|response| response.status() == 201)
    })
    .await;
    assert_eq!(tunnel.status().state, State::Connected);
    server.stop().await;
}

/// A CA standing in for ZeroSSL, which issued the certificates of tunnels exported from the Worker.
fn zerossl() -> (rcgen::Issuer<'static, rcgen::KeyPair>, String) {
    let key = rcgen::KeyPair::generate().unwrap();
    let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
    params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, "Fake ZeroSSL");
    let certificate = params.self_signed(&key).unwrap();
    (rcgen::Issuer::new(params, key), certificate.pem())
}

#[tokio::test(flavor = "multi_thread")]
async fn serves_a_tunnel_migrated_from_the_worker() {
    let dir = tempfile::tempdir().unwrap();
    let Some(server) = TestServer::start(dir.path(), &[]).await else {
        return;
    };

    // A tunnel as the Worker's Durable Object stored it, with its ZeroSSL certificate.
    let id = "migratedtunl";
    let hostname = format!("{id}.opentunnel.test");
    let token = "rly_existing-token-from-the-worker";
    let (issuer, ca) = zerossl();
    let key = rcgen::KeyPair::generate().unwrap();
    let mut params =
        rcgen::CertificateParams::new(vec![hostname.clone(), format!("*.{hostname}")]).unwrap();
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, hostname.clone());
    let csr = params.serialize_request(&key).unwrap().pem().unwrap();
    let certificate = params.signed_by(&key, &issuer).unwrap().pem();
    let record = serde_json::json!({
        "version": 1,
        "id": id,
        "hostname": hostname,
        "tokenHash": opentunnel_server::crypto::hash_token(token),
        "state": "online",
        "createdAt": "2026-10-01T00:00:00.000Z",
        "certificateID": "cert_from-the-worker",
        "certificate": {
            "id": "cert_from-the-worker",
            "state": { "type": "ready", "certificate": certificate, "chain": ca, "expiry": "2099-01-01T00:00:00.000Z" }
        },
        "certificateCsr": csr,
        "certificateIdentifiers": [hostname, format!("*.{hostname}")],
        "certificateStartedAt": "2026-10-01T00:00:00.000Z",
        "lastConnectedAt": "2026-10-08T00:00:00.000Z"
    });
    let export = serde_json::json!({
        "version": 1,
        "exportedAt": "2026-10-09T00:00:00.000Z",
        "records": [{ "objectId": "abc123", "record": record, "alarm": 4102444800000u64 - 30 * 86_400_000 }]
    });
    let http = reqwest::Client::new();
    let imported: serde_json::Value = http
        .post(format!("{}/api/admin/import", server.api))
        .bearer_auth("admin-secret")
        .json(&export)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(imported["inserted"], 1);

    // The installed client's files, untouched by the move.
    let storage = Storage::at(dir.path().join("client"));
    storage
        .save(
            "default",
            &Identity {
                id: id.into(),
                hostname: hostname.clone(),
                token: token.into(),
                private_key: key.serialize_pem(),
                certificate: certificate.clone(),
                chain: ca.clone(),
                certificate_expiry: "2099-01-01T00:00:00.000Z".into(),
            },
        )
        .unwrap();
    let client = client(&server, &dir.path().join("client"));
    let ensured = client.ensure("default").await.unwrap();
    assert_eq!(ensured.certificate, certificate);
    let target = app("migrated").await;
    let tunnel = client
        .connect("default", routes(&[("api", &target)]))
        .unwrap();
    connected(&tunnel).await;
    let response = visit(server.tls, &ca, &format!("api.{hostname}"), "/")
        .await
        .unwrap();
    assert!(response.ends_with("migrated"), "{response}");

    // Importing again does not overwrite what this server has changed since.
    let again: serde_json::Value = http
        .post(format!("{}/api/admin/import", server.api))
        .bearer_auth("admin-secret")
        .json(&export)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(again["kept_local"], 1);
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn renews_on_attach_when_the_certificate_is_due() {
    let dir = tempfile::tempdir().unwrap();
    // Certificates valid for 20 days are inside the 30-day renewal window from the start.
    let Some(server) = TestServer::start(dir.path(), &["--local-ca-validity-days=20"]).await else {
        return;
    };
    let client = client(&server, &dir.path().join("client"));
    let identity = client.create("default", |_| {}).await.unwrap();
    let first = client
        .api()
        .certificate(&identity.token, &identity.id)
        .await
        .unwrap();

    let target = app("renewed").await;
    let tunnel = client
        .connect("default", routes(&[("api", &target)]))
        .unwrap();
    connected(&tunnel).await;
    eventually("a renewed certificate", || async {
        let current = client
            .api()
            .certificate(&identity.token, &identity.id)
            .await
            .unwrap();
        current.id != first.id && matches!(current.state, CertificateState::Ready { .. })
    })
    .await;
    let renewed = client
        .api()
        .certificate(&identity.token, &identity.id)
        .await
        .unwrap();
    let (
        CertificateState::Ready {
            certificate: old, ..
        },
        CertificateState::Ready {
            certificate: new, ..
        },
    ) = (&first.state, &renewed.state)
    else {
        panic!("both certificates are ready");
    };
    assert_ne!(old, new);
    let info = client
        .api()
        .get(&identity.token, &identity.id)
        .await
        .unwrap();
    // The Worker sent `certificateID`; the Rust client's type reads `certificateId` and ignores it.
    assert!(info.certificate_id.is_none());

    // The old certificate kept serving until the new one was ready, and the client still answers.
    let response = server
        .visit(&format!("api.{}", identity.hostname), "/")
        .await
        .unwrap();
    assert!(response.ends_with("renewed"));
    tokio::time::sleep(Duration::from_millis(10)).await;
    server.stop().await;
}

/// A bridge the client closes, cleanly or by dropping its connection, leaves nothing running on the server.
#[tokio::test(flavor = "multi_thread")]
async fn ends_bridge_sessions_the_client_closes() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    let dir = tempfile::tempdir().unwrap();
    let Some(server) = TestServer::start(dir.path(), &[]).await else {
        return;
    };
    let client = client(&server, &dir.path().join("client"));
    let identity = client.create("default", |_| {}).await.unwrap();
    let tasks = || {
        tokio::runtime::Handle::current()
            .metrics()
            .num_alive_tasks()
    };
    let before = tasks();
    for clean in [true, false, true, false] {
        let mut request = format!(
            "{}/api/tunnel/{}/connect",
            server.api.replace("http", "ws"),
            identity.id
        )
        .into_client_request()
        .unwrap();
        request
            .headers_mut()
            .insert("sec-websocket-protocol", "opentunnel".parse().unwrap());
        let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        let attach =
            serde_json::json!({ "type": "attach", "token": identity.token, "routes": ["api"] });
        socket
            .send(Message::text(attach.to_string()))
            .await
            .unwrap();
        let attached = socket.next().await.unwrap().unwrap();
        assert!(
            attached.to_text().unwrap().contains("\"attached\""),
            "{attached}"
        );
        if clean {
            socket.close(None).await.unwrap();
            tokio::time::timeout(Duration::from_secs(5), async {
                while socket.next().await.is_some() {}
            })
            .await
            .expect("the server completes the close");
        } else {
            drop(socket);
        }
    }
    eventually("the bridge tasks to end", || async { tasks() <= before }).await;
    server.stop().await;
}
