# OpenTunnel Client

> Design draft. This documents the intended public interface before implementation.

`@opentunnel/client` contains all reusable client-side OpenTunnel behavior. The
CLI is a thin wrapper around its Effect interface.

## Exports

The default export is Promise-based and does not require Effect at runtime:

```ts
import { create } from "@opentunnel/client"
```

The Effect interface is available separately:

```ts
import { OpenTunnelClient } from "@opentunnel/client/effect"
```

Both interfaces expose the same capabilities and types.

## Client

```ts
const client = create()

const profiles = await client.profile.list()
```

Proposed shape:

```ts
interface Client {
  readonly profile: {
    list(): Promise<ReadonlyArray<ProfileSummary>>
  }
  readonly route: {
    list(options?: ProfileOptions): Promise<ReadonlyArray<Route>>
    add(options: AddRouteOptions): Promise<Route>
    remove(options: RemoveRouteOptions): Promise<void>
  }
  readonly tunnel: {
    get(options?: ProfileOptions): Promise<TunnelIdentity | undefined>
    status(options?: ProfileOptions): Promise<"online" | "offline" | "pending" | undefined>
    ensure(options?: ProfileOptions): Promise<TunnelIdentity>
    remove(options?: ProfileOptions): Promise<void>
    connect(options?: ConnectOptions): Promise<Connection>
  }
}

interface ProfileOptions {
  readonly profile?: string
}

interface AddRouteOptions extends ProfileOptions {
  readonly name: string
  readonly target: string
}

interface RemoveRouteOptions extends ProfileOptions {
  readonly name: string
}

interface ConnectOptions extends ProfileOptions {
  readonly signal?: AbortSignal
}

interface Route {
  readonly name: string
  readonly hostname: string
  readonly target: string
}

interface TunnelIdentity {
  readonly id: string
  readonly hostname: string
  readonly token: string
  readonly privateKey: string
  readonly certificate: string
  readonly chain: string
  readonly certificateExpiry: Date
}
```

Profile-scoped operations accept an optional `profile`. Omitting it selects the
profile named `default`.

```ts
await client.route.list()
await client.route.list({ profile: "work" })

await client.route.add({
  name: "api",
  target: "127.0.0.1:3000",
})

await client.route.add({
  profile: "work",
  name: "api",
  target: "127.0.0.1:4000",
})
```

There is no profile object and callers do not retain profile handles. The client
resolves storage paths for each operation.

Routes map subdomains to local HTTP processes. Path routing is intentionally not
supported.

`client.tunnel.ensure()` creates a tunnel when the selected profile has no identity,
provisions its certificate, and otherwise returns the existing identity.

### Connection

```ts
interface Connection {
  readonly tunnel: TunnelIdentity
  readonly routes: ReadonlyArray<Route>
  readonly events: AsyncIterable<ClientEvent>
  readonly closed: Promise<void>

  close(): Promise<void>
}
```

`client.tunnel.connect({ profile })` performs the bridge handshake, terminates
TLS locally, and routes incoming connections to configured targets. It resolves
once the initial bridge connection is ready. Automatic reconnect is planned but
not yet implemented.

Promise callers explicitly close the returned connection or use an
`AbortSignal` in `ConnectOptions`.

The Effect version returns a scoped connection. Releasing its scope closes the
bridge, listeners, timers, TLS servers, and active upstream sockets. Its events
are exposed as an Effect `Stream` rather than an `AsyncIterable`.

## Storage

`create()` uses XDG storage by default:

```ts
const client = create()
```

Storage can be replaced when an application wants isolation or owns its own
persistence:

```ts
const client = create({ store: memoryStore() })
const client = create({ store: databaseStore })
```

```ts
interface ClientOptions {
  readonly api?: URL | string
  readonly store?: TunnelStore
}

interface TunnelStore {
  list(): Promise<ReadonlyArray<StoredTunnel>>
  load(profile: string): Promise<TunnelIdentity | undefined>
  save(profile: string, tunnel: TunnelIdentity): Promise<void>
  remove(profile: string): Promise<void>
}
```

Omitting `store` is equivalent to using `xdgStore()`.

The XDG store only manages generated identity and credentials:

```text
$XDG_DATA_HOME/opentunnel/default/
  tunnel.json
  token
  private-key.pem
  certificate.pem
  chain.pem
```

Route configuration is not part of `OpenTunnelStorage`. The CLI owns TOML
configuration, while embedded applications provide routes at runtime.

## Dependency Boundary

```text
@opentunnel/cli
        ↓
@opentunnel/client
        ↓
@opentunnel/protocol
```

The CLI does not implement profile, route, certificate, bridge, TLS, or proxy
behavior. It only maps commands and flags to the Effect client interface and
renders results.
