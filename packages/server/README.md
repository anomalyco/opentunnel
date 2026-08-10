# OpenTunnel Server

This package is the complete hosted OpenTunnel application:

- HTTP control API
- inbound Spectrum TCP handler
- per-tunnel Durable Objects
- bridge WebSocket transport
- ZeroSSL certificate Workflow

Run locally with `bun run dev`, validate with `bun run build`, and deploy with
`bun run deploy`. See the repository README for required Worker secrets and
Spectrum configuration.
