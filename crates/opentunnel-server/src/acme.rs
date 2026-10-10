//! A small ACME (RFC 8555) client for DNS-01 issuance with external account binding, as ZeroSSL requires.
//! One `issue` call is one attempt: a fresh order, its challenges, finalization with the tunnel's CSR, and the
//! certificate chain. Retries are the job runner's.

use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use reqwest::header::{CONTENT_TYPE, HeaderMap, LOCATION};
use ring::rand::SystemRandom;
use ring::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, KeyPair};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;
use tracing::info;

use crate::crypto::{base64url, decode_base64url};
use crate::dns::{DnsProvider, TxtRecord, wait_for_propagation};

#[derive(Clone)]
pub struct AcmeConfig {
    pub directory: String,
    pub email: String,
    pub eab_kid: Option<String>,
    pub eab_hmac_key: Option<String>,
    /// The account key, a P-256 private JWK.
    pub account_key_jwk: Option<String>,
    pub dns_propagation_timeout: Duration,
    pub authorization_poll: Duration,
    pub order_poll: Duration,
}

pub struct Acme {
    config: AcmeConfig,
    http: reqwest::Client,
    dns: Option<DnsProvider>,
    /// The account URL (the JWS `kid`), once registered.
    account: Mutex<Option<String>>,
}

/// One attempt's result: the leaf and the rest of the chain as PEM, and the leaf's expiry.
#[derive(Debug, Clone)]
pub struct Issued {
    pub certificate: String,
    pub chain: String,
    pub expiry: String,
}

/// The first challenge, which the API shows while issuance waits for DNS.
#[derive(Debug, Clone)]
pub struct Challenge {
    pub token: String,
    pub key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Directory {
    new_nonce: String,
    new_account: String,
    new_order: String,
}

#[derive(Deserialize)]
struct Order {
    status: String,
    #[serde(default)]
    authorizations: Vec<String>,
    finalize: Option<String>,
    certificate: Option<String>,
}

#[derive(Deserialize)]
struct Authorization {
    status: String,
    identifier: Identifier,
    #[serde(default)]
    challenges: Vec<AcmeChallenge>,
}

#[derive(Deserialize)]
struct Identifier {
    value: String,
}

#[derive(Deserialize)]
struct AcmeChallenge {
    #[serde(rename = "type")]
    kind: String,
    url: String,
    token: String,
}

struct Key {
    pair: EcdsaKeyPair,
    jwk: Value,
    thumbprint: String,
}

struct Response {
    headers: HeaderMap,
    body: bytes::Bytes,
}

impl Acme {
    pub fn new(config: AcmeConfig, http: reqwest::Client, dns: Option<DnsProvider>) -> Self {
        Self {
            config,
            http,
            dns,
            account: Mutex::new(None),
        }
    }

