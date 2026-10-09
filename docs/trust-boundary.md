# OpenTunnel Trust Boundary

OpenTunnel gives a local service a public URL. This document states what the route target observes, so an application can decide what to trust. It applies to both clients, which share one bridge protocol.

## What the target receives

The local client owns the certificate private key and terminates TLS (see [Architecture](../README.md#architecture)). It then opens a connection to the route target and forwards the decrypted byte stream unchanged.

For an HTTP application this means:

- The peer is the tunnel client, so `req.socket.remoteAddress` (or the equivalent) is a loopback address, not the visitor.
- The request headers are the ones the public client sent. `Host` is forwarded verbatim — including a value the visitor chose — and no `Forwarded`, `X-Forwarded-For`, `X-Real-IP`, `CF-Connecting-IP`, or `True-Client-IP` is added, removed, or rewritten.
- A visitor can therefore present any authority it likes, such as `Host: localhost`, while connecting through the public URL.

## What a target must not trust

A request that arrived through OpenTunnel cannot be told apart from one made by a process on the same machine by peer address or `Host`. Do not use either as authentication, and do not use a client-supplied `Host` or forwarding header for anything security-relevant: trust decisions, virtual-host routing, cache keys, password-reset links, or absolute URL generation.

The route URL is not authentication either. Route names are random and stay out of public certificate logs, so a URL cannot be guessed, but anyone it is shared with can reach the service.

Anything that must be restricted to the local machine needs a check that does not depend on where the connection came from — a secret the local caller has to present, or a listener the tunnel never forwards to.

## The original peer

The relay passes the address it observed for the inbound connection to the local client: the bridge protocol's `open` message carries it as `peer`, alongside `sni` and `alpn`, taken from `socket.opened` in the Worker. The SDK surfaces it on the `connection-opened` event:

```ts
const client = create()
const connection = await client.tunnel.connect({ routes: { api: "127.0.0.1:3000" } })

for await (const event of connection.events)
  if (event.type === "connection-opened") console.log(event.peer)
```

`peer` is an address without a port. Authentication and rate limiting for public visitors should be built on it — or on a forwarding mechanism the target opts into — rather than on the transport address. What `peer` carries on the current relay deployment, and opt-in forwarding through PROXY protocol or an HTTP-aware client mode, are tracked in [#38](https://github.com/anomalyco/opentunnel/issues/38).
