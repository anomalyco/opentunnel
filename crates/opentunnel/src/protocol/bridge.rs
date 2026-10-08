use serde::{Deserialize, Serialize};

pub const WEBSOCKET_SUBPROTOCOL: &str = "opentunnel";
pub const HEARTBEAT_MS: u64 = 15_000;
pub const IDLE_TIMEOUT_MS: u64 = 45_000;
pub const CONNECT_TIMEOUT_MS: u64 = 10_000;
pub const RECONNECT_BACKOFF_MIN_MS: u64 = 250;
pub const RECONNECT_BACKOFF_MAX_MS: u64 = 30_000;
pub const MAX_PAYLOAD_SIZE: usize = 32 * 1024;
pub const CONN_ID_SIZE: usize = 4;

pub type ConnId = u32;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientInfo {
    pub version: String,
    pub max_conns: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    Attach {
        token: String,
        transport: Transport,
        routes: Vec<String>,
        client: ClientInfo,
    },
    Ping {
        time_sent: u64,
    },
    Pong {
        time_sent: u64,
    },
    End {
        conn: ConnId,
    },
    Reset {
        conn: ConnId,
        code: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Transport {
    Ws,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    Attached {
        session: String,
        routes: Vec<String>,
        heartbeat_ms: u64,
        idle_timeout_ms: u64,
    },
    AttachError {
        code: String,
    },
    Open {
        conn: ConnId,
        peer: String,
        sni: String,
        alpn: String,
    },
    Ping {
        time_sent: u64,
    },
    Pong {
        time_sent: u64,
    },
    Drain {
        reason: String,
    },
    End {
        conn: ConnId,
    },
    Reset {
        conn: ConnId,
        code: String,
    },
}

const SERVER_TYPES: &[&str] = &[
    "attached",
    "attach_error",
    "open",
    "ping",
    "pong",
    "drain",
    "end",
    "reset",
];

#[derive(Debug, thiserror::Error)]
pub enum DecodeError {
    #[error("invalid control message: {0}")]
    Invalid(#[from] serde_json::Error),
}

impl ServerMessage {
    /// Decodes a server control message. Returns `Ok(None)` for message types
    /// this client does not know, which the protocol requires to be ignored.
    pub fn decode(text: &str) -> Result<Option<Self>, DecodeError> {
        let value: serde_json::Value = serde_json::from_str(text)?;
        let known = value
            .get("type")
            .and_then(|kind| kind.as_str())
            .is_some_and(|kind| SERVER_TYPES.contains(&kind));
        if !known && value.get("type").is_some_and(|kind| kind.is_string()) {
            return Ok(None);
        }
        Ok(Some(serde_json::from_value(value)?))
    }
}

pub mod codes {
    pub const BAD_TOKEN: &str = "bad_token";
    pub const CERT_NOT_READY: &str = "cert_not_ready";
    pub const UNKNOWN_ROUTE: &str = "unknown_route";
    pub const TOO_MANY_CONNECTIONS: &str = "too_many_connections";
    pub const UPSTREAM_CONNECT_FAILED: &str = "upstream_connect_failed";
    pub const UPSTREAM_IO_ERROR: &str = "upstream_io_error";

    /// Attach errors that will not succeed on retry.
    pub fn is_fatal_attach_error(code: &str) -> bool {
        matches!(code, BAD_TOKEN | CERT_NOT_READY)
    }
}

pub fn encode_data_frame(conn: ConnId, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(CONN_ID_SIZE + payload.len());
    frame.extend_from_slice(&conn.to_be_bytes());
    frame.extend_from_slice(payload);
    frame
}

pub fn decode_data_frame(frame: &[u8]) -> Option<(ConnId, &[u8])> {
    let (head, payload) = frame.split_at_checked(CONN_ID_SIZE)?;
    Some((ConnId::from_be_bytes(head.try_into().ok()?), payload))
}
