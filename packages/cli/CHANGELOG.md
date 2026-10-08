# opentunnel

## 0.3.0

### Minor Changes

- 7ff6c14: `route add` now takes just the target and gives the route a random 16-character name, so its URL can't be guessed (`opentunnel route add 3000`). Adding the same target again keeps that route. Use `--name api` for a readable name, or `--name @` for the tunnel hostname. The old `route add <name> <target>` form still works and prints a note.

## 0.2.2

### Patch Changes

- bbce5b7: The CLI, the SDK, the protocol package, and the Rust crates now always share one version number.

## 0.1.5

### Patch Changes

- cdb8954: Identify the client to the server (`opentunnel/<version>` for the CLI, `opentunnel-sdk/<version>` for the SDK), including on the bridge connection.

## 0.1.4

### Patch Changes

- dee1174: Publish to Homebrew: `brew install anomalyco/tap/opentunnel`.

## 0.1.3

### Patch Changes

- 7464a51: On macOS, fall back to a plain background process when no one is logged in at the console (for example over SSH), instead of failing to start the launchd service.

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
