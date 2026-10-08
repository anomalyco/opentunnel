# @opentunnel/protocol

## 0.2.2

### Patch Changes

- bbce5b7: The CLI, the SDK, the protocol package, and the Rust crates now always share one version number.

## 0.2.0

### Minor Changes

- 1f83dab: Move to Effect `4.0.0-rc.112`. Apps on the current Effect 4 release candidates can now install the SDK without a second copy of Effect, and its source typechecks against theirs. If you use the `effect` entry points, upgrade your own Effect to the same release candidate; the promise API is unchanged.

## 0.1.0

### Minor Changes

- 54e2493: First public release of the OpenTunnel SDK for Bun. `client.tunnel.connect({ routes })` creates the device's tunnel on first use, terminates TLS in-process, reconnects with backoff, and picks up renewed certificates. Several apps and the CLI can share one tunnel by serving different routes.
  
  Requires Bun 1.4.0 or later.
