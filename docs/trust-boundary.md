# What a route target can trust

The local client (the CLI or the SDK) terminates TLS and copies the decrypted
bytes, unchanged, into a new TCP connection to the route's target. It does not
parse or rewrite HTTP. So for every route, the application at the target sees:

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

`peer` is reported by the client, not delivered to the target:

- The SDK includes it in each `connection-opened` event.
- The CLI writes it to the service log (`opentunnel status` shows the path).

It is as trustworthy as the OpenTunnel service and your client. Headers inside
the request are not: they come from the visitor.