    pub async fn issue(
        &self,
        identifiers: &[String],
        csr_pem: &str,
        on_challenge: impl AsyncFnOnce(Challenge) -> Result<()>,
    ) -> Result<Issued> {
        let (Some(kid), Some(hmac)) = (&self.config.eab_kid, &self.config.eab_hmac_key) else {
            bail!("ACME_EAB_KID and ACME_EAB_HMAC_KEY are required");
        };
        let Some(dns) = &self.dns else {
            bail!("CLOUDFLARE_ZONE_ID and CLOUDFLARE_API_TOKEN are required");
        };
        let key = account_key(self.config.account_key_jwk.as_deref())?;
        let directory: Directory = self
            .http
            .get(&self.config.directory)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .context("fetching the ACME directory")?
            .error_for_status()?
            .json()
            .await?;
        let mut session = Session {
            http: &self.http,
            key: &key,
            new_nonce: &directory.new_nonce,
            nonce: None,
            kid: self.account.lock().await.clone(),
        };
        if session.kid.is_none() {
            let binding = external_account_binding(&key, kid, hmac, &directory.new_account)?;
            let payload = json!({
                "contact": [format!("mailto:{}", self.config.email)],
                "termsOfServiceAgreed": true,
                "externalAccountBinding": binding,
            });
            let response = session.post(&directory.new_account, Some(&payload)).await?;
            let location = header(&response.headers, LOCATION)
                .ok_or_else(|| anyhow!("ACME account has no location URL"))?;
            *self.account.lock().await = Some(location.clone());
            session.kid = Some(location);
        }

        let identifiers_json: Vec<Value> = identifiers
            .iter()
            .map(|value| json!({ "type": "dns", "value": value }))
            .collect();
        let response = session
            .post(
                &directory.new_order,
                Some(&json!({ "identifiers": identifiers_json })),
            )
            .await?;
        let order_url = header(&response.headers, LOCATION);
        let order: Order = serde_json::from_slice(&response.body)?;

        let mut pending = Vec::new();
        for url in &order.authorizations {
            let authorization: Authorization =
                serde_json::from_slice(&session.post(url, None).await?.body)?;
            if authorization.status == "valid" {
                continue;
            }
            let challenge = authorization
                .challenges
                .into_iter()
                .find(|challenge| challenge.kind == "dns-01")
                .ok_or_else(|| anyhow!("ACME server did not offer dns-01"))?;
            let key_authorization = format!("{}.{}", challenge.token, key.thumbprint);
            let value = base64url(
                ring::digest::digest(&ring::digest::SHA256, key_authorization.as_bytes()).as_ref(),
            );
            pending.push((
                url.clone(),
                challenge,
                value,
                authorization.identifier.value,
            ));
        }
        if let Some((_, challenge, value, _)) = pending.first() {
            on_challenge(Challenge {
                token: challenge.token.clone(),
                key: value.clone(),
            })
            .await?;
        }

        let mut records: Vec<TxtRecord> = Vec::new();
        let result = async {
            for (_, _, value, hostname) in &pending {
                let hostname = hostname.trim_start_matches("*.");
                records.push(
                    dns.create_txt(&format!("_acme-challenge.{hostname}"), value)
                        .await?,
                );
            }
            wait_for_propagation(&self.http, &records, self.config.dns_propagation_timeout).await;
            for (url, challenge, _, _) in &pending {
                session.post(&challenge.url, Some(&json!({}))).await?;
                let mut authorization: Authorization =
                    serde_json::from_slice(&session.post(url, None).await?.body)?;
                for _ in 0..30 {
                    if authorization.status != "pending" {
                        break;
                    }
                    tokio::time::sleep(self.config.authorization_poll).await;
                    authorization = serde_json::from_slice(&session.post(url, None).await?.body)?;
                }
                if authorization.status != "valid" {
                    bail!("ACME authorization ended in {}", authorization.status);
                }
            }

            let finalize = order
                .finalize
                .as_deref()
                .ok_or_else(|| anyhow!("ACME order has no finalize URL"))?;
            let csr = pem_der(csr_pem).ok_or_else(|| anyhow!("CSR is not PEM"))?;
            session
                .post(finalize, Some(&json!({ "csr": base64url(&csr) })))
                .await?;
            let order_url = order_url.ok_or_else(|| anyhow!("ACME order has no location URL"))?;
            let mut order: Order =
                serde_json::from_slice(&session.post(&order_url, None).await?.body)?;
            for _ in 0..30 {
                if order.status != "processing" {
                    break;
                }
                tokio::time::sleep(self.config.order_poll).await;
                order = serde_json::from_slice(&session.post(&order_url, None).await?.body)?;
            }
            let certificate_url = match (&order.status[..], &order.certificate) {
                ("valid", Some(url)) => url.clone(),
                _ => bail!("ACME order ended in {}", order.status),
            };
            let response = session.post(&certificate_url, None).await?;
            let pem = std::str::from_utf8(&response.body)?;
            chain_from_pem(pem)
        }
        .await;
        for record in &records {
            dns.delete_txt(record).await;
        }
        if result.is_ok() {
            info!(identifiers = ?identifiers, "certificate issued");
        }
        result
    }
}

struct Session<'a> {
    http: &'a reqwest::Client,
    key: &'a Key,
    new_nonce: &'a str,
    nonce: Option<String>,
    kid: Option<String>,
}

