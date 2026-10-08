# @opentunnel/client

## 0.2.2

### Patch Changes

- bbce5b7: The CLI, the SDK, the protocol package, and the Rust crates now always share one version number.
- Updated dependencies [bbce5b7]
  - @opentunnel/protocol@0.2.2

## 0.2.1

### Patch Changes

- cdb8954: Identify the client to the server (`opentunnel/<version>` for the CLI, `opentunnel-sdk/<version>` for the SDK), including on the bridge connection.

## 0.2.0

### Minor Changes

- 1f83dab: Move to Effect `4.0.0-rc.112`. Apps on the current Effect 4 release candidates can now install the SDK without a second copy of Effect, and its source typechecks against theirs. If you use the `effect` entry points, upgrade your own Effect to the same release candidate; the promise API is unchanged.

### Patch Changes

- Updated dependencies [1f83dab]
  - @opentunnel/protocol@0.2.0

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
