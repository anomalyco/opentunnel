# opentunnel

## 0.5.3

### Patch Changes

- 5ab6de9: Route URLs no longer leak to other users on the same machine. The CLI writes the profile config (`~/.config/opentunnel/<profile>.toml`) and the service log (`~/.local/state/opentunnel/<profile>/daemon.log`), which contain route names, readable only by you, and tightens files left world-readable by earlier versions whenever it runs. The systemd unit and launchd agent run the service with a 0077 umask. Without `XDG_RUNTIME_DIR`, the control-socket directory in the shared temporary directory must be a 0700 directory owned by you; the CLI refuses one created by another user. The Rust client requires rustls 0.23.46.

## 0.5.2

### Patch Changes

- 03f79b5: The CLI and Rust client work behind TLS-inspecting corporate proxies. The API and bridge connections to `opentunnel.xyz` now trust the OS trust store (honoring `SSL_CERT_FILE` and `SSL_CERT_DIR`) in addition to the bundled Mozilla roots, instead of failing with `invalid peer certificate: UnknownIssuer`. A specific CA can be added with `--ca-cert <path>` or `OPENTUNNEL_CA_CERT` (a PEM file with one or more certificates); the background service is registered with it. Rust: `ClientOptions::ca_cert`, `opentunnel::tls::read_ca_certificates`. The TypeScript SDK README documents the runtime equivalents (`NODE_EXTRA_CA_CERTS`, `--use-system-ca`, `DENO_CERT`). Tunneled visitor traffic is unchanged.

## 0.5.1

### Patch Changes

- 4f5a5d7: API requests survive brief outages of the hosted API, such as Cloudflare answering 525 while a server restarts. The CLI and the SDK retry network errors, 429 and 5xx (including Cloudflare's 520-527) with capped exponential backoff: reads and certificate requests on any transient failure, creating or deleting a tunnel only when the request cannot have arrived. Errors now name the HTTP status and, for Cloudflare's codes, what they mean (`Failed to read certificate: Cloudflare 525: the SSL handshake with the server failed (HTTP 525)` instead of `Failed to read certificate`), and a failed bridge upgrade in the CLI names its status too. When the certificate check before connecting still fails, a saved certificate that has not expired is used, so `tunnel.ensure` and `connect` no longer fail on a 525. `@opentunnel/protocol` exports the shared policy as `ApiRetry`.

## 0.5.0

### Minor Changes

- 741efd9: Routes can opt in to the PROXY protocol, so the local service sees each visitor's address. With `opentunnel route add 3000 --proxy-protocol v1|v2`, `api = { target = "127.0.0.1:4000", proxy_protocol = "v2" }` in the profile config, or `{ target, proxyProtocol: "v2" }` in the SDK, the client writes a PROXY v1 or v2 header (the visitor's address and port as the source, port 443 as the destination, and for v2 the requested hostname in a `PP2_TYPE_AUTHORITY` TLV) before each connection's data, which is still forwarded unchanged. Routes without options behave and are written exactly as before. Re-adding a route with different options updates it.
  
  A profile config that uses the table form for a route can't be read by older CLIs. The Rust crate's `Routes` now maps names to `Route` (which converts from a target string), and `@opentunnel/protocol` adds a `proxy-protocol` module.

## 0.4.1

### Patch Changes

- f532395: Clients now enforce the `max_conns` they advertise on attach: a connection opened beyond it is reset with `too_many_connections` before any TLS state is allocated.

## 0.4.0

## 0.3.0

### Minor Changes

- 7ff6c14: `route add` now takes just the target and gives the route a random 16-character name, so its URL can't be guessed (`opentunnel route add 3000`). Adding the same target again keeps that route. Use `--name api` for a readable name, or `--name @` for the tunnel hostname. The old `route add <name> <target>` form still works and prints a note.

## 0.2.2

### Patch Changes

- bbce5b7: The CLI, the SDK, the protocol package, and the Rust crates now always share one version number.

## 0.1.5

### Patch Changes

- cdb8954: Identify the client to the server (`opentunnel/<version>` for the CLI, `opentunnel-sdk/<version>` for the SDK), including on the bridge connection.

## 0.1.4

### Patch Changes

- dee1174: Publish to Homebrew: `brew install anomalyco/tap/opentunnel`.

## 0.1.3

### Patch Changes

- 7464a51: On macOS, fall back to a plain background process when no one is logged in at the console (for example over SSH), instead of failing to start the launchd service.

## 0.1.2

### Patch Changes

- d22e6f8: Publish the `opentunnel` and `opentunnel-cli` crates to crates.io with every release, at the same version as npm.

## 0.1.1

### Patch Changes

- 8960fa2: Fix `npm i -g opentunnel` not installing the `opentunnel` command.

## 0.1.0

### Minor Changes

- 54e2493: Rewrite the CLI in Rust and ship it as a native binary; Bun is no longer required. The commands are now `up`, `down`, `status`, `route add|remove|list`, `serve`, and `delete`. `route add api 3000` creates the tunnel on first use and starts the background service, which starts at login where systemd or launchd is available, reconnects with backoff, and picks up renewed certificates without dropping connections. Routes accept a bare port, and `@` routes the tunnel hostname itself. Custom tunnel names are no longer supported.

## 0.0.30

### Patch Changes

- aac6b95: Publish the new Open Tunnel CLI under the transferred npm package.
