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

Then route a local port. This creates the tunnel on first use, starts the
background service, and prints the route's URL:

```bash
opentunnel route add 3000
# Added route 21992cc9713e5fc5 → 127.0.0.1:3000
# https://21992cc9713e5fc5.<id>.opentunnel.xyz
```

Routes get a random 16-character name by default. Route names never appear in
public certificate logs, so the URL can't be guessed, but anyone you share it
with can reach the service: it is not authentication. Pass `--name api` for a
readable name instead.

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
| `packages/server` | The Worker's code: API, Durable Objects, certificate Workflow, and the TCP relay |
| `packages/website` | The landing page, served as the Worker's static assets |
| `packages/cli` | npm launcher and publish script for the Rust CLI |

The wire protocol and on-disk layout are specified in
[docs/protocol.md](docs/protocol.md). Both clients are tested against the
shared vectors in `spec/vectors`, so a change to the protocol must update the
spec, the vectors, and both clients.

## Configuration

Everything hosted is one Cloudflare Worker, described by `cloudflare.config.ts`
at the repository root: the API under `/api/*`, and the website (the Vite build
of `packages/website`, with `index.html` at the root) as static assets for
everything else. Every deployment has a mode, and every resource is named after
it: `--mode production` is `opentunnel-production` on opentunnel.xyz, while any
other mode (`--mode dev`) is a separate Worker, with its own Durable Objects
and Workflow, on workers.dev. Anything that differs between stages switches on
the mode in that file. The config loads with Node 22.18 or later, not Bun.

```bash
bun run ready                      # types, TypeScript checks, and the Worker build
bun run deploy --mode production   # deploy that build (cf deploy --prebuilt)
```

`vite build` builds production by default; build another stage with
`bunx vite build --mode dev`, then `bun run deploy --mode dev`. CI deploys
production on every change to `master`.

The Worker needs these secrets in each mode. They persist across deploys; set
them once with `bun run deploy --mode <mode> --secrets-file secrets.json`:
`ACME_EAB_KID`, `ACME_EAB_HMAC_KEY`, `ACME_ACCOUNT_KEY_JWK`,
`CLOUDFLARE_API_TOKEN` and `RELAY_TOKEN`. `ACME_ACCOUNT_KEY_JWK` is a one-time
P-256 private JWK used as the stable ZeroSSL account identity; it does not need
scheduled rotation. The Cloudflare API token only needs DNS edit access to the
OpenTunnel zone. `RELAY_TOKEN` must match the TCP relay's.

Tenant TLS is never terminated in the Worker. `*.opentunnel.xyz` resolves to a
TCP relay host running `packages/server/relay/index.mjs`, which carries each
connection over a WebSocket to `/api/relay`; the Worker's `connect(socket)`
handler takes the same connections directly once Spectrum routes
`*.opentunnel.xyz:443` to it with TLS passthrough.

## Development

```bash
bun install
cp .dev.vars.example .dev.vars   # fill in the secrets
bun run dev
```

`bun run dev` runs the site and the Worker together on
`http://127.0.0.1:4190`. With the current beta of `@cloudflare/vite-plugin`
the local Worker runtime does not answer requests (`fetch failed`), so until it
does, deploy a stage instead: `bunx vite build --mode dev && bun run deploy
--mode dev`. Point the CLI at it in a second terminal after
starting a local HTTP application on port 4096:

```bash
export OPENTUNNEL_API=http://127.0.0.1:4190
bun run opentunnel route add 4096
```

Useful commands:

```bash
bun run test      # Rust and TypeScript tests
bun run ready     # types, TypeScript checks, and the Worker build
bun run deploy --mode production
```
