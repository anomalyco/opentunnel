//! DNS-01 challenge records. The hosted service uses Cloudflare; self-hosted servers can run a hook executable
//! for any other DNS host. The provider is an enum so another can be added without touching issuance.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
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
    /// An executable run as `<hook> create|delete <name> <value>`, which exits 0 on success. Both must be
    /// idempotent: `create` succeeds if the record exists, `delete` if it is gone.
    Exec { hook: PathBuf },
}

/// How long a hook may run before it is killed.
const HOOK_TIMEOUT: Duration = Duration::from_secs(60);
/// The end of a failed hook's stderr kept in the error.
const HOOK_STDERR_LIMIT: usize = 500;

/// Runs `hook action name value`, failing on a non-zero exit with the end of its stderr.
async fn run_hook(hook: &Path, action: &str, name: &str, value: &str) -> Result<()> {
    let child = tokio::process::Command::new(hook)
        .args([action, name, value])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| anyhow!("running DNS hook {}: {error}", hook.display()))?;
    let output = tokio::time::timeout(HOOK_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| anyhow!("DNS hook {action} timed out after {HOOK_TIMEOUT:?}"))??;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stderr = stderr.trim();
    let mut start = stderr.len().saturating_sub(HOOK_STDERR_LIMIT);
    while !stderr.is_char_boundary(start) {
        start += 1;
    }
    let stderr = &stderr[start..];
    if stderr.is_empty() {
        bail!("DNS hook {action} failed: {}", output.status)
    }
    bail!("DNS hook {action} failed: {}: {stderr}", output.status)
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
    code: u64,
    #[serde(default)]
    message: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Listed {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub content: String,
    /// RFC 3339.
    #[serde(default)]
    pub created_on: String,
}

#[derive(Deserialize, Default)]
struct ResultInfo {
    #[serde(default)]
    total_pages: u32,
}

#[derive(Deserialize)]
struct ListResponse {
    #[serde(default)]
    result: Vec<Listed>,
    #[serde(default)]
    result_info: ResultInfo,
}

/// Deleting a record is tried this many times (rate limits, 5xx), a second apart and more.
const DELETE_TRIES: u32 = 4;
/// Records listed per page by the sweep.
const SWEEP_PAGE: u32 = 500;

/// Cloudflare's error for a record that exists with the same name and content.
const CLOUDFLARE_IDENTICAL_RECORD: u64 = 81058;

#[derive(Deserialize)]
struct Created {
    id: String,
}

