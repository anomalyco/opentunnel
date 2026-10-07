---
"opentunnel": minor
---

Rewrite the CLI in Rust and ship it as a native binary; Bun is no longer required. The commands are now `up`, `down`, `status`, `route add|remove|list`, `serve`, and `delete`. `route add api 3000` creates the tunnel on first use and starts the background service, which starts at login where systemd or launchd is available, reconnects with backoff, and picks up renewed certificates without dropping connections. Routes accept a bare port, and `@` routes the tunnel hostname itself. Custom tunnel names are no longer supported.
