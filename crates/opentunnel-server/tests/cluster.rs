//! Several servers on one database, as machines in several regions: visitors reach a bridge attached to
//! another machine, deletes and route conflicts cross machines, a crashed machine stops receiving visitors once
//! its registry rows expire, and background jobs run once.

mod common;

use std::sync::atomic::Ordering;
use std::time::Duration;

use common::{TestServer, app, eventually};
use opentunnel::{Client, ClientOptions, Routes, State, Storage};
use opentunnel_server::issuer::Issuer;
use opentunnel_server::store::{Job, JobKind};

const HEARTBEAT_MS: u64 = 300;

async fn machine(dir: &std::path::Path, name: &str, region: &str) -> Option<TestServer> {
    TestServer::start(
        dir,
        &[
            "--internal-listen=127.0.0.1:0",
            "--internal-token=cluster-secret",
            &format!("--machine-id={name}"),
            &format!("--region={region}"),
            &format!("--cluster-heartbeat-ms={HEARTBEAT_MS}"),
        ],
    )
    .await
}

fn client(server: &TestServer, storage: &std::path::Path) -> Client {
    Client::new(ClientOptions {
        api: Some(server.api.parse().unwrap()),
        storage: Some(Storage::at(storage)),
    })
}

fn routes(pairs: &[(&str, &str)]) -> Routes {
    pairs
        .iter()
        .map(|(name, target)| ((*name).to_owned(), (*target).to_owned()))
        .collect()
}

async fn connected(tunnel: &opentunnel::Tunnel) {
    eventually("the tunnel to connect", || async {
        tunnel.status().state == State::Connected
    })
    .await;
}

