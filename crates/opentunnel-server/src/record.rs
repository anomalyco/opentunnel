//! The stored tunnel record. Field names and JSON shape match the Durable Object's `StoredTunnel`, so records
//! exported from the Worker import unchanged and export back the same way.

use opentunnel::protocol::api::{CertificateInfo, CertificateState, TunnelState};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredTunnel {
    pub version: u32,
    pub id: String,
    pub hostname: String,
    pub state: TunnelState,
    #[serde(
        rename = "certificateID",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub certificate_id: Option<String>,
    pub token_hash: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub certificate: Option<CertificateInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub certificate_csr: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub certificate_identifiers: Option<Vec<String>>,
    /// When issuance of the current certificate started; absent on tunnels issued before it was recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub certificate_started_at: Option<String>,
    /// Set on every successful bridge attach; renewals skip tunnels idle longer than a certificate lifetime.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_connected_at: Option<String>,
    /// A renewal issuing alongside the current certificate, which keeps serving until it completes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub renewal: Option<Renewal>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Renewal {
    #[serde(rename = "certificateID")]
    pub certificate_id: String,
    pub started_at: String,
}

impl StoredTunnel {
    pub fn is_deleted(&self) -> bool {
        self.deleted_at.is_some()
    }

    pub fn ready_expiry(&self) -> Option<&str> {
        match &self.certificate.as_ref()?.state {
            CertificateState::Ready { expiry, .. } => Some(expiry),
            _ => None,
        }
    }

    pub fn certificate_ready(&self) -> bool {
        self.ready_expiry().is_some()
    }

    pub fn identifiers(&self) -> Vec<String> {
        self.certificate_identifiers
            .clone()
            .unwrap_or_else(|| vec![self.hostname.clone()])
    }
}

/// `TunnelInfo` as the API returns it.
#[derive(Debug, Clone, Serialize)]
pub struct TunnelView {
    pub id: String,
    pub hostname: String,
    pub state: TunnelState,
    #[serde(rename = "certificateID", skip_serializing_if = "Option::is_none")]
    pub certificate_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_and_writes_durable_object_records() {
        let exported = serde_json::json!({
            "version": 1,
            "id": "abcdefghijkl",
            "hostname": "abcdefghijkl.opentunnel.xyz",
            "tokenHash": "00ff",
            "state": "online",
            "createdAt": "2026-10-01T00:00:00.000Z",
            "certificateID": "cert_1",
            "certificate": {
                "id": "cert_1",
                "state": { "type": "ready", "certificate": "C", "chain": "CH", "expiry": "2026-12-30T00:00:00.000Z" }
            },
            "certificateCsr": "CSR",
            "certificateIdentifiers": ["abcdefghijkl.opentunnel.xyz", "*.abcdefghijkl.opentunnel.xyz"],
            "lastConnectedAt": "2026-10-02T00:00:00.000Z",
            "renewal": { "certificateID": "cert_2", "startedAt": "2026-10-03T00:00:00.000Z" }
        });
        let record: StoredTunnel = serde_json::from_value(exported.clone()).unwrap();
        assert_eq!(record.ready_expiry(), Some("2026-12-30T00:00:00.000Z"));
        assert_eq!(record.renewal.as_ref().unwrap().certificate_id, "cert_2");
        assert_eq!(serde_json::to_value(&record).unwrap(), exported);
    }
}
