//! Product analytics for Anomaly's platform event stream (`platform_<stack>_event`): the same `source:
//! "opentunnel"` events, types and payloads the Worker sent through its Pipelines binding, posted in batches to
//! the stream's authenticated HTTP endpoint. Analytics never affect tunnels: sends happen on a background task,
//! and a full queue or a failed send drops events.

use std::time::Duration;

use serde::Serialize;
use serde_json::{Map, Value};
use tokio::sync::mpsc;
use tracing::warn;

use crate::clock::{Clock, MINUTE_MS};

/// How often an attached bridge reports `tunnel.active`, piggybacking on its client's pings.
pub const ACTIVE_INTERVAL_MS: u64 = 5 * MINUTE_MS;
const QUEUE: usize = 10_000;
const BATCH: usize = 200;
const FLUSH_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Serialize)]
pub struct Event {
    pub source: &'static str,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub timestamp: String,
    pub payload: Value,
}

#[derive(Clone)]
pub struct Analytics {
    clock: Clock,
    sender: Option<mpsc::Sender<Event>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ClientInfo {
    /// `cli`, `sdk`, `other` or `none`.
    pub client: &'static str,
    pub client_version: Option<String>,
}

impl ClientInfo {
    pub fn fields(&self) -> Map<String, Value> {
        let mut fields = Map::new();
        fields.insert("client".into(), self.client.into());
        if let Some(version) = &self.client_version {
            fields.insert("client_version".into(), version.clone().into());
        }
        fields
    }
}

impl Analytics {
    /// Discards every event.
    pub fn disabled(clock: Clock) -> Self {
        Self {
            clock,
            sender: None,
        }
    }

    /// Posts events to `url` with the bearer `token`, as a JSON array per batch.
    pub fn http(clock: Clock, http: reqwest::Client, url: String, token: Option<String>) -> Self {
        let (sender, receiver) = mpsc::channel(QUEUE);
        tokio::spawn(deliver(http, url, token, receiver));
        Self {
            clock,
            sender: Some(sender),
        }
    }

    /// Collects events in memory, for tests.
    pub fn channel(clock: Clock) -> (Self, mpsc::Receiver<Event>) {
        let (sender, receiver) = mpsc::channel(QUEUE);
        (
            Self {
                clock,
                sender: Some(sender),
            },
            receiver,
        )
    }

    /// Queues one event; `payload` is its fields without `schema_version`.
    pub fn publish(&self, kind: &'static str, payload: Value) {
        let Some(sender) = &self.sender else { return };
        let mut fields = Map::new();
        fields.insert("schema_version".into(), 1.into());
        if let Value::Object(payload) = payload {
            fields.extend(payload);
        }
        let event = Event {
            source: "opentunnel",
            kind,
            timestamp: self.clock.iso(),
            payload: Value::Object(fields),
        };
        if sender.try_send(event).is_err() {
            warn!(kind, "analytics event dropped");
        }
    }
}

async fn deliver(
    http: reqwest::Client,
    url: String,
    token: Option<String>,
    mut receiver: mpsc::Receiver<Event>,
) {
    let mut batch = Vec::with_capacity(BATCH);
    loop {
        let Some(first) = receiver.recv().await else {
            return;
        };
        batch.push(first);
        let deadline = tokio::time::sleep(FLUSH_INTERVAL);
        tokio::pin!(deadline);
        while batch.len() < BATCH {
            tokio::select! {
                event = receiver.recv() => match event {
                    Some(event) => batch.push(event),
                    None => break,
                },
                _ = &mut deadline => break,
            }
        }
        let mut request = http
            .post(&url)
            .timeout(Duration::from_secs(10))
            .json(&batch);
        if let Some(token) = &token {
            request = request.bearer_auth(token);
        }
        match request.send().await {
            Ok(response) if response.status().is_success() => {}
            Ok(response) => {
                warn!(status = %response.status(), events = batch.len(), "analytics events dropped")
            }
            Err(error) => warn!(%error, events = batch.len(), "analytics events dropped"),
        }
        batch.clear();
    }
}

/// The HTTP client that made a request, from the first product token of its user agent: `cli` is the Rust CLI
/// (`opentunnel/<version>`), `sdk` the TypeScript SDK (`opentunnel-sdk/<version>`, or a bare `Bun/<version>`
/// from SDK releases before it identified itself); `none` means no user agent was sent.
pub fn client(user_agent: Option<&str>) -> ClientInfo {
    let agent = user_agent.unwrap_or_default().trim();
    let mut chars = agent.char_indices();
    let Some((_, first)) = chars.next() else {
        return ClientInfo {
            client: "none",
            client_version: None,
        };
    };
    if !first.is_ascii_alphabetic() {
        return ClientInfo {
            client: "none",
            client_version: None,
        };
    }
    let name_end = agent
        .char_indices()
        .skip(1)
        .find(|(_, char)| !(char.is_ascii_alphanumeric() || matches!(char, '_' | '.' | '-')))
        .map_or(agent.len(), |(index, _)| index);
    let name = agent[..name_end].to_ascii_lowercase();
    let version = agent[name_end..].strip_prefix('/').and_then(|rest| {
        let end = rest
            .char_indices()
            .find(|(_, char)| {
                !(char.is_ascii_alphanumeric() || matches!(char, '_' | '.' | '+' | '-'))
            })
            .map_or(rest.len(), |(index, _)| index);
        let version = &rest[..end.min(32)];
        (!version.is_empty()).then(|| version.to_owned())
    });
    let kind = match name.as_str() {
        "opentunnel" => "cli",
        "opentunnel-sdk" | "bun" => "sdk",
        _ => {
            return ClientInfo {
                client: "other",
                client_version: None,
            };
        }
    };
    ClientInfo {
        client: kind,
        // A bare Bun user agent carries the runtime's version, not the SDK's.
        client_version: version.filter(|_| name != "bun"),
    }
}

/// Buckets a certificate failure message; the message itself can carry ACME response bodies.
pub fn certificate_failure(reason: &str) -> &'static str {
    let lower = reason.to_ascii_lowercase();
    let http_status = reason.match_indices("HTTP ").any(|(index, _)| {
        reason[index + 5..]
            .chars()
            .take(3)
            .filter(char::is_ascii_digit)
            .count()
            == 3
    });
    if reason.contains("required") || reason.contains("not a P-256") {
        "config"
    } else if lower.contains("http 429") || lower.contains("ratelimited") {
        "acme_rate_limit"
    } else if reason.contains("DNS") {
        "dns"
    } else if reason.contains("authorization") || reason.contains("dns-01") {
        "acme_authorization"
    } else if reason.contains("ACME order") || reason.contains("finalize") {
        "acme_order"
    } else if reason.contains("persist certificate state") {
        "persist"
    } else if http_status {
        "acme_http"
    } else {
        "other"
    }
}

