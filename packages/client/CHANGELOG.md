# @opentunnel/client

## 0.1.1

### Patch Changes

- 5330c7e: Fix installing the SDK: 0.1.0 was published depending on `@opentunnel/protocol@0.0.0`. Certificate requests are now encoded with WebCrypto, so the SDK no longer depends on `@peculiar/x509` or `reflect-metadata`, and duplicate `@peculiar/asn1-schema` copies in your tree can no longer break tunnel creation.

## 0.1.0

### Minor Changes

- 54e2493: First public release of the OpenTunnel SDK for Bun. `client.tunnel.connect({ routes })` creates the device's tunnel on first use, terminates TLS in-process, reconnects with backoff, and picks up renewed certificates. Several apps and the CLI can share one tunnel by serving different routes.
  
  Requires Bun 1.4.0 or later.

### Patch Changes

- Updated dependencies [54e2493]
  - @opentunnel/protocol@0.1.0
