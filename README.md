# OpenTunnel

OpenTunnel is a blind TLS tunnel hosted on Cloudflare. Each client receives a
unique `<id>.opentunnel.xyz` hostname and terminates TLS locally, so neither
Cloudflare Workers nor the relay stores the certificate private key or sees
HTTP plaintext.

> [!NOTE]
> We are waiting on the private beta of Cloudflare Spectrum + TCP Workers for
> this to run fully on Cloudflare. Until then, inbound TCP is temporarily
> handled by some dummy relay servers running on AWS.

## Architecture

- Spectrum accepts public TCP 443 with TLS termination disabled.
- The Worker's `connect(socket)` handler reads only ClientHello metadata and
  routes by SNI.
- One Durable Object per tunnel owns durable metadata, the authenticated bridge
  WebSocket, and active TCP channels.
- A Cloudflare Workflow issues certificates with ZeroSSL using DNS-01.
- The local bridge owns the certificate private key and forwards decrypted
  traffic to the local application.

Shared schemas, bridge framing, and the Effect HTTP API contract live in
`packages/protocol`. Server handlers, ClientHello routing, Cloudflare runtime,
and the temporary relay live in `packages/server`. The local proxy lives in
`packages/client` and is exposed through `packages/cli`.

## Configuration

Set Worker secrets before deploying:

```bash
cd packages/server
bunx wrangler secret put ACME_EAB_KID
bunx wrangler secret put ACME_EAB_HMAC_KEY
bunx wrangler secret put ACME_ACCOUNT_KEY_JWK
bunx wrangler secret put CLOUDFLARE_API_TOKEN
```

`ACME_ACCOUNT_KEY_JWK` is a one-time P-256 private JWK used as the stable
ZeroSSL account identity; it does not need scheduled rotation. The Cloudflare
API token only needs DNS edit access to the OpenTunnel zone. The zone ID, other
non-secret defaults, Durable Object binding, certificate Workflow, and apex API
route are defined in `packages/server/wrangler.jsonc`.

Spectrum must route `*.opentunnel.xyz:443` to this Worker with `tls: off`. That
Worker-backed Spectrum target is currently provisioned through Cloudflare's
inbound TCP Workers beta rather than Wrangler configuration.

For local development, copy `.env.example` to the ignored
`packages/server/.dev.vars` and fill in the secret values.

## Development

```bash
bun install
bun run cf-typegen
bun run dev
```

The local Worker listens on `http://localhost:8787`. Run the demo bridge in a
second terminal after starting a local HTTP application on port 4096:

```bash
bun run opentunnel create
bun run opentunnel route add api http://127.0.0.1:4096
bun run opentunnel connect
```

Useful commands:

```bash
bun run ready
bun run deploy
```

`bun run ready` runs every package's tests, TypeScript checks, and a Wrangler
dry-run bundle.
