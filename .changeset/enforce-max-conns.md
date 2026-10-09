---
"@opentunnel/client": patch
"@opentunnel/protocol": patch
"opentunnel": patch
---

Clients now enforce the `max_conns` they advertise on attach: a connection opened beyond it is reset with `too_many_connections` before any TLS state is allocated.
