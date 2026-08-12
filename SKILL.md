---
name: opentunnel
description: Install and use OpenTunnel to expose local apps at public HTTPS subdomains. Use when the user wants to install the opentunnel CLI, create a tunnel, add or remove routes, manage profiles or the background service, inspect local OpenTunnel files, or troubleshoot a tunnel that is not forwarding traffic.
---

# OpenTunnel

OpenTunnel creates end-to-end encrypted public URLs for applications running on
the user's machine. The relay routes connections by TLS hostname, but TLS is
terminated locally so the certificate private key and application plaintext do
not leave the machine.

## Requirements

- Bun 1.3.14 or newer must be installed and available in `PATH`.
- A local application must be listening on a plain TCP `host:port` target. For
  HTTPS public URLs, the target is normally a local plain HTTP server because
  OpenTunnel terminates TLS before forwarding.
- The public URL is reachable by anyone. The tunnel hostname is discoverable in
  Certificate Transparency logs and route names may be guessed. The application
  must provide its own authentication when access should be restricted.

## Install

Prefer Bun:

```bash
bun add -g @opentunnel/cli
opentunnel --help
```

The package can also be installed globally through npm or pnpm, but the
installed CLI still requires Bun:

```bash
npm install -g @opentunnel/cli
pnpm add -g @opentunnel/cli
```

If `opentunnel` is not found after a Bun installation, inspect `bun pm bin -g` and
ensure that directory is in `PATH`.

## Quick start

Start the local application first, then create a tunnel and add a route:

```bash
opentunnel create
opentunnel route add api 127.0.0.1:3000
opentunnel route list
```

If the tunnel hostname is `abc123.opentunnel.xyz`, the route is available at:

```text
https://api.abc123.opentunnel.xyz
```

Test it from another terminal:

```bash
curl https://api.abc123.opentunnel.xyz
```

The initial `create` may wait while the tunnel certificate is issued. Route
additions afterward reuse that certificate and are normally much faster.

## Routes

Each route maps one subdomain label to one local TCP target:

```bash
opentunnel route add api 127.0.0.1:3000
opentunnel route add admin localhost:4000
opentunnel route add opencode localhost:47365
```

Targets must be bare `host:port` values. Never include a protocol:

```text
127.0.0.1:3000          valid
localhost:47365         valid
http://localhost:3000   invalid
```

Route names must use lowercase letters, digits, and internal hyphens. They must
be one DNS label, so names such as `api`, `admin-ui`, and `web2` work while
`foo.bar` does not. The CLI currently saves an invalid name before the server
rejects it; one invalid route can prevent the entire profile from attaching.
Remove the bad name before adding its replacement:

```bash
opentunnel route remove 'Bad.Name'
opentunnel route add good-name localhost:3000
```

Adding an existing route name replaces its target:

```bash
opentunnel route add api 127.0.0.1:8080
```

List or remove routes with:

```bash
opentunnel route list
opentunnel route remove api
```

OpenTunnel routes by hostname, not URL path. It cannot map `/api` and `/admin`
to different targets on the same hostname.

## Profiles

The default profile is named `default`. Each profile owns a separate tunnel
identity, certificate, route table, and background service.

Put `--profile` before the subcommand:

```bash
opentunnel --profile work create --name my-workstation
opentunnel --profile work route add api 127.0.0.1:4000
opentunnel --profile work route list
opentunnel --profile work info
```

Profile names should use lowercase letters, digits, and internal hyphens.
Requested tunnel names are lowercased, must be 3-63 letters, digits, or internal
hyphens, and must be globally available.

Use a new profile when the user needs a separate tunnel hostname or route set.
Do not create another profile merely to add another local application; add
another route to the existing profile instead.

## Service

Normal commands automatically ensure that a per-profile background service is
running. The service holds the bridge connection and forwards public traffic.

```bash
opentunnel service status
opentunnel service start
opentunnel service stop
opentunnel service restart
```

The service is not installed to start automatically after login or reboot.

Adding or removing a route may briefly interrupt existing connections.