impl Session<'_> {
    async fn fresh_nonce(&mut self) -> Result<String> {
        if let Some(nonce) = self.nonce.take() {
            return Ok(nonce);
        }
        let response = self
            .http
            .head(self.new_nonce)
            .timeout(Duration::from_secs(30))
            .send()
            .await?;
        header(response.headers(), "replay-nonce")
            .ok_or_else(|| anyhow!("ACME server returned no nonce"))
    }

    /// A signed POST; `None` is POST-as-GET. Retries a rejected nonce, which servers may do at any time.
    async fn post(&mut self, url: &str, payload: Option<&Value>) -> Result<Response> {
        for attempt in 0.. {
            let nonce = self.fresh_nonce().await?;
            let body = self.sign(url, &nonce, payload)?;
            let response = self
                .http
                .post(url)
                .header(CONTENT_TYPE, "application/jose+json")
                .timeout(Duration::from_secs(60))
                .body(body)
                .send()
                .await
                .with_context(|| format!("ACME request to {url} failed"))?;
            let status = response.status().as_u16();
            let headers = response.headers().clone();
            self.nonce = header(&headers, "replay-nonce");
            let body = response.bytes().await?;
            if status < 400 {
                return Ok(Response {
                    headers,
                    body,
                });
            }
            let problem: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            let kind = problem["type"].as_str().unwrap_or_default();
            if kind.ends_with(":badNonce") && attempt < 3 {
                continue;
            }
            let detail = problem["detail"].as_str().unwrap_or_default();
            let text = String::from_utf8_lossy(&body);
            // As the Worker's describeError: the message, the HTTP status, and the start of the response body.
            bail!(
                "{} | HTTP {status} | {}",
                if detail.is_empty() {
                    format!("ACME request to {url} failed")
                } else {
                    format!("{kind}: {detail}")
                },
                text.chars().take(300).collect::<String>()
            );
        }
        unreachable!()
    }

    fn sign(&self, url: &str, nonce: &str, payload: Option<&Value>) -> Result<String> {
        let mut protected = json!({ "alg": "ES256", "nonce": nonce, "url": url });
        match &self.kid {
            Some(kid) => protected["kid"] = kid.clone().into(),
            None => protected["jwk"] = self.key.jwk.clone(),
        }
        let protected = base64url(serde_json::to_string(&protected)?.as_bytes());
        let payload = match payload {
            Some(payload) => base64url(serde_json::to_string(payload)?.as_bytes()),
            None => String::new(),
        };
        let signature = self
            .key
            .pair
            .sign(
                &SystemRandom::new(),
                format!("{protected}.{payload}").as_bytes(),
            )
            .map_err(|_| anyhow!("signing an ACME request failed"))?;
        Ok(serde_json::to_string(&json!({
            "protected": protected,
            "payload": payload,
            "signature": base64url(signature.as_ref()),
        }))?)
    }
}

fn header(headers: &HeaderMap, name: impl reqwest::header::AsHeaderName) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

/// Reads the account key from its P-256 private JWK.
fn account_key(jwk: Option<&str>) -> Result<Key> {
    let invalid = || anyhow!("ACME_ACCOUNT_KEY_JWK is not a P-256 private JWK");
    let jwk: Value = serde_json::from_str(jwk.ok_or_else(invalid)?).map_err(|_| invalid())?;
    if jwk["kty"] != "EC" || jwk["crv"] != "P-256" {
        return Err(invalid());
    }
    let field = |name: &str| {
        jwk[name]
            .as_str()
            .and_then(decode_base64url)
            .filter(|bytes| bytes.len() == 32)
            .ok_or_else(invalid)
    };
    let (x, y, d) = (field("x")?, field("y")?, field("d")?);
    let mut public = vec![4u8];
    public.extend(&x);
    public.extend(&y);
    let pair = EcdsaKeyPair::from_private_key_and_public_key(
        &ECDSA_P256_SHA256_FIXED_SIGNING,
        &d,
        &public,
        &SystemRandom::new(),
    )
    .map_err(|_| invalid())?;
    Ok(key_from_pair(pair))
}

