---
"@opentunnel/client": minor
"@opentunnel/protocol": minor
"opentunnel": minor
---

Routes can opt in to the PROXY protocol, so the local service sees each visitor's address. With `opentunnel route add 3000 --proxy-protocol v1|v2`, `api = { target = "127.0.0.1:4000", proxy_protocol = "v2" }` in the profile config, or `{ target, proxyProtocol: "v2" }` in the SDK, the client writes a PROXY v1 or v2 header (the visitor's address and port as the source, port 443 as the destination, and for v2 the requested hostname in a `PP2_TYPE_AUTHORITY` TLV) before each connection's data, which is still forwarded unchanged. Routes without options behave and are written exactly as before. Re-adding a route with different options updates it.

A profile config that uses the table form for a route can't be read by older CLIs. The Rust crate's `Routes` now maps names to `Route` (which converts from a target string), and `@opentunnel/protocol` adds a `proxy-protocol` module.
