---
"opentunnel": patch
---

Keep bridge WebSocket error handling active for the socket lifetime, clean up
failed or canceled attachments, detect heartbeat loss, validate certificates
once per connection, share one local TLS listener per bridge, and apply
transport backpressure using the npm WebSocket implementation.
