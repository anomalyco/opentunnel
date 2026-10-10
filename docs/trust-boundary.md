# What a route target can trust

The local client (the CLI or the SDK) terminates TLS and copies the decrypted
bytes, unchanged, into a new TCP connection to the route's target. It does not
parse or rewrite HTTP. Unless a route enables the
[PROXY protocol](#proxy-protocol), the application at the target sees:

- **A loopback peer.** The connection comes from the client process, usually
  `127.0.0.1`, not from the visitor.
- **The visitor's own `Host`.** The request is passed through verbatim,
  including a `Host` the visitor chose. A public request can carry
  `Host: localhost`.
- **No added forwarding headers.** Nothing adds, removes or rewrites
  `Forwarded`, `X-Forwarded-*`, `X-Real-IP`, `CF-Connecting-IP` or
  `True-Client-IP`. Any of these the target receives were sent by the visitor.

A request that arrived through a tunnel therefore cannot be told apart from a
genuinely local one by its peer address, its `Host`, or the absence of
forwarding headers. Do not use any of those to decide that a request is local,
trusted, or allowed to skip authentication:

- Require real authentication on anything you expose through a route.
- If an application has endpoints that should only ever be reached locally,
  serve them on a separate listener that you never route, rather than relying
  on an "is this local?" check.
- Do not let `Host` drive trust decisions, virtual-host routing, cache keys,
  password-reset links or absolute URLs without checking it against the names
  you expect.

Route names are random by default, but a route name is not authentication
either: anyone with the URL can reach the target.

## The visitor's address

The OpenTunnel server sees each visitor's real public address and sends it to
the client as `peer` in the bridge `open` frame ([protocol.md](protocol.md)).
It is the address and port that opened the TCP connection to the server: Fly's
proxy passes it to the server with the PROXY protocol, and it is kept when a
connection is forwarded between regions. If the visitor uses a proxy or VPN,
it is that proxy's address.

`peer` is reported by the client:

- The SDK includes it in each `connection-opened` event.
- The CLI writes it to the service log (`opentunnel status` shows the path).
- A route with the PROXY protocol delivers it to the target (below).

It is as trustworthy as the OpenTunnel service and your client. Headers inside
the request are not: they come from the visitor.

## PROXY protocol

A route can opt in to sending a PROXY protocol header (v1 or v2) to its target
at the start of every connection ([protocol.md](protocol.md#proxy-protocol)):

```bash
opentunnel route add 3000 --proxy-protocol v2
```

The header carries the visitor's address and port from `peer` as the source,
`0.0.0.0` or `::` port 443 as the destination, and (v2 only) the hostname the
visitor asked for in a `PP2_TYPE_AUTHORITY` TLV. When `peer` cannot be parsed
the header says so (`PROXY UNKNOWN`, or v2 `LOCAL`) rather than inventing an
address. The client adds only this header: the request itself, including any
`Forwarded`, `X-Forwarded-*` or `X-Real-IP` headers, still arrives exactly as
the visitor sent it.

- **Enable it only for a target that expects it.** A server that is not
  configured for the PROXY protocol reads the header as the start of the
  request and rejects or misinterprets the connection. One that is configured
  for it rejects connections without a header, so it can no longer be reached
  directly, only through the tunnel.
- **The header is trustworthy only if nothing else can reach the listener.**
  Anyone who can open a TCP connection to a listener that accepts PROXY headers
  can send one with any address. Bind it to loopback (or a private interface),
  and do not expose it some other way. The tunnel client is then the only
  sender, and the address is as trustworthy as `peer`.
- **Configure the target to trust the client's address only**, for example
  `127.0.0.1`, if it can restrict which peers may send PROXY headers.
- **Use the header, not request headers, for the visitor's address.** Since
  the client does not touch the request, visitor-supplied forwarding headers
  remain spoofable; a server behind the PROXY protocol should take the client
  address from the header and ignore `X-Forwarded-For` from this listener.