impl DnsProvider {
    /// Creates a TXT record `name` (a full name, `_acme-challenge.<host>`) with `value`, TTL 60. A record that
    /// already exists with that value (left by an interrupted attempt) is used as is, and deleted afterwards
    /// like a created one.
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
                    Some(created) if status.is_success() && body.success => {
                        crate::metrics::dns_record("created");
                        Ok(TxtRecord {
                            name: name.into(),
                            value: value.into(),
                            id: Some(created.id),
                        })
                    }
                    _ if body.errors.iter().any(|error| {
                        error.code == CLOUDFLARE_IDENTICAL_RECORD
                            || error.message.contains("identical record already exists")
                    }) =>
                    {
                        let id = self.find_txt(name, value).await.unwrap_or_else(|error| {
                            warn!(%error, name, "failed to look up an existing challenge record");
                            None
                        });
                        Ok(TxtRecord {
                            name: name.into(),
                            value: value.into(),
                            id,
                        })
                    }
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
            Self::Exec { hook } => {
                run_hook(hook, "create", name, value).await?;
                crate::metrics::dns_record("created");
                Ok(TxtRecord {
                    name: name.into(),
                    value: value.into(),
                    id: None,
                })
            }
        }
    }

    /// The ID of the Cloudflare TXT record `name` with `value`, if there is one.
    async fn find_txt(&self, name: &str, value: &str) -> Result<Option<String>> {
        let Self::Cloudflare {
            http,
            api,
            zone_id,
            token,
        } = self
        else {
            return Ok(None);
        };
        let mut url = url::Url::parse(&format!("{api}/zones/{zone_id}/dns_records"))?;
        url.query_pairs_mut()
            .append_pair("type", "TXT")
            .append_pair("name", name);
        let body: CloudflareResponse<Vec<Listed>> = http
            .get(url)
            .bearer_auth(token)
            .timeout(Duration::from_secs(30))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        // Cloudflare may show TXT content quoted.
        Ok(body
            .result
            .unwrap_or_default()
            .into_iter()
            .find(|record| record.content.trim_matches('"') == value)
            .map(|record| record.id))
    }

    /// Deletes a record, logging rather than failing: what is left is swept later ([`sweep`](Self::sweep)).
    /// Rate limits and server errors are retried; a record already gone counts as deleted. Returns whether it
    /// is gone.
    pub async fn delete_txt(&self, record: &TxtRecord) -> bool {
        let deleted = match self {
            Self::Cloudflare { .. } => {
                let id = match &record.id {
                    Some(id) => Some(id.clone()),
                    // Taken over from an interrupted attempt and not found then: look again.
                    None => self
                        .find_txt(&record.name, &record.value)
                        .await
                        .unwrap_or_else(|error| {
                            warn!(%error, name = %record.name, "failed to look up a challenge record");
                            None
                        }),
                };
                match id {
                    Some(id) => self.delete_id(&id).await,
                    None => Ok(()),
                }
            }
            Self::ChallTestSrv { http, url } => http
                .post(format!("{url}/clear-txt"))
                .json(&json!({ "host": format!("{}.", record.name) }))
                .send()
                .await
                .and_then(reqwest::Response::error_for_status)
                .map(drop)
                .map_err(anyhow::Error::from),
            Self::Exec { hook } => run_hook(hook, "delete", &record.name, &record.value).await,
        };
        match deleted {
            Ok(()) => {
                crate::metrics::dns_record("deleted");
                true
            }
            Err(error) => {
                crate::metrics::dns_record("delete_failed");
                warn!(error = %format!("{error:#}"), name = %record.name, "failed to delete a challenge record");
                false
            }
        }
    }

    /// Deletes a Cloudflare record by ID, again after rate limits and server errors.
    async fn delete_id(&self, id: &str) -> Result<()> {
        let Self::Cloudflare {
            http,
            api,
            zone_id,
            token,
        } = self
        else {
            return Ok(());
        };
        let mut pause = Duration::from_secs(1);
        let mut last = String::new();
        for attempt in 1..=DELETE_TRIES {
            match http
                .delete(format!("{api}/zones/{zone_id}/dns_records/{id}"))
                .bearer_auth(token)
                .timeout(Duration::from_secs(30))
                .send()
                .await
            {
                // Gone already (another attempt or the sweep deleted it).
                Ok(response) if response.status().is_success() || response.status() == 404 => {
                    return Ok(());
                }
                Ok(response) => {
                    let status = response.status();
                    last = format!("HTTP {}", status.as_u16());
                    if !(status == 429 || status.is_server_error()) {
                        break;
                    }
                    if let Some(wait) = response
                        .headers()
                        .get(reqwest::header::RETRY_AFTER)
                        .and_then(|value| value.to_str().ok())
                        .and_then(|value| value.trim().parse::<u64>().ok())
                    {
                        pause = pause.max(Duration::from_secs(wait.min(30)));
                    }
                }
                Err(error) => last = error.to_string(),
            }
            if attempt < DELETE_TRIES {
                tokio::time::sleep(pause).await;
                pause *= 2;
            }
        }
        bail!("deleting DNS record {id} failed: {last}")
    }

    /// Every `_acme-challenge.*` TXT record in the zone. `None` for providers that cannot list.
    pub async fn challenge_records(&self) -> Result<Option<Vec<Listed>>> {
        let Self::Cloudflare {
            http,
            api,
            zone_id,
            token,
        } = self
        else {
            return Ok(None);
        };
        let mut records = Vec::new();
        let mut page = 1;
        loop {
            let mut url = url::Url::parse(&format!("{api}/zones/{zone_id}/dns_records"))?;
            url.query_pairs_mut()
                .append_pair("type", "TXT")
                .append_pair("name.startswith", "_acme-challenge.")
                .append_pair("per_page", &SWEEP_PAGE.to_string())
                .append_pair("page", &page.to_string());
            let body: ListResponse = http
                .get(url)
                .bearer_auth(token)
                .timeout(Duration::from_secs(30))
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            let count = body.result.len();
            records.extend(body.result);
            if count == 0 || page >= body.result_info.total_pages.max(1) || page >= 1_000 {
                return Ok(Some(records));
            }
            page += 1;
        }
    }

    /// Deletes challenge records for names under `domain` created before `before` (Unix ms), except for names
    /// in `in_flight` (issuance running now), at most `limit` of them, `pause` apart (Cloudflare limits its API
    /// per user). Returns how many it deleted.
    pub async fn sweep(
        &self,
        domain: &str,
        before: u64,
        in_flight: &HashSet<String>,
        limit: usize,
        pause: Duration,
    ) -> Result<usize> {
        let Some(records) = self.challenge_records().await? else {
            return Ok(0);
        };
        let suffix = format!(".{domain}");
        let mut swept = 0;
        for record in records {
            if swept >= limit {
                break;
            }
            let name = record.name.to_ascii_lowercase();
            let value = record.content.trim_matches('"');
            // Only what issuance makes: a challenge name under the domain and a SHA-256 in base64url.
            let ours = name.starts_with("_acme-challenge.")
                && (name.ends_with(&suffix) || name == format!("_acme-challenge.{domain}"))
                && value.len() == 43
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
            let old = crate::clock::parse_iso(&record.created_on).is_some_and(|at| at < before);
            if !ours || !old || in_flight.contains(&name) {
                continue;
            }
            match self.delete_id(&record.id).await {
                Ok(()) => {
                    swept += 1;
                    crate::metrics::dns_record("swept");
                }
                Err(error) => {
                    warn!(error = %format!("{error:#}"), name, "failed to sweep a challenge record");
                    // Most likely rate limited: stop and come back at the next sweep.
                    break;
                }
            }
            tokio::time::sleep(pause).await;
        }
        Ok(swept)
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

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    fn hook(dir: &Path, script: &str) -> DnsProvider {
        let path = dir.join("hook");
        std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        DnsProvider::Exec { hook: path }
    }

    #[tokio::test]
    async fn exec_hook_gets_action_name_and_value() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("log");
        let dns = hook(dir.path(), &format!("echo \"$@\" >> '{}'", log.display()));
        let record = dns
            .create_txt("_acme-challenge.abc.example.com", "a value")
            .await
            .unwrap();
        assert!(dns.delete_txt(&record).await);
        assert_eq!(
            std::fs::read_to_string(&log).unwrap(),
            "create _acme-challenge.abc.example.com a value\n\
             delete _acme-challenge.abc.example.com a value\n"
        );
    }

    #[tokio::test]
    async fn exec_hook_failure_has_status_and_stderr() {
        let dir = tempfile::tempdir().unwrap();
        let dns = hook(dir.path(), "echo starting\necho 'no such zone' >&2\nexit 3");
        let error = dns
            .create_txt("_acme-challenge.abc.example.com", "value")
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("exit status: 3"), "{error}");
        assert!(error.ends_with("no such zone"), "{error}");
        let record = TxtRecord {
            name: "_acme-challenge.abc.example.com".into(),
            value: "value".into(),
            id: None,
        };
        assert!(!dns.delete_txt(&record).await);
    }
}
