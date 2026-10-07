# OpenTunnel Server

The code of the hosted OpenTunnel Worker:

- HTTP control API
- inbound TCP handler, routed by SNI
- per-tunnel Durable Objects
- bridge WebSocket transport
- ZeroSSL certificate Workflow
- `relay/index.mjs`, the TCP relay that carries `*.opentunnel.xyz:443` connections to the Worker

The Worker is configured, built, and deployed from the repository root
(`cloudflare.config.ts`); `bun run build` here only typechecks. See the
repository README.
