//! DNS-01 challenge records. DNS for the domain stays on Cloudflare; the provider is an enum so another can be
//! added without touching issuance.

use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use serde::Deserialize;
use serde_json::json;
use tracing::warn;

#[derive(Clone)]
pub enum DnsProvider {
    /// The Cloudflare DNS API, with a token that can edit the zone.
    Cloudflare {
        http: reqwest::Client,
        api: String,
        zone_id: String,
        token: String,
    },
    /// pebble-challtestsrv's management API, for testing against Pebble.
    ChallTestSrv { http: reqwest::Client, url: String },
}

/// A created TXT record, to delete afterwards.
#[derive(Debug, Clone)]
pub struct TxtRecord {
    pub name: String,
    pub value: String,
    pub id: Option<String>,
}

#[derive(Deserialize)]
struct CloudflareResponse<A> {
    success: bool,
    result: Option<A>,
    #[serde(default)]
    errors: Vec<CloudflareError>,
}

#[derive(Deserialize)]
struct CloudflareError {
    #[serde(default)]
    message: String,
}

#[derive(Deserialize)]
struct Created {
    id: String,
}

impl DnsProvider {
    /// Creates a TXT record `name` (a full name, `_acme-challenge.<host>`) with `value`, TTL 60.
    pub async fn create_txt(&self, name: &str, value: &str) -> Result<TxtRecord> {
        match self {
            Self::Cloudflare {
                http,
                api,
                zone_id,
                token,
            } => {
                let response = http
                    .post(format!("{api}/zones/{zone_id}/dns_records"))
                    .bearer_auth(token)
                    .timeout(Duration::from_secs(30))
                    .json(&json!({ "type": "TXT", "name": name, "content": value, "ttl": 60 }))
                    .send()
                    .await?;
                let status = response.status();
                let body: CloudflareResponse<Created> = response
                    .json()
                    .await
                    .map_err(|_| anyhow!("DNS record creation failed"))?;
                match body.result {
                    Some(created) if status.is_success() && body.success => Ok(TxtRecord {
                        name: name.into(),
                        value: value.into(),
                        id: Some(created.id),
                    }),
                    _ => {
                        let messages: Vec<String> = body
                            .errors
                            .into_iter()
                            .map(|error| error.message)
                            .filter(|message| !message.is_empty())
                            .collect();
                        if messages.is_empty() {
                            bail!("DNS record creation failed")
                        }
                        bail!("{}", messages.join(", "))
                    }
                }
            }
            Self::ChallTestSrv { http, url } => {
                let response = http
                    .post(format!("{url}/set-txt"))
                    .json(&json!({ "host": format!("{name}."), "value": value }))
                    .send()
                    .await?;
                if !response.status().is_success() {
                    bail!(
                        "DNS record creation failed: HTTP {}",
                        response.status().as_u16()
                    );
                }
                Ok(TxtRecord {
                    name: name.into(),
                    value: value.into(),
                    id: None,
                })
            }
        }
    }

    /// Deletes a record, logging rather than failing: a leftover TXT record is harmless.
    pub async fn delete_txt(&self, record: &TxtRecord) {
        let result = match self {
            Self::Cloudflare {
                http,
                api,
                zone_id,
                token,
            } => match &record.id {
                Some(id) => http
                    .delete(format!("{api}/zones/{zone_id}/dns_records/{id}"))
                    .bearer_auth(token)
                    .timeout(Duration::from_secs(30))
                    .send()
                    .await
                    .map(drop),
                None => Ok(()),
            },
            Self::ChallTestSrv { http, url } => http
                .post(format!("{url}/clear-txt"))
                .json(&json!({ "host": format!("{}.", record.name) }))
                .send()
                .await
                .map(drop),
        };
        if let Err(error) = result {
            warn!(%error, name = %record.name, "failed to delete a challenge record");
        }
    }
}

#[derive(Deserialize)]
struct DnsJson {
    #[serde(rename = "Status")]
    status: u32,
    #[serde(rename = "Answer", default)]
    answer: Vec<DnsAnswer>,
}

#[derive(Deserialize)]
struct DnsAnswer {
    #[serde(rename = "type")]
    kind: u32,
    data: String,
}

/// Waits until public resolvers (Cloudflare and Google over DNS-over-HTTPS) return every challenge value, or
/// `timeout` passes, after which issuance proceeds anyway, as the Worker did.
pub async fn wait_for_propagation(
    http: &reqwest::Client,
    records: &[TxtRecord],
    timeout: Duration,
) {
    if timeout.is_zero() || records.is_empty() {
        return;
    }
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let mut visible = true;
        for record in records {
            if !resolvers_see(http, record).await {
                visible = false;
                break;
            }
        }
        if visible {
            return;
        }
        if tokio::time::Instant::now() >= deadline {
            warn!("DNS challenge records were not visible before the propagation timeout");
            return;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

async fn resolvers_see(http: &reqwest::Client, record: &TxtRecord) -> bool {
    for resolver in [
        "https://cloudflare-dns.com/dns-query",
        "https://dns.google/resolve",
    ] {
        let Ok(mut url) = url::Url::parse(resolver) else {
            continue;
        };
        url.query_pairs_mut()
            .append_pair("name", &record.name)
            .append_pair("type", "TXT");
        let response = http
            .get(url)
            .header("accept", "application/dns-json")
            .timeout(Duration::from_secs(5))
            .send()
            .await;
        let Ok(response) = response else { continue };
        let Ok(body) = response.json::<DnsJson>().await else {
            continue;
        };
        if body.status != 0 {
            continue;
        }
        if body
            .answer
            .iter()
            .filter(|answer| answer.kind == 16)
            .any(|answer| answer.data.trim_matches('"') == record.value)
        {
            return true;
        }
    }
    false
}
