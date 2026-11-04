# OpenTunnel Client

`@opentunnel/client` is a TypeScript SDK that creates tunnels and forwards them
to local services from inside your process. It ships compiled JavaScript with
type declarations and runs on Bun, Node, and Deno. `effect` is a peer
dependency, so an app that already uses Effect shares one copy with the SDK. TLS terminates in
your process, so the relay never sees plaintext or your private key.

It implements the same protocol and on-disk layout as the Rust client and CLI
(see `docs/protocol.md`), so a tunnel created by the CLI can be used here and
vice versa.

## Quick start

```ts
import { create } from "@opentunnel/client"

const client = create()
const connection = await client.tunnel.connect({
  routes: { api: "127.0.0.1:3000" },
})
console.log(connection.urls.api) // https://api.<hostname>

for await (const event of connection.events) console.log(event)
```

`connect` creates the profile's tunnel if it has none, resolves once the bridge
first attaches, and reconnects with backoff until you call `close()`. It
rejects on fatal errors such as an invalid token, with an
`OpenTunnelClientError` whose `code` is the bridge's error code (`bad_token`,
`cert_not_ready`, `route_conflict`).

Pass `signal` to cancel: aborting it while `connect` is still creating the
tunnel, waiting for its certificate, or attaching stops that work and rejects
with the signal's reason (an already aborted signal rejects at once). Aborting
after `connect` resolved closes the connection. In the Effect interface,
interrupting `connect` does the same.

`events` is only available once `connect` resolves; pass `onEvent` to see
every event as it happens, including those while it is still attaching.

The Effect interface exposes the same capabilities, with scoped connections and
events as a `Stream`:

```ts
import { OpenTunnelClient } from "@opentunnel/client/effect"
```

## Routes

Routes map a name to a `host:port` target. A name is a subdomain label, or `@`
for the tunnel hostname itself. Path routing is not supported.

```ts
await connection.setRoutes({ api: "127.0.0.1:4000", "@": "127.0.0.1:8080" })
```

Changing only targets applies to new connections immediately. Adding or
removing names re-attaches the bridge.

`connection.urls` maps each current route to its public URL
(`https://api.<hostname>`, and `https://<hostname>` for `@`) and follows
`setRoutes`. `publicUrl(route, hostname)` builds one without a connection.

Route names are checked with `isValidRouteName(name)`, the rule `connect` and
`setRoutes` apply: `ROOT_ROUTE` (`@`) or one lowercase DNS label
(`ROUTE_LABEL_PATTERN`). Validate names up front with it rather than copying
the pattern.

### Route conflicts

A route belongs to one bridge at a time, so a route another client (the CLI,
or another process) already serves is refused with `route_conflict`. By
default `connect` keeps retrying with backoff and takes the route over once the
other client goes away. Each refusal emits a `route-conflict` event with the
routes the attach claimed (the server does not say which one is taken):

```ts
const connection = await client.tunnel.connect({
  routes: { api: "127.0.0.1:3000" },
  onRouteConflict: "fail",
})
```

With `onRouteConflict: "fail"`, the first conflict stops the tunnel instead:
`connect` rejects with `code === "route_conflict"`, or, if the conflict happens
on a later re-attach, `closed` does.

A route can also be an object with options:

```ts
await connection.setRoutes({
  web: "127.0.0.1:3000",
  api: { target: "127.0.0.1:4000", proxyProtocol: "v2" },
})
```

`proxyProtocol` (`"v1"` or `"v2"`) writes a PROXY protocol header with the
visitor's address and port, and (v2) the requested hostname, before each
connection's data, then forwards the data unchanged. Enable it only for a
target that expects the header, listening on loopback. Unknown keys and values
are rejected. Routes are not stored; they are the ones you pass to `connect`
and `setRoutes`.

A target receives the decrypted bytes unchanged from a loopback connection, so
it cannot tell a tunneled request from a local one by peer address or `Host`.
The visitor's address is the `peer` field of each `connection-opened` event,
and is delivered to the target only with `proxyProtocol`.
See `docs/trust-boundary.md` in the repository for what a target can trust.

## API

```ts
function create(options?: {
  api?: string | URL // defaults to $OPENTUNNEL_API, then https://opentunnel.xyz
  store?: Storage
  proxy?: string // see "HTTP proxies"
}): Client

interface Client {
  profile: { list(): Promise<string[]> }
  tunnel: {
    list(): Promise<StoredTunnel[]>
    get(options?: { profile?: string }): Promise<Identity | undefined>
    pending(options?): Promise<{ id: string; hostname: string } | undefined>
    create(options?: { profile?: string; onProgress?(stage): void }): Promise<Identity>
    resume(options?): Promise<Identity | undefined>
    ensure(options?: { profile?: string; onProgress?(stage): void }): Promise<Identity>
    remove(options?: { profile?: string }): Promise<void>
    connect(options: {
      profile?: string
      routes: Routes
      signal?: AbortSignal
      onRouteConflict?: "retry" | "fail"
      onEvent?(event: ClientEvent): void
    }): Promise<Connection>
  }
  dispose(): Promise<void>
}

interface Connection {
  tunnel: Identity
  events: AsyncIterable<ClientEvent>
  urls: Record<string, string>
  status(): Status
  setRoutes(routes: Routes): Promise<void>
  closed: Promise<void>
  close(): Promise<void>
}
```

