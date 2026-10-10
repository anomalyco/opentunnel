# OpenTunnel

OpenTunnel is a blind TLS tunnel. Each client receives a unique
`<id>.opentunnel.xyz` hostname and terminates TLS locally, so the server never
holds the certificate private key or sees HTTP plaintext.

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

The hosted service is one Rust binary, `crates/opentunnel-server`, on Fly.io
([docs/server.md](docs/server.md)):

- It accepts public TCP on 443 and reads only the TLS ClientHello. A tunnel
  hostname (`<id>.opentunnel.xyz` or `<route>.<id>.opentunnel.xyz`) is carried,
  still encrypted, over the tunnel's bridge WebSocket to the client that
  claimed the route.
- `opentunnel.xyz` itself is terminated with the server's own certificate and
  serves the HTTP API, the bridge WebSocket, and the website.
- Tunnel records, certificate state, and durable issuance jobs live in SQLite
  on a Fly volume.
- Certificates come from ZeroSSL over ACME with DNS-01 challenges in the
  Cloudflare-hosted zone, and renew 30 days before expiry.
- The local client owns the certificate private key, terminates TLS, and
  forwards decrypted traffic to the local application.

There are two client implementations that share one protocol:

| Path | What it is |
| --- | --- |
| `crates/opentunnel` | Rust client library and wire types, published as `opentunnel` on crates.io |
| `crates/opentunnel-cli` | The `opentunnel` CLI and per-profile background service |
| `crates/opentunnel-server` | The hosted service: SNI routing, bridges, API, certificates (not published) |
| `packages/client` | TypeScript SDK (`@opentunnel/client`), compiled to JavaScript for Bun, Node, and Deno |
| `packages/protocol` | TypeScript schemas, bridge framing, and the HTTP API contract |
| `packages/website` | The landing page, built with Vite and served by the server |
| `packages/cli` | npm launcher and publish script for the Rust CLI |
| `migration` | Temporary tooling for the move off the Cloudflare Worker ([docs/cutover.md](docs/cutover.md)) |

The wire protocol and on-disk layout are specified in
[docs/protocol.md](docs/protocol.md). Both clients are tested against the
shared vectors in `spec/vectors`, so a change to the protocol must update the
spec, the vectors, and both clients.

## Deployment

`Dockerfile` builds the server and the website into one image; `fly.toml`
runs it as the `opentunnel` Fly app in `iad` with a volume for SQLite, raw TCP
on 443 (with a dedicated IPv4) and 80. Deploy with `fly deploy`, or run the
manual "Deploy to Fly" GitHub workflow. Configuration and secrets are listed
in [docs/server.md](docs/server.md).

## Development

```bash
bun install
bun run ready     # TypeScript builds and the website (dist/website)
bun run test      # Rust and TypeScript tests
```

Run the server locally with its insecure built-in test CA, serving the whole
app on plain HTTP:

```bash
ISSUER=local OPENTUNNEL_DOMAIN=localhost DATABASE_PATH=.local/opentunnel.db \
  WEBSITE_DIR=dist/website TLS_LISTEN='[::]:8443' HTTP_LISTEN='[::]:8080' HTTP_MODE=serve \
  cargo run -p opentunnel-server
```

`*.localhost` resolves to the loopback address on most systems, so tunnels are
reachable at `https://<route>.<id>.localhost:8443` (trust
`.local/local-ca.pem`). Point the CLI at it in a second terminal after starting
a local HTTP application on port 4096:

```bash
export OPENTUNNEL_API=http://localhost:8080
bun run opentunnel route add 4096
```

`bun run dev` serves the website with hot reload on `http://127.0.0.1:4190`
and proxies `/api` to that server.
