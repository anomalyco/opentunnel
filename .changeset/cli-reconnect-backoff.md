---
"opentunnel": patch
---

Reconnect with capped, jittered exponential backoff, cancel stale retries on
reload and stop, deduplicate repeated connection errors with timestamps, and
report unexpected worker defects instead of leaving the daemon idle.
