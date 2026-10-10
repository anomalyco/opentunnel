//! The HTTP API answers exactly as the Worker did: every request in `fixtures/worker-contract.json` was
//! replayed through the Worker's handler and the real Durable Object, and is replayed here.

mod common;

use std::collections::HashMap;

use common::TestServer;
use serde_json::Value;

fn csr(hostname: &str) -> String {
    let key = rcgen::KeyPair::generate().unwrap();
    let mut params =
        rcgen::CertificateParams::new(vec![hostname.to_owned(), format!("*.{hostname}")]).unwrap();
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, hostname);
    params.serialize_request(&key).unwrap().pem().unwrap()
}

/// Inside a JSON string.
fn escaped(value: &str) -> String {
    let quoted = serde_json::to_string(value).unwrap();
    quoted[1..quoted.len() - 1].to_owned()
}

fn substitute(text: &str, values: &[(String, String)]) -> String {
    values.iter().fold(text.to_owned(), |text, (key, value)| {
        text.replace(key, value)
    })
}

/// Puts the placeholders back and hides values that are random on every run.
fn normalize(value: Value, values: &[(String, String)]) -> Value {
    match value {
        Value::String(text) => {
            if text.starts_with("cert_") && text.len() == 41 {
                return Value::String("cert_*".into());
            }
            let mut text = text;
            for (key, value) in values {
                // The hostname becomes `$ID.opentunnel.test`, as in the fixture.
                if key == "$TOKEN" || key == "$ID" {
                    text = text.replace(value.as_str(), key);
                }
            }
            Value::String(text)
        }
        Value::Object(map) => {
            let mut map: serde_json::Map<String, Value> = map
                .into_iter()
                .map(|(key, value)| (key, normalize(value, values)))
                .collect();
            if map.contains_key("token") && map.contains_key("tunnel") {
                map["token"] = "*".into();
                map["tunnel"]["id"] = "*".into();
                map["tunnel"]["hostname"] = "*".into();
            }
            Value::Object(map)
        }
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| normalize(item, values))
                .collect(),
        ),
        other => other,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn matches_the_worker() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/worker-contract.json")).unwrap();
    let dir = tempfile::tempdir().unwrap();
    // The Worker's capture never ran its Workflow, so certificates stay `issuing`: an ACME server that never
    // answers does the same here.
    let silent = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let acme = format!(
        "--acme-url=http://{}/directory",
        silent.local_addr().unwrap()
    );
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((socket, _)) = silent.accept().await {
            held.push(socket);
        }
    });
    let jwk = opentunnel_server::acme::generate_account_jwk().unwrap();
    let jwk = format!("--acme-account-key-jwk={jwk}");
    let server = TestServer::start(
        dir.path(),
        &[
            "--issuer=acme",
            &acme,
            &jwk,
            "--acme-eab-kid=kid",
            "--acme-eab-hmac-key=aG1hYw",
            "--dns-provider=challtestsrv",
        ],
    )
    .await;
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let mut values: Vec<(String, String)> = Vec::new();
    let mut failures = Vec::new();

    for case in fixture["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let request = &case["request"];
        let expected = &case["response"];
        let method: reqwest::Method = request["method"].as_str().unwrap().parse().unwrap();
        let path = substitute(request["path"].as_str().unwrap(), &values);
        let mut builder = http.request(method, format!("{}{path}", server.api));
        let headers: HashMap<String, String> =
            serde_json::from_value(request["headers"].clone()).unwrap();
        for (header, value) in headers {
            builder = builder.header(header, substitute(&value, &values));
        }
        if let Some(body) = request["body"].as_str() {
            builder = builder.body(substitute(body, &values));
        }
        let response = builder.send().await.unwrap();
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get("content-type")
            .map(|value| value.to_str().unwrap().to_owned());
        let text = response.text().await.unwrap();

        if name == "create" {
            let body: Value = serde_json::from_str(&text).unwrap();
            let id = body["tunnel"]["id"].as_str().unwrap().to_owned();
            let hostname = body["tunnel"]["hostname"].as_str().unwrap().to_owned();
            assert_eq!(hostname, format!("{id}.opentunnel.test"));
            values = vec![
                ("$TOKEN".into(), body["token"].as_str().unwrap().to_owned()),
                ("$HOSTNAME".into(), hostname.clone()),
                ("$CSR".into(), escaped(&csr(&hostname))),
                ("$OTHER".into(), escaped(&csr(&hostname))),
                ("$WRONG".into(), escaped(&csr("other.opentunnel.test"))),
                ("$ID".into(), id),
            ];
        }

        let mut problems = Vec::new();
        if status != expected["status"].as_u64().unwrap() as u16 {
            problems.push(format!("status {status}, expected {}", expected["status"]));
        }
        match expected["contentType"].as_str() {
            Some(json) if json.starts_with("application/json") => {
                if content_type.as_deref() != Some("application/json") {
                    problems.push(format!("content type {content_type:?}"));
                }
            }
            Some("text/plain") if content_type.as_deref() != Some("text/plain") => {
                problems.push(format!(
                    "content type {content_type:?}, expected text/plain"
                ));
            }
            _ => {}
        }
        match &expected["body"] {
            Value::String(body) if body == "<openapi.json>" => {
                if text != include_str!("../src/openapi.json") {
                    problems.push("OpenAPI document differs".into());
                }
            }
            Value::String(body) => {
                if normalize(Value::String(text.clone()), &values) != Value::String(body.clone()) {
                    problems.push(format!("body {text:?}, expected {body:?}"));
                }
            }
            body => match serde_json::from_str::<Value>(&text) {
                Ok(actual) => {
                    let actual = normalize(actual, &values);
                    if actual != *body {
                        problems.push(format!("body {actual}, expected {body}"));
                    }
                    // Error bodies keep the Worker's key order: `_tag` first, `message` last.
                    if let (Some(first), Value::Object(map)) = (text.find("\"_tag\""), body)
                        && map.contains_key("message")
                        && (first != 1 || !text.trim_end_matches('}').contains("\"message\":"))
                    {
                        problems.push(format!("key order in {text}"));
                    }
                }
                Err(_) => problems.push(format!("body {text:?} is not JSON")),
            },
        }
        if !problems.is_empty() {
            failures.push(format!("{name}: {}", problems.join("; ")));
        }
    }
    server.stop().await;
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}