Use foreground mode for debugging. Stop the background process first because
only one service can hold a profile lock:

```bash
opentunnel service stop
opentunnel serve
```

There is no `opentunnel connect` command. `opentunnel serve` is the foreground
command; ordinary usage relies on the automatically started background service.

## Inspect state

Show the selected profile's local identity, certificate expiry, and routes:

```bash
opentunnel info
```

These commands display local state rather than remote health:

- `info` reads the locally stored identity.
- `route list` reads the local route configuration.
- `service status` checks whether the local control socket responds.

`info` and `route list` also ensure that the selected profile's service is
running, so they may start or reconnect it. `service status` does not start it.
None of these commands proves that the public URL currently works. Verify the
public URL with `curl` when end-to-end health matters.

## Local files

With default XDG locations, OpenTunnel stores:

```text
~/.config/opentunnel/default.toml
  Route configuration; contains no credentials.

~/.local/share/opentunnel/default/
  Sensitive tunnel identity, token, private key, and certificate files.

~/.local/state/opentunnel/default/daemon.log
  Background service output.
```

For another profile, replace `default` with the profile name. XDG environment
variables override these base directories when set.

Never publish, paste, or commit the data directory. It contains the tunnel
bearer token and private key. The TOML route configuration contains no
credentials and may be managed in a dotfiles repository.

## Troubleshooting

Use this sequence when a route is not reachable. For a non-default profile, add
`--profile <name>` before every subcommand and replace `default` in file paths:

1. Confirm the local application responds directly on its configured port.
2. Run `opentunnel route list` and verify the target is correct.
3. Run `opentunnel service status` and restart the service if it is stopped.
4. Test the full public URL with `curl -v https://<route>.<tunnel-hostname>`.
5. Stop the background service and run `opentunnel serve` to observe errors.

If foreground logs are insufficient, inspect:

```bash
tail -f ~/.local/state/opentunnel/default/daemon.log
```

Common failures:

| Symptom | Likely cause | Action |
|---|---|---|
| `opentunnel: command not found` | Global Bun bin is not in `PATH` | Add the directory from `bun pm bin -g` to `PATH` |
| `Route targets must use host:port` | Target includes a protocol or omits a port | Use `localhost:3000`, not a URL |
| `invalid_route` | At least one saved route is not a valid lowercase DNS label | Remove the bad route, then add it under a valid name |
| `bad_token` | Local identity does not match the server tunnel | Create a new profile/tunnel and re-add the routes |
| `cert_not_ready` | The server does not have a usable certificate for this identity | Stop retrying and inspect the profile and service logs |
| `route_conflict` | Another bridge already claims the same route | Stop the other process or use a different profile/route |
| Connection refused upstream | The local application is stopped or bound elsewhere | Start it and verify the exact target locally |
| Waiting for tunnel and routes | The profile lacks an identity or has no configured routes | Run `create` and add at least one route |

Do not repeatedly run `create` while one provisioning attempt is still in
progress. Initial provisioning is not resumable, and credentials are saved only
after certificate issuance succeeds. A failed named attempt may reserve the
name without leaving a usable local identity, so a retry with that name can
report that the hostname is unavailable.

## Privacy and safety

- The relay sees connection metadata, including the requested TLS hostname, but
  does not hold the tenant certificate private key or application plaintext.
- Tunnel hostnames appear in public Certificate Transparency logs.
- Route names are covered by the wildcard certificate and do not appear in that
  certificate, but common names remain guessable.
- A public URL is not authentication. Protect admin panels, databases, and other
  sensitive services with their own authentication and access controls.
- Removing a route stops forwarding but does not make a previously shared URL
  secret.

## Current user-facing limitations

- Certificate renewal is not implemented. Before expiry, create another profile,
  re-add the routes, and distribute its new URLs.
- Initial certificate provisioning has no complete end-to-end timeout.
- The background service is not registered to start automatically after reboot.
- There is no CLI command to delete a tunnel identity from the server.
- Only one-label subdomain routing is supported; path and nested-subdomain
  routing are not.
