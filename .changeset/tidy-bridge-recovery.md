---
"opentunnel": patch
---

Improve bridge recovery and resource usage with lifetime WebSocket error handling,
heartbeat detection, cancellable exponential reconnect backoff, one certificate
check per connection, and a shared local TLS listener. Apply stream backpressure
using the npm WebSocket implementation and avoid copying incoming frame payloads.
