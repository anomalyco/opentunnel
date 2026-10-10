# OpenTunnel Protocol

This document is the source of truth for the two client implementations:
the Rust crates in `crates/` and the TypeScript SDK in `packages/client`.
Both are tested against the shared vectors in `spec/vectors`.

## HTTP API

Base URL: `https://opentunnel.xyz`. Authenticated endpoints use
`Authorization: Bearer <token>`. Errors are JSON objects with a `_tag` and a
`message`.

| Method | Path | Auth | Request | Success |
| --- | --- | --- | --- | --- |
| `POST` | `/api/tunnel` | none | `{}` | `201 { "tunnel": TunnelInfo, "token": string }` |
| `GET` | `/api/tunnel/:id` | bearer | | `200 TunnelInfo` |
| `POST` | `/api/tunnel/:id/certificate` | bearer | `{ "csr": string }` | `202 CertificateInfo` |
| `GET` | `/api/tunnel/:id/certificate` | bearer | | `200 CertificateInfo` |
| `DELETE` | `/api/tunnel/:id` | bearer | | `204` |
| `GET` | `/api/tunnel/:id/connect` | in-band | WebSocket upgrade | `101` |

```ts
type TunnelInfo = {
  id: string
  hostname: string            // "<id>.opentunnel.xyz"; id is 12 random base32 characters
  state: "offline" | "online"
  certificateID?: string
}

type CertificateInfo = {
  id: string
  state:
    | { type: "challenge"; token: string; key: string }
    | { type: "issuing" }
    | { type: "ready"; certificate: string; chain: string; expiry: string }
    | { type: "failed"; reason: string }
}
```

## Provisioning

1. `POST /api/tunnel` returns the tunnel and its token. The token is shown once.
2. The client generates a P-256 key locally and a PKCS#10 CSR with
   `CN=<hostname>` and SANs `<hostname>` and `*.<hostname>`, signed with
   ECDSA SHA-256.
3. The client persists the pending identity (id, hostname, token, private key,
   CSR) before calling `POST /api/tunnel/:id/certificate`, so an interrupted
   provision can resume.
4. The client polls `GET /api/tunnel/:id/certificate` every 2 seconds until
   the state is `ready` or `failed`.

## Renewal

The server renews certificates; clients never need to submit a new CSR.

- A renewal reuses the CSR stored at provisioning, so the key never changes
  and the server never sees it.
- The server keeps a renewal alarm per tunnel for 30 days before expiry. When
  it fires, the tunnel is renewed if a client connected in the last 90 days;
  otherwise the certificate is left to expire.
- When a client attaches and the certificate is within 30 days of expiry (or
  already expired), the server starts a renewal immediately.
- During a renewal, `GET /api/tunnel/:id/certificate` keeps returning the
  current certificate. It switches to the new one once issued.
- Clients check `GET /api/tunnel/:id/certificate` when connecting and then
  every 12 hours, or every minute while their certificate is within 30 days of
  expiry. A newer certificate is saved locally and used for new connections
  without disconnecting.

## Bridge

The bridge is one WebSocket per client session, using the `opentunnel`
subprotocol, at `wss://<api host>/api/tunnel/:id/connect`.

### Frames

- Text frames carry JSON control messages.
- Binary frames carry connection data: a big-endian `u32` connection ID
  followed by payload bytes. Payloads should not exceed 32 KiB.

### Control messages

Client to server:

| `type` | Fields |
| --- | --- |
| `attach` | `token`, `transport: "ws"`, `routes: string[]`, `client: { version, max_conns }` |
| `ping` / `pong` | `time_sent` (milliseconds) |
| `end` | `conn` |
| `reset` | `conn`, `code` |

Server to client:

| `type` | Fields |
| --- | --- |
| `attached` | `session`, `routes`, `heartbeat_ms`, `idle_timeout_ms` |
| `attach_error` | `code` |
| `open` | `conn`, `peer`, `sni`, `alpn` |
| `ping` / `pong` | `time_sent` |
| `drain` | `reason` |
| `end` | `conn` |
| `reset` | `conn`, `code` |

Unknown message types and unknown fields must be ignored.

### Versioning

Additive changes (new optional fields, new message types) need no version
change, because clients ignore what they do not understand.

Changes both sides must agree on get a new WebSocket subprotocol name:
`opentunnel` is version 1, and the next would be `opentunnel.v2`. A client
offers every version it supports, newest first (for example
`opentunnel.v2, opentunnel`), and the server selects the newest it supports.
The server keeps accepting older versions so installed clients keep working.

### Session

1. The client opens the WebSocket and sends `attach` within 10 seconds; the
   server closes sessions that do not with `1008`.
2. The server replies `attached` or `attach_error` and closes.
   `bad_token` and `cert_not_ready` are fatal. Other errors, including
   `route_conflict`, may be retried.
3. For each public TCP connection the server sends `open`, then binary frames
   for that `conn`, starting with the TLS ClientHello.
4. The client resolves the route from `sni`, terminates TLS with the tunnel
   certificate, and connects to the route target. If no route matches it
   sends `reset` with `unknown_route`. If it already holds the `max_conns`
   it advertised on attach, it sends `reset` with `too_many_connections`.
5. Either side sends `end` to half-close a connection and `reset` to abort it.
6. The client sends `ping` every `heartbeat_ms` and closes the session when
   nothing is received for `idle_timeout_ms`.

### Routes

A route name is `@` (the tunnel hostname itself) or one DNS label matching
`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`. A connection with SNI `api.<hostname>`
uses route `api`; SNI `<hostname>` uses route `@`. Deeper names never match.

Route targets are `host:port` without a scheme.

### Multiple clients

A tunnel is one hostname per device, shared by every client on it: the CLI's
background service and any number of apps using the SDK. Each client opens
its own bridge with the same token and attaches with the routes it handles.

- The server routes each connection to the bridge that claimed its route.
- A route belongs to one bridge at a time. A bridge that claims a route
  already held by another is rejected with `route_conflict` and retries with
  backoff, so it takes over once the other bridge goes away (for example when
  an app restarts).
- The server treats a bridge it has not heard from for `idle_timeout_ms` plus
  `heartbeat_ms` as gone, even if its socket never closed: it stops routing
  connections to it, resets the connections it had, closes it with `1001`, and
  releases its routes.
- Each client reads the same identity from local storage and terminates TLS
  itself.

### Reconnect

Clients reconnect after a non-fatal close with exponential backoff from 250 ms
to 30 s with jitter, resetting after a successful attach.

### Backpressure

Clients bound the bytes queued on the WebSocket and stop reading from local
sockets until the queue drains. There is no per-connection flow control on
the wire yet, so one slow public reader can delay other connections that
share the bridge.

## Local storage

Both clients read and write the same layout.

```text
$XDG_DATA_HOME/opentunnel/<profile>/    (0700)
  tunnel.json       { "id", "hostname", "certificateExpiry" }
  pending.json      { "id", "hostname", "csr" }    while provisioning
  token             (0600)
  private-key.pem   (0600, PKCS#8)
  certificate.pem
  chain.pem
```

Profile names match `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`.
