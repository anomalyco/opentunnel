# @opentunnel/client

## 0.1.0

### Minor Changes

- 54e2493: First public release of the OpenTunnel SDK for Bun. `client.tunnel.connect({ routes })` creates the device's tunnel on first use, terminates TLS in-process, reconnects with backoff, and picks up renewed certificates. Several apps and the CLI can share one tunnel by serving different routes.
  
  Requires Bun 1.4.0 or later.

### Patch Changes

- Updated dependencies [54e2493]
  - @opentunnel/protocol@0.1.0
