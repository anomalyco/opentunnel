# opentunnel

## 0.1.2

### Patch Changes

- d22e6f8: Publish the `opentunnel` and `opentunnel-cli` crates to crates.io with every release, at the same version as npm.

## 0.1.1

### Patch Changes

- 8960fa2: Fix `npm i -g opentunnel` not installing the `opentunnel` command.

## 0.1.0

### Minor Changes

- 54e2493: Rewrite the CLI in Rust and ship it as a native binary; Bun is no longer required. The commands are now `up`, `down`, `status`, `route add|remove|list`, `serve`, and `delete`. `route add api 3000` creates the tunnel on first use and starts the background service, which starts at login where systemd or launchd is available, reconnects with backoff, and picks up renewed certificates without dropping connections. Routes accept a bare port, and `@` routes the tunnel hostname itself. Custom tunnel names are no longer supported.

## 0.0.30

### Patch Changes

- aac6b95: Publish the new Open Tunnel CLI under the transferred npm package.
