use crate::protocol::api::{
    ApiError, BindCertificateRequest, CertificateInfo, CreateTunnelResponse, TunnelInfo,
};
use reqwest::{Method, RequestBuilder, Response, Url};
use serde::de::DeserializeOwned;

use crate::error::{Error, Result};

#[derive(Debug, Clone)]
pub struct Api {
    base: Url,
    http: reqwest::Client,
}

impl Api {
    pub fn new(base: Url) -> Self {
        crate::install_crypto_provider();
        // Bundled Mozilla roots, like the bridge WebSocket, so the client
        // works on systems without a CA store (for example slim containers).
        let roots = webpki_root_certs::TLS_SERVER_ROOT_CERTS
            .iter()
            .filter_map(|certificate| reqwest::Certificate::from_der(certificate).ok());
        let http = reqwest::Client::builder()
            .tls_certs_only(roots)
            .build()
            .expect("HTTP client configuration is valid");
        Self { base, http }
    }

    pub fn base(&self) -> &Url {
        &self.base
    }

    fn request(&self, method: Method, path: &str, token: Option<&str>) -> RequestBuilder {
        let url = self.base.join(path).expect("API paths are valid");
        let request = self.http.request(method, url).header(
            "user-agent",
            concat!("opentunnel/", env!("CARGO_PKG_VERSION")),
        );
        match token {
            Some(token) => request.bearer_auth(token),
            None => request,
        }
    }

    pub async fn create(&self) -> Result<CreateTunnelResponse> {
        json(
            self.request(Method::POST, "/api/tunnel", None)
                .json(&serde_json::json!({})),
        )
        .await
    }

    pub async fn get(&self, token: &str, id: &str) -> Result<TunnelInfo> {
        json(self.request(Method::GET, &tunnel_path(id, ""), Some(token))).await
    }

    pub async fn bind_certificate(
        &self,
        token: &str,
        id: &str,
        csr: &str,
    ) -> Result<CertificateInfo> {
        let body = BindCertificateRequest {
            csr: csr.to_owned(),
        };
        json(
            self.request(Method::POST, &tunnel_path(id, "/certificate"), Some(token))
                .json(&body),
        )
        .await
    }

    pub async fn certificate(&self, token: &str, id: &str) -> Result<CertificateInfo> {
        json(self.request(Method::GET, &tunnel_path(id, "/certificate"), Some(token))).await
    }

    pub async fn remove(&self, token: &str, id: &str) -> Result<()> {
        checked(
            self.request(Method::DELETE, &tunnel_path(id, ""), Some(token))
                .send()
                .await?,
        )
        .await
        .map(drop)
    }

    /// The bridge WebSocket URL for a tunnel.
    pub fn connect_url(&self, id: &str) -> Url {
        let mut url = self
            .base
            .join(&tunnel_path(id, "/connect"))
            .expect("API paths are valid");
        let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
        url.set_scheme(scheme).expect("ws schemes are valid");
        url
    }
}

fn tunnel_path(id: &str, suffix: &str) -> String {
    format!("/api/tunnel/{id}{suffix}")
}

async fn checked(response: Response) -> Result<Response> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let body = response.text().await.unwrap_or_default();
    let error = serde_json::from_str::<ApiError>(&body).unwrap_or_else(|_| ApiError {
        tag: "HttpError".into(),
        message: body.chars().take(200).collect(),
    });
    Err(Error::Api {
        status: status.as_u16(),
        tag: error.tag,
        message: error.message,
    })
}

async fn json<T: DeserializeOwned>(request: RequestBuilder) -> Result<T> {
    Ok(checked(request.send().await?).await?.json().await?)
}
