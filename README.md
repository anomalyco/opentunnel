# OpenTunnel

OpenTunnel is a blind TLS tunnel hosted on Cloudflare. Each client receives a
unique `<id>.opentunnel.xyz` hostname and terminates TLS locally, so neither
Cloudflare Workers nor the relay stores the certificate private key or sees
HTTP plaintext.

> [!NOTE]
> We are waiting on the private beta of Cloudflare Spectrum + TCP Workers for
> this to run fully on Cloudflare. Until then, inbound TCP is temporarily
> handled by some dummy relay servers running on AWS.

## Installation

Install the CLI with any of:

```bash
curl -fsSL https://opentunnel.xyz/install | sh
brew install anomalyco/tap/opentunnel
yay -S opentunnel-bin                  # Arch Linux (AUR)
npm install -g opentunnel              # or bun / pnpm
cargo install opentunnel-cli
```

Prebuilt binaries for Linux and macOS (x64 and arm64) are attached to each
[GitHub release](https://github.com/anomalyco/opentunnel/releases).

Then route a subdomain to a local port. This creates the tunnel on first use
and starts the background service:

```bash
opentunnel route add api 3000
```

See [packages/cli](packages/cli) for the full command reference.

## Architecture

- Spectrum accepts public TCP 443 with TLS termination disabled.
- The Worker's `connect(socket)` handler reads only ClientHello metadata and
  routes by SNI.
- One Durable Object per tunnel owns durable metadata, the authenticated bridge
  WebSocket, and active TCP channels.
- A Cloudflare Workflow issues certificates with ZeroSSL using DNS-01.
- The local client owns the certificate private key, terminates TLS, and
  forwards decrypted traffic to the local application.

There are two client implementations that share one protocol:

| Path | What it is |
| --- | --- |
| `crates/opentunnel` | Rust client library and wire types, published as `opentunnel` on crates.io |
| `crates/opentunnel-cli` | The `opentunnel` CLI and per-profile background service |
| `packages/client` | Pure TypeScript SDK for Bun (`@opentunnel/client`) |
| `packages/protocol` | TypeScript schemas, bridge framing, and the HTTP API contract |
| `packages/server` | Cloudflare Worker, Durable Objects, Workflow, temporary relay |
| `packages/cli` | npm launcher and publish script for the Rust CLI |

The wire protocol and on-disk layout are specified in
[docs/protocol.md](docs/protocol.md). Both clients are tested against the
shared vectors in `spec/vectors`, so a change to the protocol must update the
spec, the vectors, and both clients.

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

The local Worker listens on `http://localhost:8787`. Point the CLI at it in a
second terminal after starting a local HTTP application on port 4096:

```bash
export OPENTUNNEL_API=http://localhost:8787
bun run opentunnel route add api 4096
```

Useful commands:

```bash
bun run test      # Rust and TypeScript tests
bun run ready     # TypeScript checks and a Wrangler dry-run bundle
bun run deploy
```
