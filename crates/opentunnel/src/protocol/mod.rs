//! Wire types shared with the TypeScript client. See `docs/protocol.md`.

pub mod api;
pub mod bridge;
pub mod names;

pub use bridge::{ClientMessage, ServerMessage};
