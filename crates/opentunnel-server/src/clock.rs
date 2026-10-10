//! Wall-clock time, injectable so renewal scheduling can be tested.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const SECOND_MS: u64 = 1_000;
pub const MINUTE_MS: u64 = 60 * SECOND_MS;
pub const HOUR_MS: u64 = 60 * MINUTE_MS;
pub const DAY_MS: u64 = 24 * HOUR_MS;

#[derive(Clone)]
pub struct Clock(Source);

#[derive(Clone)]
enum Source {
    System,
    Manual(Arc<AtomicU64>),
}

impl Clock {
    pub fn system() -> Self {
        Self(Source::System)
    }

    /// A clock that only moves when told to, starting at `ms`.
    pub fn manual(ms: u64) -> (Self, Arc<AtomicU64>) {
        let now = Arc::new(AtomicU64::new(ms));
        (Self(Source::Manual(now.clone())), now)
    }

    /// Milliseconds since the Unix epoch.
    pub fn now_ms(&self) -> u64 {
        match &self.0 {
            Source::System => SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or_default(),
            Source::Manual(now) => now.load(Ordering::SeqCst),
        }
    }

    /// The current time as JavaScript's `Date.prototype.toISOString` formats it.
    pub fn iso(&self) -> String {
        iso(self.now_ms())
    }
}

/// `2026-10-09T12:00:00.000Z`, the format the Durable Object stored.
pub fn iso(ms: u64) -> String {
    humantime::format_rfc3339_millis(UNIX_EPOCH + Duration::from_millis(ms)).to_string()
}

/// Parses an RFC 3339 timestamp to Unix milliseconds, like `Date.parse` for the formats we store.
pub fn parse_iso(value: &str) -> Option<u64> {
    let time = humantime::parse_rfc3339_weak(value.trim()).ok()?;
    Some(time.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    #[test]
    fn round_trips_javascript_timestamps() {
        let ms = super::parse_iso("2026-10-09T12:34:56.789Z").unwrap();
        assert_eq!(super::iso(ms), "2026-10-09T12:34:56.789Z");
        assert_eq!(super::iso(0), "1970-01-01T00:00:00.000Z");
        assert!(super::parse_iso("not a date").is_none());
    }
}