async fn stats(server: &TestServer) -> serde_json::Value {
    reqwest::Client::new()
        .post(format!("{}/api/admin/stats", server.api))
        .bearer_auth("admin-secret")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn forwards_visitors_and_control_between_machines() {
    let dir = tempfile::tempdir().unwrap();
    let Some(a) = machine(dir.path(), "machine-a", "iad").await else {
        return;
    };
    let b = machine(dir.path(), "machine-b", "syd").await.unwrap();

    // The client attaches to A; a visitor arrives at B.
    let storage = dir.path().join("client");
    let on_a = client(&a, &storage);
    let identity = on_a.create("default", |_| {}).await.unwrap();
    let host = identity.hostname.clone();
    let api = app("from the client on a").await;
    let tunnel = on_a.connect("default", routes(&[("api", &api)])).unwrap();
    connected(&tunnel).await;
    for _ in 0..3 {
        let response = b.visit(&format!("api.{host}"), "/").await.unwrap();
        assert!(response.ends_with("from the client on a"), "{response}");
    }
    assert_eq!(b.server.app.stats.forwarded_out.load(Ordering::Relaxed), 3);
    assert_eq!(a.server.app.stats.forwarded_in.load(Ordering::Relaxed), 3);
    // A route nobody serves is refused on both, and never loops.
    assert!(b.visit(&host, "/").await.is_err());

    // B reports the tunnel online and both machines in its stats.
    let on_b = client(&b, &storage);
    let info = on_b.api().get(&identity.token, &identity.id).await.unwrap();
    assert_eq!(info.state, opentunnel::protocol::api::TunnelState::Online);
    let report = stats(&b).await;
    assert_eq!(report["machine"]["id"], "machine-b");
    assert_eq!(report["machine"]["forwarded_out"], 3);
    assert_eq!(report["cluster"]["bridges"], 1);
    assert_eq!(report["cluster"]["regions"]["iad"], 1);
    assert_eq!(report["cluster"]["machines"][0]["machine_id"], "machine-a");

    // Routes are exclusive across machines: a second client on B cannot take `api`, but can serve `web`,
    // which visitors arriving at A then reach.
    let web = app("from the client on b").await;
    let conflicting = on_b.connect("default", routes(&[("api", &web)])).unwrap();
    eventually("route_conflict", || async {
        conflicting
            .status()
            .last_error
            .is_some_and(|error| error.contains("route_conflict"))
    })
    .await;
    conflicting.close().await.unwrap();
    let second = on_b
        .connect("default", routes(&[("web", &web), ("@", &web)]))
        .unwrap();
    connected(&second).await;
    let response = a.visit(&format!("web.{host}"), "/").await.unwrap();
    assert!(response.ends_with("from the client on b"), "{response}");
    let response = a.visit(&host, "/").await.unwrap();
    assert!(response.ends_with("from the client on b"), "{response}");
    let response = b.visit(&format!("api.{host}"), "/").await.unwrap();
    assert!(response.ends_with("from the client on a"), "{response}");

    // Once A's client goes, B's lookups find nothing and B refuses `api` again (after its cached location is
    // refused by A).
    tunnel.close().await.unwrap();
    eventually("A to drop the route", || async {
        b.server
            .cluster
            .as_ref()
            .unwrap()
            .locate(&identity.id, "api", true)
            .await
            .is_none()
    })
    .await;
    assert!(b.visit(&format!("api.{host}"), "/").await.is_err());
    let tunnel = on_a.connect("default", routes(&[("api", &api)])).unwrap();
    connected(&tunnel).await;

    // Deleting through B closes the bridges on A too.
    on_b.remove("default").await.unwrap();
    eventually("A's bridge to close", || async {
        tunnel.status().state != State::Connected
    })
    .await;
    eventually("B's bridge to close", || async {
        second.status().state != State::Connected
    })
    .await;
    assert!(b.visit(&format!("api.{host}"), "/").await.is_err());
    assert!(a.visit(&format!("api.{host}"), "/").await.is_err());
    eventually("the registry to empty", || async {
        stats(&b).await["cluster"]["bridges"] == 0
    })
    .await;
    a.stop().await;
    b.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn stops_forwarding_to_a_machine_that_crashed() {
    let dir = tempfile::tempdir().unwrap();
    let Some(a) = machine(dir.path(), "machine-a", "iad").await else {
        return;
    };
    let b = machine(dir.path(), "machine-b", "fra").await.unwrap();
    let on_a = client(&a, &dir.path().join("client"));
    let identity = on_a.create("default", |_| {}).await.unwrap();
    let api = app("before the crash").await;
    let tunnel = on_a.connect("default", routes(&[("api", &api)])).unwrap();
    connected(&tunnel).await;
    let sni = format!("api.{}", identity.hostname);
    assert!(
        b.visit(&sni, "/")
            .await
            .unwrap()
            .ends_with("before the crash")
    );

    // A's listeners and heartbeat stop without removing its rows.
    a.crash();
    let cluster = b.server.cluster.as_ref().unwrap();
    assert!(b.visit(&sni, "/").await.is_err());
    assert!(b.server.app.stats.forward_failures.load(Ordering::Relaxed) >= 1);
    // The rows expire after three missed heartbeats, so even a fresh lookup finds nothing.
    tokio::time::sleep(Duration::from_millis(3 * HEARTBEAT_MS + 100)).await;
    eventually("A's rows to expire", || async {
        cluster.locate(&identity.id, "api", true).await.is_none()
    })
    .await;
    assert!(
        stats(&b).await["cluster"]["machines"]
            .as_array()
            .unwrap()
            .iter()
            .all(|machine| machine["machine_id"] != "machine-a")
    );

    // The client moves to B, which accepts its routes and serves them.
    let on_b = client(&b, &dir.path().join("client"));
    let moved = on_b.connect("default", routes(&[("api", &api)])).unwrap();
    connected(&moved).await;
    assert!(
        b.visit(&sni, "/")
            .await
            .unwrap()
            .ends_with("before the crash")
    );
    drop(tunnel);
    b.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_restarted_machine_clears_its_old_rows() {
    let dir = tempfile::tempdir().unwrap();
    let Some(a) = machine(dir.path(), "machine-a", "iad").await else {
        return;
    };
    let on_a = client(&a, &dir.path().join("client"));
    on_a.create("default", |_| {}).await.unwrap();
    let api = app("x").await;
    let tunnel = on_a.connect("default", routes(&[("api", &api)])).unwrap();
    connected(&tunnel).await;
    assert_eq!(stats(&a).await["cluster"]["bridges"], 1);
    a.crash();
    drop(tunnel);
    let restarted = machine(dir.path(), "machine-a", "iad").await.unwrap();
    assert_eq!(stats(&restarted).await["cluster"]["bridges"], 0);
    restarted.stop().await;
}

fn csr(hostname: &str) -> String {
    let key = rcgen::KeyPair::generate().unwrap();
    let mut params = rcgen::CertificateParams::new(vec![hostname.to_owned()]).unwrap();
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, hostname);
    params.serialize_request(&key).unwrap().pem().unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn runs_each_job_once_across_machines() {
    let dir = tempfile::tempdir().unwrap();
    let Some(a) = machine(dir.path(), "machine-a", "iad").await else {
        return;
    };
    let b = machine(dir.path(), "machine-b", "nrt").await.unwrap();
    let store = &a.service().store;
    let names: Vec<String> = (0..30)
        .map(|index| format!("job{index:02}.opentunnel.test"))
        .collect();
    let now = a.service().now();
    for name in &names {
        store
            .add_job(
                Job {
                    certificate_id: format!("cert_{name}"),
                    tunnel_id: None,
                    kind: JobKind::Issue,
                    identifiers: vec![name.clone()],
                    csr: csr(name),
                    attempts: 0,
                    created_at: now,
                },
                now,
            )
            .await
            .unwrap();
    }
    a.service().jobs.notify_one();
    b.service().jobs.notify_one();
    eventually("every job to finish", || async {
        store.counts().await.unwrap()["jobs_pending"] == 0
    })
    .await;
    let signed = |server: &TestServer| match server.server.jobs.issuer.as_ref() {
        Issuer::Local(ca) => ca.signed.lock().unwrap().clone(),
        Issuer::Acme(_) => unreachable!(),
    };
    let (on_a, on_b) = (signed(&a), signed(&b));
    for name in &names {
        let runs = on_a.get(name).copied().unwrap_or(0) + on_b.get(name).copied().unwrap_or(0);
        assert_eq!(runs, 1, "{name} ran {runs} times");
    }
    a.stop().await;
    b.stop().await;
}
