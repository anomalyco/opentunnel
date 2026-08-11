# OpenTunnel CLI

The CLI manages one tunnel identity and multiple subdomain routes per profile.
The default profile is named `default`.

## Commands

Create a tunnel and manage its route configuration:

```bash
opentunnel create
opentunnel info
opentunnel route add api 127.0.0.1:3000
opentunnel route add admin 127.0.0.1:4000
opentunnel route list
opentunnel serve
opentunnel service status
opentunnel service restart
opentunnel service stop
opentunnel service start
opentunnel route remove api
```

Commands use the `default` profile unless another profile is selected:

```bash
opentunnel --profile work create --name my-workstation
opentunnel --profile work info
opentunnel --profile work route add api 127.0.0.1:3000
opentunnel --profile work route list
```

Each profile owns one tunnel identity and set of subdomain-to-process routes.
`opentunnel info` reads the selected profile's existing local identity and shows
its tunnel ID, hostname and URL, certificate expiry, and configured route count.
It does not create a tunnel when the profile has no identity.
Path routing is intentionally not supported. Every command ensures a background
service is running for the selected profile. Configuration changes signal that
process to reload and reconnect. `opentunnel serve` is a blocking command that
runs the service in the foreground for supervision and debugging;
`opentunnel service start` starts it in the background.

## XDG Layout

Configuration is declarative, contains no credentials, and is safe to commit to
a dotfiles repository:

```text
$XDG_CONFIG_HOME/opentunnel/
  default.toml
  work.toml
  personal.toml
```

The config filename is the profile name. For example, `work.toml` maps to the
`work` data, state, and runtime locations.

Example configuration:

```toml
[routes]
api = "127.0.0.1:3000"
admin = "127.0.0.1:4000"
```

Generated identity and credentials are stored separately and must not be
committed:

```text
$XDG_DATA_HOME/opentunnel/default/
  tunnel.json
  token
  private-key.pem
  certificate.pem
  chain.pem
```

During certificate verification, `pending.json`, `token`, and
`private-key.pem` are persisted in the profile directory. The background
service resumes that pending CSR if `opentunnel create` is interrupted and
removes `pending.json` after the certificate is ready.

The profile directory must use `0700` permissions. The token and private key
must use `0600` permissions.

Persistent operational state belongs under:

```text
$XDG_STATE_HOME/opentunnel/default/
  daemon.log
  last-error.json
```

Process coordination belongs under:

```text
$XDG_RUNTIME_DIR/opentunnel/
  default.sock
  default.lock
```

When the XDG variables are absent, use the standard defaults:

```text
~/.config/opentunnel/default.toml
~/.local/share/opentunnel/default/
~/.local/state/opentunnel/default/
```

In short:

```text
config  = desired routes and preferences
data    = tunnel identity and credentials
state   = logs and observed runtime state
runtime = current process coordination
```
