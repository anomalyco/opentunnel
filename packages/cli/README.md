# OpenTunnel CLI

The `opentunnel` CLI manages one tunnel identity and a set of subdomain routes
per profile, and runs a background service that keeps them connected. It is a
native binary written in Rust (`crates/opentunnel-cli`); this npm package is a
small launcher that runs the prebuilt binary for your platform.

```bash
curl -fsSL https://opentunnel.xyz/install | sh
brew install anomalyco/tap/opentunnel
yay -S opentunnel-bin
npm install -g opentunnel
cargo install opentunnel-cli
```

Prebuilt binaries are published for Linux and macOS on x64 and arm64.

## Commands

```bash
opentunnel route add 3000                       # <random>.<hostname> → 127.0.0.1:3000, brings the tunnel up
opentunnel route add 3000 --name api            # api.<hostname> instead of a random name
opentunnel route add 127.0.0.1:8080 --name @    # the hostname itself
opentunnel route add 3000 --proxy-protocol v2   # send a PROXY protocol header (v1 or v2) to the target
opentunnel route remove api
opentunnel route list
opentunnel status                        # tunnel, routes, and connection
opentunnel up                            # connect: create the tunnel if needed, start the service
opentunnel down                          # disconnect: stop the service
opentunnel serve                         # run in the foreground (containers, debugging)
opentunnel delete --yes                  # delete the tunnel for good, losing its hostname
```

Every command takes `--profile <name>` (or `OPENTUNNEL_PROFILE`) and defaults to
the `default` profile. A profile is one tunnel, so one URL per device is the
norm; apps using `@opentunnel/client` add their own routes to the same tunnel.

Adding the same target again (or the same `--name`) with different options
updates that route; for example, `opentunnel route add 3000` after the line
above turns the PROXY protocol off again.

`--proxy-protocol` writes a PROXY protocol header with the visitor's address
and port before each connection's data, and leaves the data unchanged. Use it
only with a target configured to expect the header, listening on loopback; see
`docs/trust-boundary.md` in the repository.

## Background service

`up` (and `route add`) creates the tunnel if needed and starts the background
service. Where systemd (Linux) or launchd (macOS) is available, the service is
registered to start at login as `opentunnel-<profile>.service` or
`xyz.opentunnel.<profile>`; elsewhere, such as in containers, it runs as a
plain background process until the next reboot. `down` stops it and removes
the registration.

The service reconnects with backoff, applies route edits (including hand
edits to the config file) within a few seconds, and picks up certificates the
server renews without dropping connections. Its log is shown by
`opentunnel status`.

## Files

Configuration is declarative, contains no credentials, and is safe to commit to
a dotfiles repository. The filename is the profile name:

```toml
# $XDG_CONFIG_HOME/opentunnel/default.toml
[routes]
api = "127.0.0.1:3000"
"@" = "127.0.0.1:8080"
db = { target = "127.0.0.1:4000", proxy_protocol = "v2" }
```

A route with options is a table with `target`; `proxy_protocol` (`"v1"` or
`"v2"`) is the only option. Routes without options are written as plain
strings. CLIs older than 0.5.0 cannot read the table form.

Generated identity and credentials are stored separately, readable only by
you, and must not be committed. This layout is shared with
`@opentunnel/client`:

```text
$XDG_DATA_HOME/opentunnel/<profile>/
  tunnel.json  token  private-key.pem  certificate.pem  chain.pem
  pending.json        (only while certificate verification is pending)
```

Runtime state:

```text
$XDG_STATE_HOME/opentunnel/<profile>/daemon.log
$XDG_STATE_HOME/opentunnel/<profile>/last-error.json
$XDG_RUNTIME_DIR/opentunnel/<profile>.sock   control socket
$XDG_RUNTIME_DIR/opentunnel/<profile>.lock   single-instance lock
```

Without XDG variables, the defaults are `~/.config`, `~/.local/share`, and
`~/.local/state`.

## Development

From the repository root, `bun run opentunnel -- info` runs the CLI with Cargo.

Releases follow the same pattern as other Anomaly CLIs: CI builds one binary
per platform into `dist/cli-<os>-<arch>/bin/opentunnel`, then:

- `script/publish.ts` publishes each `@opentunnel/cli-<os>-<arch>` package and
  the `opentunnel` launcher with those packages as `optionalDependencies`;
- `script/release.ts` creates the GitHub release with one tarball per platform
  (used by the install script at `packages/website/public/install`), updates
  the formula in `anomalyco/homebrew-tap` (with that repository's deploy key,
  the org-level `HOMEBREW_TAP_KEY` secret), and pushes the `opentunnel-bin`
  AUR package (the org-level `AUR_KEY` secret);
- `script/crates.ts` publishes the `opentunnel` and `opentunnel-cli` crates
  through crates.io trusted publishing.

Steps without credentials are skipped.
