# @opentunnel/protocol

## 0.4.1

### Patch Changes

- f532395: Clients now enforce the `max_conns` they advertise on attach: a connection opened beyond it is reset with `too_many_connections` before any TLS state is allocated.

## 0.4.0

### Minor Changes

- 3b4ccd8: Publish compiled JavaScript with type declarations instead of TypeScript sources, so the SDK runs on Node and Deno as well as Bun. The SDK now targets Effect 4.0 stable, and `effect` is a peer dependency (`^4.0.0`): apps that already use Effect share one copy with the SDK, and package managers install it automatically for everyone else.

## 0.3.0

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