pub fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// Builds a payload from a base object and extra fields.
pub fn with(base: Map<String, Value>, extra: Value) -> Value {
    let mut base = base;
    base.extend(object(extra));
    Value::Object(base)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn identifies_clients() {
        let info = |agent| client(agent);
        assert_eq!(
            info(Some("opentunnel/0.4.1")),
            ClientInfo {
                client: "cli",
                client_version: Some("0.4.1".into())
            }
        );
        assert_eq!(
            info(Some("opentunnel-sdk/0.4.1")),
            ClientInfo {
                client: "sdk",
                client_version: Some("0.4.1".into())
            }
        );
        assert_eq!(
            info(Some("Bun/1.4.2")),
            ClientInfo {
                client: "sdk",
                client_version: None
            }
        );
        assert_eq!(info(Some("curl/8.0")).client, "other");
        assert_eq!(info(None).client, "none");
        assert_eq!(info(Some("")).client, "none");
        assert_eq!(info(Some("OpenTunnel")).client_version, None);
    }

    #[test]
    fn buckets_certificate_failures() {
        assert_eq!(
            certificate_failure("ACME_EAB_KID and ACME_EAB_HMAC_KEY are required"),
            "config"
        );
        assert_eq!(
            certificate_failure("urn:ietf:params:acme:error:rateLimited | HTTP 429"),
            "acme_rate_limit"
        );
        assert_eq!(certificate_failure("DNS record creation failed"), "dns");
        assert_eq!(
            certificate_failure("ACME authorization ended in invalid"),
            "acme_authorization"
        );
        assert_eq!(
            certificate_failure("ACME order ended in invalid"),
            "acme_order"
        );
        assert_eq!(certificate_failure("bad request | HTTP 400"), "acme_http");
        assert_eq!(certificate_failure("something"), "other");
    }

    #[tokio::test]
    async fn builds_the_platform_envelope() {
        let (clock, _) =
            Clock::manual(crate::clock::parse_iso("2026-10-07T12:00:00.000Z").unwrap());
        let (analytics, mut events) = Analytics::channel(clock);
        analytics.publish(
            "connection.closed",
            json!({ "tunnel_id": "abc", "outcome": "closed", "duration_ms": 12, "bytes_in": 3, "bytes_out": 4 }),
        );
        let event = events.recv().await.unwrap();
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            json!({
                "source": "opentunnel",
                "type": "connection.closed",
                "timestamp": "2026-10-07T12:00:00.000Z",
                "payload": { "schema_version": 1, "tunnel_id": "abc", "outcome": "closed", "duration_ms": 12, "bytes_in": 3, "bytes_out": 4 }
            })
        );
    }
}
