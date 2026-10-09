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
console.log(`https://api.${connection.tunnel.hostname}`)

for await (const event of connection.events) console.log(event)
```

`connect` creates the profile's tunnel if it has none, resolves once the bridge
first attaches, and reconnects with backoff until you call `close()`. It
rejects on fatal errors such as an invalid token.

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

## Forwarding headers

By default a target sees the tunnel client's loopback address, and the request headers are the visitor's own, `Host` included. Pass `forwardHeaders: true` to add `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` to HTTP/1.x requests before they reach the target:

```ts
await client.tunnel.connect({ routes: { api: "127.0.0.1:3000" }, forwardHeaders: true })
```

The headers replace the visitor's own copies, so a target can read them without knowing how many proxies to skip, and `Host` arrives unchanged with the public authority in `X-Forwarded-Host`. The flag applies to the connection it is passed to and is not stored in the profile.

Use it for HTTP routes only. Anything the SDK cannot recognize as an HTTP/1.x request — a nested TLS session, an SSH banner, a cleartext HTTP/2 preface — is forwarded byte-for-byte, but its opening bytes are buffered until they can be ruled out.

## API

```ts
interface Client {
  profile: { list(): Promise<string[]> }
  tunnel: {
    list(): Promise<StoredTunnel[]>
    get(options?: { profile?: string }): Promise<Identity | undefined>
    pending(options?): Promise<{ id: string; hostname: string } | undefined>
    create(options?: { profile?: string; onProgress?(stage): void }): Promise<Identity>
    resume(options?): Promise<Identity | undefined>
    ensure(options?: { profile?: string }): Promise<Identity>
    remove(options?: { profile?: string }): Promise<void>
    connect(options: { profile?: string; routes: Routes; signal?: AbortSignal }): Promise<Connection>
  }
  dispose(): Promise<void>
}

interface Connection {
  tunnel: Identity
  events: AsyncIterable<ClientEvent>
  status(): Status
  setRoutes(routes: Routes): Promise<void>
  closed: Promise<void>
  close(): Promise<void>
}
```

Events are `connecting`, `connected`, `disconnected`, `reconnecting`,
`connection-opened`, `connection-closed`, and `stopped`.

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

## Backpressure

The SDK stops reading from a local socket while more than 1 MiB is queued on
the bridge WebSocket, and resets a connection whose local side stops reading
for long enough to buffer 8 MiB. The protocol has no per-connection flow
control yet, so one slow public reader can delay others on the same bridge.