fn key_from_pair(pair: EcdsaKeyPair) -> Key {
    let public = pair.public_key().as_ref();
    let x = base64url(&public[1..33]);
    let y = base64url(&public[33..65]);
    // RFC 7638: the required members in lexicographic order, without whitespace.
    let thumbprint_input = format!(r#"{{"crv":"P-256","kty":"EC","x":"{x}","y":"{y}"}}"#);
    let thumbprint = base64url(
        ring::digest::digest(&ring::digest::SHA256, thumbprint_input.as_bytes()).as_ref(),
    );
    Key {
        pair,
        jwk: json!({ "crv": "P-256", "kty": "EC", "x": x, "y": y }),
        thumbprint,
    }
}

/// The EAB JWS: the account's public JWK, MACed with the HMAC key the CA issued for `kid`.
fn external_account_binding(key: &Key, kid: &str, hmac_key: &str, url: &str) -> Result<Value> {
    let secret =
        decode_base64url(hmac_key).ok_or_else(|| anyhow!("ACME_EAB_HMAC_KEY is not base64url"))?;
    let protected = base64url(
        serde_json::to_string(&json!({ "alg": "HS256", "kid": kid, "url": url }))?.as_bytes(),
    );
    let payload = base64url(serde_json::to_string(&key.jwk)?.as_bytes());
    let tag = ring::hmac::sign(
        &ring::hmac::Key::new(ring::hmac::HMAC_SHA256, &secret),
        format!("{protected}.{payload}").as_bytes(),
    );
    Ok(json!({ "protected": protected, "payload": payload, "signature": base64url(tag.as_ref()) }))
}

/// The DER of the first PEM block.
pub fn pem_der(pem: &str) -> Option<Vec<u8>> {
    use rustls_pki_types::pem::PemObject;
    if let Ok(csr) = rustls_pki_types::CertificateSigningRequestDer::from_pem_slice(pem.as_bytes()) {
        return Some(csr.as_ref().to_vec());
    }
    use base64::Engine;
    let body: String = pem
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect::<String>()
        .split_whitespace()
        .collect();
    base64::engine::general_purpose::STANDARD.decode(body).ok()
}

/// Splits a PEM chain into the leaf and the rest, formatted as the Worker formatted them: 64-column base64,
/// no trailing newline, certificates joined by one newline.
pub fn chain_from_pem(pem: &str) -> Result<Issued> {
    use rustls_pki_types::CertificateDer;
    use rustls_pki_types::pem::PemObject;
    let certificates = CertificateDer::pem_slice_iter(pem.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| anyhow!("ACME response did not contain a certificate: {error}"))?;
    let Some(leaf) = certificates.first() else {
        bail!("ACME response did not contain a certificate");
    };
    let expiry = expiry(leaf.as_ref())?;
    let pems: Vec<String> = certificates.iter().map(|der| to_pem(der.as_ref())).collect();
    Ok(Issued {
        certificate: pems[0].clone(),
        chain: pems[1..].join("\n"),
        expiry,
    })
}

pub fn to_pem(der: &[u8]) -> String {
    use base64::Engine;
    let body = base64::engine::general_purpose::STANDARD.encode(der);
    let lines: Vec<&str> = body
        .as_bytes()
        .chunks(64)
        .map(|chunk| std::str::from_utf8(chunk).expect("base64 is ASCII"))
        .collect();
    format!(
        "-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----",
        lines.join("\n")
    )
}

/// A certificate's notAfter as an ISO timestamp.
pub fn expiry(der: &[u8]) -> Result<String> {
    let (_, certificate) = x509_parser::parse_x509_certificate(der)
        .map_err(|error| anyhow!("invalid certificate: {error}"))?;
    let seconds = certificate.validity().not_after.timestamp();
    Ok(crate::clock::iso((seconds.max(0) as u64) * 1000))
}

/// Generates a P-256 account key as a private JWK, for `opentunnel-server account-key`.
pub fn generate_account_jwk() -> Result<String> {
    let rng = SystemRandom::new();
    let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng)
        .map_err(|_| anyhow!("generating a key failed"))?;
    // The private scalar sits at a fixed offset in ring's PKCS#8 encoding of a P-256 key.
    let bytes = pkcs8.as_ref();
    let d = &bytes[36..68];
    let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, bytes, &rng)
        .map_err(|_| anyhow!("reading the generated key failed"))?;
    let public = pair.public_key().as_ref();
    Ok(serde_json::to_string(&json!({
        "kty": "EC",
        "crv": "P-256",
        "x": base64url(&public[1..33]),
        "y": base64url(&public[33..65]),
        "d": base64url(d),
    }))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_generated_account_keys() {
        let jwk = generate_account_jwk().unwrap();
        let key = account_key(Some(&jwk)).unwrap();
        assert_eq!(key.thumbprint.len(), 43);
        assert!(account_key(Some(r#"{"kty":"RSA"}"#)).is_err());
        assert_eq!(
            account_key(None).err().unwrap().to_string(),
            "ACME_ACCOUNT_KEY_JWK is not a P-256 private JWK"
        );
    }

    #[test]
    fn formats_chains_like_the_worker() {
        let key = rcgen::KeyPair::generate().unwrap();
        let certificate = rcgen::CertificateParams::new(vec!["a.test".into()])
            .unwrap()
            .self_signed(&key)
            .unwrap();
        let pem = format!("{}\n{}", certificate.pem(), certificate.pem());
        let issued = chain_from_pem(&pem).unwrap();
        assert!(issued.certificate.starts_with("-----BEGIN CERTIFICATE-----\n"));
        assert!(issued.certificate.ends_with("\n-----END CERTIFICATE-----"));
        assert_eq!(issued.chain, issued.certificate);
        assert!(issued.expiry.ends_with(".000Z"));
    }
}
