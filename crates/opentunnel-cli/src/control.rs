//! Messages on the daemon's Unix control socket: one JSON request line and
//! one JSON response line per connection.

use std::path::PathBuf;

use opentunnel::Status;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Command {
    Status,
    Reload,
    Stop,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Request {
    pub command: Command,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Response {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<DaemonStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    NoTunnel,
    Provisioning,
    Running,
    Stopped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonStatus {
    pub pid: u32,
    pub version: String,
    pub profile: String,
    pub phase: Phase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tunnel: Option<TunnelStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub started_at: u64,
}

/// Mirror of [`opentunnel::Status`] that can also be deserialized.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TunnelStatus {
    pub state: String,
    pub hostname: String,
    pub routes: opentunnel::Routes,
    pub session: Option<String>,
    pub connections: usize,
    pub last_error: Option<String>,
    pub connected_at: Option<u64>,
}

impl From<Status> for TunnelStatus {
    fn from(status: Status) -> Self {
        let state = serde_json::to_value(&status.state)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap_or_default();
        Self {
            state,
            hostname: status.hostname,
            routes: status.routes,
            session: status.session,
            connections: status.connections,
            last_error: status.last_error,
            connected_at: status.connected_at,
        }
    }
}

pub struct Paths {
    pub socket: PathBuf,
    pub lock: PathBuf,
    pub log: PathBuf,
    pub last_error: PathBuf,
}

pub fn paths(profile: &str) -> Paths {
    let runtime = opentunnel::paths::runtime_dir();
    let state = opentunnel::paths::state_dir().join(profile);
    Paths {
        socket: runtime.join(format!("{profile}.sock")),
        lock: runtime.join(format!("{profile}.lock")),
        log: state.join("daemon.log"),
        last_error: state.join("last-error.json"),
    }
}
