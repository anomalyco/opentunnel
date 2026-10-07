//! OpenTunnel client: create blind TLS tunnels and forward them to local
//! services. TLS terminates in this process, so the relay never sees
//! plaintext or the private key.
//!
//! ```no_run
//! # async fn run() -> opentunnel::Result<()> {
//! let client = opentunnel::Client::default();
//! client.ensure("default").await?;
//! let routes = [("api".to_string(), "127.0.0.1:3000".to_string())].into();
//! let mut tunnel = client.connect("default", routes)?;
//! tunnel.wait().await
//! # }
//! ```

pub mod api;
mod client;
mod error;
mod identity;
pub mod paths;
mod provision;
mod storage;
mod tunnel;

pub use client::{Client, ClientOptions, ProvisionStage};
pub use error::{Error, Result};
pub use identity::{Identity, PendingIdentity};
pub mod protocol;
pub use storage::Storage;
pub use tunnel::{Event, Routes, State, Status, Tunnel};

/// Installs the ring crypto provider as the process default for rustls.
pub(crate) fn install_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}