Events are `connecting`, `connected`, `disconnected`, `reconnecting`,
`route-conflict`, `connection-opened`, `connection-closed`,
`certificate-renewed`, and `stopped`.

`onProgress` stages are `creating-tunnel`, `generating-key`, `generating-csr`,
`resuming-certificate`, `requesting-certificate`, `waiting-certificate`,
`saving-identity`, and `ready`. `ensure` reports `checking-certificate` first
when the profile already has a tunnel, then `ready` if its certificate is
current; only a tunnel that needs a certificate reports the stages in between.

## Storage

`create()` stores identities under `$XDG_DATA_HOME/opentunnel/<profile>/`, the
same files the CLI uses. Pass a store to isolate or own persistence:

```ts
import { create, OpenTunnelStorage } from "@opentunnel/client"

const client = create({ store: OpenTunnelStorage.memory() })
```

A memory store loses the tunnel's token when the process exits, and tunnels do
not expire, so a tunnel it created can no longer be deleted. Call
`client.tunnel.remove()` before exiting, or use the default store for tunnels
that should outlive the process.

## Corporate proxies / custom CAs

The SDK uses the runtime's `fetch` and `WebSocket`, so it trusts whatever CAs
the runtime does. Behind a TLS-inspecting proxy, make the runtime trust the
proxy's CA:

- Node: `NODE_EXTRA_CA_CERTS=/path/to/proxy-ca.pem`, or the OS store with
  `--use-system-ca` / `NODE_USE_SYSTEM_CA=1` (Node 22.15+ and 23.8+).
- Bun: `NODE_EXTRA_CA_CERTS=/path/to/proxy-ca.pem`, or the OS store with
  `--use-system-ca` / `NODE_USE_SYSTEM_CA=1`.
- Deno: `DENO_CERT=/path/to/proxy-ca.pem` (or `--cert`), or the OS store with
  `DENO_TLS_CA_STORE=system,mozilla`.

Node and Bun reject certificates they cannot verify (self-signed ones
included); add the CA as above instead. Never set
`NODE_TLS_REJECT_UNAUTHORIZED=0`: it turns off certificate verification for
every connection the process makes, so anyone on the path can read and change
the tunnel's control traffic and take its token.

The Rust client and CLI use the OS store automatically and also read
`OPENTUNNEL_CA_CERT`. Either way this only concerns the connection to
`opentunnel.xyz`; visitor traffic is still decrypted only in your process.

### HTTP proxies

The bridge WebSocket goes through the same proxy as the API calls:
`HTTPS_PROXY` for `wss://` (the default API is `https://`), `HTTP_PROXY` for
`ws://`, then `ALL_PROXY`, each upper case first, and nothing for hosts in
`NO_PROXY` (comma separated: `*`, domains that also cover their subdomains,
with or without a leading `.`, IP addresses or CIDR ranges, each optionally
with `:port`). A proxy URL without a scheme is taken as `http://`, and
credentials go in its userinfo (`http://user:pass@proxy:3128`).

- Bun: its `fetch` reads these variables, its `WebSocket` does not, so the SDK
  resolves the proxy for the bridge itself and passes it to the WebSocket.
  Bun's `fetch` ignores `ALL_PROXY`; the bridge honors it.
- Node: `fetch` and `WebSocket` both ignore these variables unless you run
  with `NODE_USE_ENV_PROXY=1` (Node 22.21+ and 24+) or `--use-env-proxy`
  (22.21+ and 24.5+), which makes both use `HTTPS_PROXY`, `HTTP_PROXY` and
  `NO_PROXY` (not `ALL_PROXY`), so the bridge always follows the API.
- Deno: `fetch` and `WebSocket` both honor them.

Only `http://` and `https://` proxies are supported. A SOCKS proxy (such as
`ALL_PROXY=socks5://…`) stops the tunnel with an error naming the variable
instead of connecting around it; Bun's `fetch` fails on one as well.

To use a proxy regardless of the environment, pass it to `create` (or
`OpenTunnelClient.layer`); it is used for the API and the bridge, and `create`
throws an `OpenTunnelClientError` if it is not an `http://` or `https://` URL:

```ts
const client = create({ proxy: "http://user:pass@proxy.corp:3128" })
```

On Node the `proxy` option needs the [`undici`](https://www.npmjs.com/package/undici)
package (an optional peer dependency, version 7 or later) installed next to the
SDK. Bun's `fetch` still applies `NO_PROXY` to API calls made through it; the
bridge does not.

## Backpressure

The SDK stops reading from a local socket while more than 1 MiB is queued on
the bridge WebSocket, and resets a connection whose local side stops reading
for long enough to buffer 8 MiB. The protocol has no per-connection flow
control yet, so one slow public reader can delay others on the same bridge.
