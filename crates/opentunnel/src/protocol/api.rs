use serde::{Deserialize, Serialize};

pub const DEFAULT_API: &str = "https://opentunnel.xyz";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateTunnelResponse {
    pub tunnel: TunnelInfo,
    pub token: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TunnelState {
    Offline,
    Online,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelInfo {
    pub id: String,
    pub hostname: String,
    pub state: TunnelState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub certificate_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BindCertificateRequest {
    pub csr: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CertificateInfo {
    pub id: String,
    pub state: CertificateState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum CertificateState {
    Challenge {
        token: String,
        key: String,
    },
    Issuing,
    Ready {
        certificate: String,
        chain: String,
        expiry: String,
    },
    Failed {
        reason: String,
    },
}

/// Error body returned by the HTTP API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiError {
    #[serde(rename = "_tag")]
    pub tag: String,
    #[serde(default)]
    pub message: String,
}
