# The OpenTunnel server

`crates/opentunnel-server` is the whole hosted service in one async Rust
binary (Tokio, rustls with `ring`, hyper, MySQL on PlanetScale through sqlx), run as one or more machines per
Fly region against one shared database, linked by a mesh ([Multiple regions](#multiple-regions)). It replaced the Cloudflare
Worker, its Durable Objects, its certificate Workflow, and the TCP relay on
AWS without changing anything clients see: the HTTP API, the bridge protocol
([protocol.md](protocol.md)), hostnames, tokens, and certificates are the same.

## Request flow

```text
visitor ──TLS──▶ :443 ─┬─ SNI <route>.<id>.opentunnel.xyz ─▶ tunnel <id> ─▶ bridge WebSocket ─▶ client (terminates TLS)
                       └─ SNI opentunnel.xyz ─▶ rustls (server certificate) ─▶ HTTP API · bridge upgrade · website
         ──HTTP─▶ :80  ─▶ /health, otherwise 301 to https://opentunnel.xyz
```

1. `relay::accept` reads an optional PROXY protocol header (Fly's
   `proxy_proto` handler supplies the visitor's address) and then TLS records
   until the ClientHello is complete (64 KiB and 10 s limits), without
   consuming anything it cannot replay. The parser only looks at the TLS
   records completed since its last look, so a ClientHello trickling in byte
   by byte costs linear work.
2. SNI equal to the domain: the bytes already read are replayed into rustls,
   which serves HTTP/1.1 and HTTP/2 (ALPN) with the server's own certificate.
3. SNI `<id>.<domain>` or `<route>.<id>.<domain>`: the tunnel picks the bridge
   that claimed the route, sends `open` and the ClientHello as data frames,
   then copies both directions in 32 KiB frames, within the limits in
   [Bridge limits](#bridge-limits): visitor reads wait while the bridge's
   outbound budget is spent, and a visitor that stops reading is reset after
   at most 5 s without ever holding the bridge longer. `end` half-closes,
   `reset` aborts with an RST. A connection with no traffic either way for 15 minutes,
   or for 60 s once either direction has ended (a visitor that closed while the
   target never ends, or the reverse), is reset on both sides, and every socket
   has TCP keepalive, so peers that vanish without a FIN never hold a
   connection. Anything else (unknown tunnel, no bridge, certificate
   not ready, deeper names) is closed, exactly as before.
4. No bridge for the route on this machine: the visitor is forwarded to the
   machine that has one ([Multiple regions](#multiple-regions)), and only if
   no machine has it, closed.

## Bridge limits

What one bridge, tunnel or visitor may cost a machine, so that no tenant and
no visitor can exhaust its memory or take another tenant's bridge down.

| Limit | Value | When exceeded |
| --- | --- | --- |
| Message before `attach` | 64 KiB | close `1009`; the read buffer never grows past it before the token is checked |
| Message after `attach` | 4 + 32 KiB (a data frame with the protocol's largest payload, what both clients send at most) | close `1009` |
| Routes per `attach` | 128 (checked before anything else) | `attach_error` `too_many_routes`; routes are deduplicated in linear time, and the token is checked before they are validated |
| Routes per tunnel on a machine | 256, over all its bridges | `attach_error` `too_many_routes` |
| Connections per bridge | the `max_conns` the client advertised, at most `MAX_CONNS_PER_BRIDGE` (256, what both clients advertise) | the visitor is closed before the client hears of it; `opentunnel_visitor_connections_total{outcome="rejected_too_many_connections"}` |
| Connections per tunnel on a machine | `MAX_CONNS_PER_TUNNEL` (1024), over all its bridges | as above |
| Client data waiting for one visitor | 512 KiB | the bridge reader waits (below) |
| Client data waiting for one bridge's visitors | 4 MiB | the bridge reader waits |
| Visitor data waiting for one bridge's socket | 1 MiB | visitor reads wait |
| Connection data held by the machine, both directions | `BUFFERED_BYTES_LIMIT` (256 MiB) | the bridge reader or visitor reads wait |

Data from a client is queued for its visitor without waiting until a budget
is spent. Then the bridge reader stops reading (TCP backpressure on the
client, as before, so a fast client and a slow visitor still work) and waits
for visitors to take data, but never longer than 5 s for one frame: then it
resets (`reset` with `client_io_error`) every connection of that bridge whose
visitor took nothing in those 5 s (less than 64 KiB acknowledged, read from the
socket's send queue), and the one it waited for if its data still does not
fit. Stalled visitors are thus reset together after one wait, whatever their
number. Visitor sockets keep at most 128 KiB unsent in the kernel
(`TCP_NOTSENT_LOWAT`): a stalled visitor holds little kernel memory, and
writes complete as a slow visitor reads instead of only once half of a
multi-megabyte send buffer is free. A visitor reading slower than about
6 KiB/s while it lags behind its budget is reset.

The bound on the wait matters beyond the bridge's visitors: a client whose
bridge the server stops reading fills its own send queue with uploads, and
released clients (before the changeset `bridge-read-loop`) then stop reading
the bridge too, since their read loop waits to queue a ping or a pong; the
server's 30 s write timeout then closed the bridge and every connection on
it. Before, one visitor that uploaded and never read its answers did this in
about 30 s, again and again. While the reader waits, a client that has heard
nothing from the server for 15 s gets a `ping`. Waits and resets are counted
in `opentunnel_bridge_backpressure_total`. What remains without
per-connection flow control on the wire: a visitor reading slowly while it
lags behind its budget slows the bridge to its pace, at most 5 s per frame.

## Where each Worker feature went

| Worker | Server |
| --- | --- |
| `fetch` routing in `index.ts`, Effect `HttpApi` handlers | `http.rs`: same paths, methods, status codes, JSON bodies and key order, the 415/400 payload behaviour, `/health`, `/openapi.json` (captured from the Worker) |
| `connect(socket)` and `/api/relay` (AWS relay) | `relay.rs` on :443 directly; the AWS relay is no longer needed |
| `tls-client-hello.ts` | `sni.rs` (a line-for-line port, with fuzz-style tests) |
| `TunnelObject` record, token hash, `info`/`certificate`/`bindCertificate`/`remove` | `service.rs`; records keep the Durable Object's `StoredTunnel` JSON shape (`record.rs`) |
| Hibernating bridge WebSockets and attachments | `bridge.rs` sessions; per-tunnel state in `service.rs` (`Entry`) |
| Stale bridge retirement on attach and connect | Same rule (`idle_timeout_ms + heartbeat_ms`), plus a sweep every heartbeat |
| Durable Object alarm (renewal) | `alarm_at` per tunnel in MySQL, fired by `jobs::run_alarms`; same `alarm`, `scheduleRenewal`, `onAttached` logic |
| `CertificateWorkflow` (ZeroSSL, EAB, DNS-01, retries, `describeError`) | `acme.rs` + `dns.rs` + durable, leased `jobs` rows resumed after restarts; transient failures retried for a day, others three times (see below) |
| Workflow instance named after the certificate ID | Job keyed by certificate ID (`ensure_issuance` adds it only if missing) |
| Cloudflare-managed certificate for `opentunnel.xyz` | A Cloudflare Origin CA certificate (`TLS_CERT_FILE`/`TLS_KEY_FILE`, from the `ORIGIN_*_PEM` secrets): the domain is on the Public Suffix List, so no public CA issues for it, and Cloudflare proxies it. Without those settings (development, other domains) `jobs::ServerCertificates` issues one through the configured issuer, renewed 30 days before expiry, hot-swapped |
| Worker export | The same file format for backups: `opentunnel-server export`/`import`, `POST /api/admin/{export,import}`; imports take only records the server could have written itself (see [Limits](#limits)) |
| Static assets | `website.rs`: `dist/website` in memory, Cloudflare's HTML handling (`/index.html` → `/`), ETags |
| Pipelines `EVENTS` binding | `analytics.rs`: identical event envelopes and payloads, posted in batches to `ANALYTICS_URL` |

The move (October 2026) imported the Worker's records, then pointed visitors
and then the API domain at Fly while the server relayed tunnels it did not
know yet to the Worker and imported them on first use; once no client was
left on the Worker, the Worker, its Durable Objects, the AWS relay, that
fallback and the migration tooling were deleted.

Two things changed by necessity: analytics no longer carry `country` and
`colo` (they came from Cloudflare's request metadata), and a tunnel's `state`
in the API is computed from live bridges, so it is never stale after a
restart. The stored record's `state` is only informational: an attach sets it
`online` together with `lastConnectedAt` (written at most hourly per tunnel),
and closing bridges leave it as it is, so reconnecting clients do not rewrite
their record.

## Storage

MySQL 8, in production the PlanetScale database `opentunnel` (org
`anomalyco`, AWS us-east-1, next to Fly's `iad`), reached through
`DATABASE_URL` with TLS (`sqlx`, rustls with `ring`, Mozilla's roots). Tables
(`store.rs`, all `utf8mb4` with binary collation, so IDs stay case-sensitive):

- `tunnels`: `id`, `record` (the `StoredTunnel` JSON exactly as serialized:
  token hash, hostname, certificate state, CSR and identifiers,
  `lastConnectedAt`, `renewal`, `deletedAt`, ...; `LONGTEXT` because MySQL's
  `JSON` type would reorder keys), `revision`, `deleted` and `issuing`
  (derived from the record for queries), `alarm_at`, and
  `local_update`, which is 0 while a row is exactly as imported so a later
  import may refresh it. Databases created before October 2026 also have an
  unused, nullable `region` column (reserved once, never written); drop it
  with a PlanetScale deploy request when convenient.
- `jobs`: issuance jobs (`issue`, `renew`, `server`) with a status
  (`pending`, `done`, `failed`, `abandoned`), attempts, the next run time, and
  a lease (`lease_owner`, `lease_until`).
- `server_certificates`: the domain's key, CSR, certificate and expiry.
- `meta`: the API certificate's current job and the local test CA when
  `ISSUER=local` (servers before the mesh also kept `machine:<id>` rows here).
- `rate_limits`: one row per limited key (`create:<client address>`,
  `issue:<tunnel>`) with the time its budget is full again ([Limits](#limits));
  rows in the past are pruned every 5 minutes. Added without a schema version:
  a database at schema 2 gets it at startup when it is missing (`CREATE TABLE
  IF NOT EXISTS`, no DDL once it exists), so servers of the previous version,
  which refuse a newer schema, still start against it (a rollback).
- `bridges`, the bridge registry of servers before the mesh (schema 2), is
  dropped at startup when it exists (`DROP TABLE IF EXISTS`, no DDL once it is
  gone), likewise without a schema version: no running version reads it. If
  PlanetScale refuses direct DDL (safe migrations), the server logs `could not
  drop the unused bridges table` and carries on; drop it with a deploy request.
- `schema_migrations`: the schema version.

The schema keeps to what Vitess allows: a primary key on every table, no
foreign keys, triggers or stored procedures. On startup the server creates
missing tables with `CREATE TABLE IF NOT EXISTS` and records the version; once
the database is at its version it runs no DDL at all (so PlanetScale's safe
migrations may be turned on afterwards; later schema changes then go through a
deploy request). A database at a newer version is refused, so a version bump
also stops the previous version from starting (a rollback, or one of its
machines restarting during a blue-green deploy): tables it does not depend on
are added and dropped without one, as above.

Nothing assumes a single writer, so two servers on one database stay correct:

- Every tunnel write names the `revision` it read (`UPDATE ... WHERE revision
  = ?`). If an import or another server changed the row meanwhile, the write
  fails, the cached record is dropped and reloaded on next use, and the
  request answers 503 so the client retries. Within one process, writes to a
  tunnel are still serialized by its entry lock.
- Imports insert first and otherwise lock the existing row
  (`SELECT ... FOR UPDATE`) to compare it, retrying on deadlocks.
- A due alarm is cleared with `UPDATE ... WHERE alarm_at = <the value read>`,
  so it fires once.
- Jobs are claimed with a conditional update that sets a two-minute lease,
  extended every 40 s while the ACME order runs; results are recorded only by
  the lease holder (checked again right before recording). An expired lease (a
  crashed server) is taken over. The owner is `FLY_MACHINE_ID`, so a restarted
  machine takes its own jobs back at once; a clean shutdown also releases
  them. `tests/cluster.rs` runs 30 jobs on two servers and checks each ran
  once.
- Orphaned-issuance reconcile runs on every machine; it only adds jobs keyed
  by certificate ID (insert-if-absent), so concurrent runs add each once.
- Failed attempts are classified (`retry.rs`). Transient ones (timeouts,
  resets, 5xx, 429 with `Retry-After`, bodies that are not JSON, no nonce,
  `badNonce`, an authorization still pending) are retried with exponential
  backoff and jitter (from `ISSUANCE_RETRY_DELAY_MS`, at most an hour apart)
  until a day after the job was queued; permanent ones (`rejectedIdentifier`,
  `badCSR`, missing configuration, ...) fail at once; anything else gets three
  attempts. The tunnel shows `issuing`/`challenge` until the job ends, so
  clients keep polling. Within an attempt, nonce requests and POST-as-GET reads
  are repeated a few times, valid authorizations and already finalized orders
  of a reused order are skipped, and a challenge record that already exists in
  Cloudflare is used and deleted like a created one.
- The CA hands a pending authorization to every new order for its identifier.
  ZeroSSL's validation sometimes never finishes (the challenge stays
  `processing`), and such an authorization came back to every attempt for a
  day. So an attempt answers challenges only after the records propagated,
  polls the authorizations for up to 60 intervals, and deactivates (RFC 8555
  §7.5.2) any still pending at its end, whatever the error; an order that
  arrives with a challenge already in progress or a failed authorization is
  abandoned for a fresh one (after deactivating the stuck ones). Challenge
  records, one name shared by a hostname and its wildcard, are deleted only
  once every answered authorization is valid, invalid or deactivated; if a
  deactivation fails they are left in place. A failed validation's error
  (`ACME authorization for <name> ended in invalid: <type>: <detail>`) is
  logged and recorded; it gets three attempts.
- A job whose tunnel was deleted or bound another certificate ends as
  `abandoned` (checked before each attempt and after a failed one), which
  does not count as a failure.
- The reconcile also queues again (a compare-and-set from `failed` to
  `pending`) first issuance that gave up early on a transient error, when the
  tunnel is not deleted and still shows that certificate as failed; it shows
  `issuing` again. The requeued job starts a new retry window, so it is
  requeued at most once. First issuance queued before the deactivation fix
  (`AUTHZ_PENDING_FIX_MS`) whose last attempt ended on a pending authorization,
  failed or still retrying, is likewise queued once more with a fresh window
  (a job a server is running is left alone).
- The domain's key is created insert-if-absent and its job is requested with a
  compare-and-set on `meta`.

When the database is unavailable the server keeps running: the pool
(`DATABASE_POOL_SIZE` connections, 50 by default, 8 kept open while idle and
topped up in the background every 10 s, no check before use, idle ones closed
after a minute and all recycled after 30 minutes) reconnects on its own, every
statement gives up after 10 s (an attach's read after 4 s), and API calls that need storage answer 503
(`{"_tag":"ServiceUnavailableError","message":"storage unavailable"}`). Tunnels
with an attached bridge keep their record in memory, so visitor traffic and
token checks for them never touch the database; a bridge that attaches during
an outage is accepted from a cached record.

Opening a connection may take up to 20 s (`CONNECT_TIMEOUT` in `store.rs`):
TCP and TLS to PlanetScale's nearest edge, then the MySQL handshake, which the
edge relays to us-east-1, several round trips from far regions (`jnb`
logged 2.6 s acquires). sqlx bounds a new connection by the pool's
acquire timeout, so that timeout is 20 s too; statements stay bounded by their
own limits above. Until 2026-10-16 the acquire timeout was 3 s, which aborted
every connection that took longer: machines in `gru` that hit slow connects
logged `pool timed out while waiting for an open connection` at startup
forever and never served. Idle connections are opened in the background
(`opened idle database connections`, with the time it took, or the error).

At startup the server listens on nothing until the database answers: it
connects once outside the pool (logging `connected to the database` with
`connect_ms`, or the real error, followed by `database probe:` lines with the
time to resolve the host and a TCP connect to each address) and migrates,
retrying with backoff up to 15 s apart. So a machine without the
database fails its health checks and Fly sends its traffic and clients to
other machines. If the database is still unreachable after
`STARTUP_DB_TIMEOUT_MS` (2 minutes), it logs `the database is not available,
exiting` with the last error and exits with status 1; `fly.toml`'s
`[[restart]]` policy (`on-failure`, 10 retries) restarts it (for a machine whose host
has lost its path to PlanetScale while every other region reaches it, as `gru`
on 2026-10-16). Each attempt takes the full 2 minutes, so a
crash-looping machine costs little; after the retries Fly leaves it stopped
(`fly machine start`, or clone it to another host with `fly machine clone`).
Only startup gives up: a running machine never exits over the database, so a
whole-database outage does not restart machines that were already serving.
During a deploy in such an outage the new machines never pass their checks,
the deploy fails, and the old machines keep serving.

Back it up with `opentunnel-server export <file>` (or
`POST /api/admin/export`); `opentunnel-server import <file>` writes an export
into the database at `DATABASE_URL`, refusing (and listing under `rejected`)
any record that is not exactly what the server writes: a tunnel ID that is one
DNS label, the hostname `<id>.<domain>`, a SHA-256 token hash, and a CSR and
identifiers only for the tunnel's own hostname and its wildcard.
PlanetScale's own backups also cover it. The export reads the table 500
tunnels at a time, keyset by ID (the whole table in one result passed
PlanetScale's 64 MiB limit at ~17,000 tunnels), and writes each page as it is
read: the admin endpoint streams the response (chunked), so it starts at once
and Cloudflare's 100 s wait for a response does not apply. The file is the same
JSON as ever (one record per line inside `records`); pages are not one
snapshot, so a record changed during the export is as it was when its page was
read. A failure midway cuts the response short (`curl` reports a transfer
error, and the file is not valid JSON) rather than ending it cleanly.

```bash
curl -sf -X POST https://opentunnel.xyz/api/admin/export -H "authorization: Bearer $ADMIN_TOKEN" -o export.json
jq '.records | length' export.json   # ≈ tunnels + deleted in /api/admin/stats; the file holds token hashes, keep it private
```

## Configuration

Every flag also reads an environment variable (`opentunnel-server --help`).

| Variable | Default | |
| --- | --- | --- |
| `OPENTUNNEL_DOMAIN` | `opentunnel.xyz` | API domain; tunnels are `<id>.<domain>` |
| `TLS_LISTEN` / `HTTP_LISTEN` | `0.0.0.0:8443` / `0.0.0.0:8080` (`[::]` in the image) | `HTTP_LISTEN=off` disables HTTP |
| `HTTP_MODE` | `redirect` | `serve` runs the whole app on plain HTTP (development, tests) |
| `PROXY_PROTOCOL` | `false` | require a PROXY v1/v2 header on :443 (`true` on Fly) |
| `DATABASE_URL` | | secret: `mysql://user:password@host/opentunnel?ssl-mode=VERIFY_IDENTITY` (PlanetScale's "MySQL" connection string). TLS with certificate checks is the default and is required unless the host is loopback |
| `STARTUP_DB_TIMEOUT_MS` | `120000` | at startup, exit with status 1 if the database is still unreachable after this long (Fly restarts the machine); 0 waits forever |
| `WEBSITE_DIR` | `/app/website` | |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | | serve this certificate for the domain instead of issuing one |
| `ISSUER` | `acme` | `local` is an insecure built-in CA for development and tests |
| `LOCAL_CA_FILE` | | with `ISSUER=local`, write the CA certificate here for clients to trust |
| `ACME_URL` | ZeroSSL DV90 | |
| `ACME_EMAIL` | `acme@opentunnel.xyz` | |
| `ACME_EAB_KID`, `ACME_EAB_HMAC_KEY` | | secrets: ZeroSSL external account binding |
| `ACME_ACCOUNT_KEY_JWK` | | secret: the account's P-256 private JWK (`opentunnel-server account-key` makes one) |
| `ACME_CA_BUNDLE` | | extra roots for the ACME server (Pebble) |
| `ACME_DNS_PROPAGATION_TIMEOUT_MS` | `10000` | wait for public resolvers to see the TXT records; 0 skips |
| `DNS_PROVIDER` | `cloudflare` | `cloudflare`, `exec` (a hook executable, [Self-hosting](#self-hosting)) or `challtestsrv` (Pebble's test DNS) |
| `DNS_HOOK` | | with `DNS_PROVIDER=exec`, the executable that creates and deletes challenge records (required) |
| `CLOUDFLARE_ZONE_ID` | the opentunnel.xyz zone | |
| `CLOUDFLARE_API_TOKEN` | | secret: DNS edit on the zone, only for DNS-01 |
| `ISSUANCE_CONCURRENCY` | `4` | ACME orders at once per machine; one of them is kept for renewals |
| `CREATE_RATE_PER_HOUR` / `CREATE_RATE_BURST` | `30` / `10` | tunnels one client address (IPv6: its /64) may create, cluster-wide: this many an hour on average, the burst at once; `0` disables ([Limits](#limits)) |
| `ISSUANCE_RATE_PER_DAY` / `ISSUANCE_RATE_BURST` | `5` / `5` | new certificates (a bind with a new CSR) one tunnel may request a day on average, and at once; `0` disables |
| `ISSUANCE_BACKLOG_LIMIT` | `200` | while more certificate jobs are pending, creating tunnels and new certificates answer 503; `0` disables |
| `TRUSTED_PROXY_RANGES` | Cloudflare's ranges | CIDRs (comma-separated) whose `CF-Connecting-IP` names the client; `off` trusts none |
| `ANALYTICS_URL`, `ANALYTICS_TOKEN` | | the platform event stream's HTTP endpoint and bearer token; analytics are off without the URL |
| `ADMIN_TOKEN` | | secret: enables `POST /api/admin/{import,export,stats}` |
| `INTERNAL_LISTEN` | `off` | the internal listener for other machines: mesh links, forwarded visitors, route checks (`[::]:9000` on Fly, bound to `FLY_PRIVATE_IP`); `off` runs a single machine without the mesh |
| `INTERNAL_TOKEN` | | secret shared by all machines, required with `INTERNAL_LISTEN`; never sent, only proven ([Multiple regions](#multiple-regions)) |
| `INTERNAL_ADDRESS` | `[FLY_PRIVATE_IP]:<port>` | where other machines reach this one |
| `FLY_MACHINE_ID`, `FLY_REGION`, `FLY_PRIVATE_IP`, `FLY_APP_NAME` | random, `local`, , | set by Fly: the machine's ID in the mesh (also the job lease owner), region, 6PN address, and app (for `MESH_DNS`) |
| `MESH_DNS` | `<FLY_APP_NAME>.internal` | a name whose AAAA/A records are the other machines, at this machine's internal port; `off` disables it |
| `MESH_PEERS` | | static peer addresses (`host:port`, comma-separated), in addition to `MESH_DNS` |
| `MESH_DISCOVERY_MS` | `5000` | how often `MESH_DNS` is resolved again |
| `MESH_PING_MS` / `MESH_DEAD_MS` | `1000` / `5000` | an idle link pings this often; a peer silent this long is down |
| `CONNECTION_IDLE_TIMEOUT_MS` | `900000` | a tunnel connection with no traffic either way for this long is reset |
| `HALF_CLOSE_TIMEOUT_MS` | `60000` | once either direction of a tunnel connection has ended, the other is reset after this long without traffic |
| `MAX_CONNS_PER_BRIDGE` | `256` | public connections one bridge carries at once; a client advertising a lower `max_conns` gets that ([Bridge limits](#bridge-limits)) |
| `MAX_CONNS_PER_TUNNEL` | `1024` | public connections one tunnel carries at once on a machine, over all its bridges |
| `BUFFERED_BYTES_LIMIT` | `268435456` | bytes of connection data a machine holds in memory at once (256 MiB), on top of each bridge's and connection's budget |
| `METRICS_LISTEN` | `off` | Prometheus metrics at `/metrics` (`[::]:9091` on Fly: every interface, as Fly's scraper does not reach the 6PN address; unauthenticated, not in `[[services]]`); see [Observability](#observability) |
| `SHUTDOWN_DRAIN_MS` | `10000` | after SIGTERM, how long the server keeps accepting and serving while bridges move elsewhere |
| `LOG_FORMAT` | `text` | `json` writes one JSON object per line (`json` on Fly) |
| `MESH_VERIFY_ADDRESS` | `true` | a peer's mesh address must be where its connection comes from and, on Fly, what `<machine>.vm.<app>.internal` resolves to ([Multiple regions](#multiple-regions)) |

Set secrets with `fly secrets set NAME=value ... -a opentunnel`.

## Self-hosting

Tunnels get wildcard certificates, which ACME only issues through DNS-01 challenges, so the server needs to
create TXT records in your domain's zone. With DNS on Cloudflare, set `CLOUDFLARE_ZONE_ID` and
`CLOUDFLARE_API_TOKEN`. For any other DNS host, set `DNS_PROVIDER=exec` and `DNS_HOOK` to an executable the
server runs (directly, no shell) as:

```
<hook> create <name> <value>
<hook> delete <name> <value>
```

`name` is the full record name, `_acme-challenge.<host>` without a trailing dot, and `value` the TXT content.
A hostname and its wildcard share one name, so a name can hold two values at once: `create` adds its value
next to any others and `delete` removes only its own. Exit 0 on success; on a non-zero exit the error includes
the status and the end of stderr. Both must be idempotent, like certbot and lego hooks: `create` succeeds if
the value is already there, `delete` if it is already gone. A hook is killed after 60 seconds. A failed `delete` is logged and not retried, and records are
not swept as on Cloudflare. After creating the records the server waits up to
`ACME_DNS_PROPAGATION_TIMEOUT_MS` for public resolvers to see them; raise it for slow DNS hosts.

For example, Route 53 (with the AWS CLI and `jq`, and `ZONE_ID` set to the hosted zone), which keeps all of a
name's values in one record set:

```sh
#!/bin/sh
set -eu
action=$1 name=$2 value="\"$3\""
current=$(aws route53 list-resource-record-sets --hosted-zone-id "$ZONE_ID" \
  --start-record-name "$name" --start-record-type TXT --max-items 1 --output json |
  jq -c --arg name "$name." '[.ResourceRecordSets[] | select(.Name == $name and .Type == "TXT") | .ResourceRecords[].Value]')
case "$action" in
  create) next=$(echo "$current" | jq -c --arg v "$value" '. + [$v] | unique') ;;
  delete) next=$(echo "$current" | jq -c --arg v "$value" '. - [$v]') ;;
  *) exit 2 ;;
esac
[ "$next" = "$current" ] && exit 0
if [ "$next" = "[]" ]; then change=DELETE values=$current; else change=UPSERT values=$next; fi
aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" --change-batch "$(jq -cn \
  --arg change "$change" --arg name "$name" --argjson values "$values" \
  '{Changes: [{Action: $change, ResourceRecordSet: {Name: $name, Type: "TXT", TTL: 60,
    ResourceRecords: [$values[] | {Value: .}]}}]}')" >/dev/null
```

## Operations

- `fly logs -a opentunnel`; `RUST_LOG=opentunnel_server=debug` for per-connection detail. Metrics and
  JSON logs: [Observability](#observability).
- `POST /api/admin/stats` (bearer `ADMIN_TOKEN`) returns tunnel, alarm, job,
  and attached-bridge counts. The top-level connection and
  bridge counts are the answering machine's; `machine` has its ID, region and
  forwarding counters (`forwarded_out`, `forwarded_in`, `forward_failures`)
  and live Tokio tasks and open file descriptors (`tasks`, `fds`, which should
  follow open connections and bridges, not grow over time), and `cluster` the
  answering machine's mesh view: bridges in total and per region, every
  machine it is linked to (itself as `link: "self"`) with its bridges, tunnels,
  routes, epoch, sequence number and whether it is draining, the state of every
  peer address (`peers`: `up`, `connecting`, `unreachable`), and
  `complete` (every peer linked). The request lands on the machine nearest the
  caller's Cloudflare colo; every machine should show the same machines and
  bridge counts.
- At startup the open file soft limit is raised to the hard limit (logged as
  `open file limit`); when it is reached anyway, accept loops pause 500 ms
  between attempts and log at most every 10 s.
- Deploys are blue-green (`fly.toml`): a new machine starts next to each old
  one; once all are healthy, Fly cordons the old machines (the proxy stops
  sending them new connections), waits 10 s and stops them. On SIGTERM (or
  SIGINT) a machine announces `leaving` on the mesh (peers drop its bridges
  and stop forwarding visitors to it), sends every bridge `drain` and
  closes it with 1012 (clients reconnect with backoff, to the new machines),
  and does the same at once to any bridge that arrives later. Many bridges
  are told over up to 5 s, 5,000 a second, so the machines they move to see
  a stream they can attach rather than all of them within the clients' first
  retry (a quarter of a second). For
  `SHUTDOWN_DRAIN_MS` (10 s) it keeps accepting connections and answering the
  API, since the proxy may still route new connections to it (a host migration
  stops a machine without cordoning it); HTTP/1.1 responses then carry
  `Connection: close` and idle connections are closed, so Cloudflare moves its
  pooled connections elsewhere. Then it stops listening, gives open requests
  up to 10 s, releases its jobs and exits (`kill_timeout` is 30 s). Closing
  the listener at once instead fails connections the proxy still sends, which
  Cloudflare reports as 525. Issuance jobs resume where they stopped, on any
  machine.
- The domain certificate is requested on first start and checked hourly;
  until it exists, TLS to the domain fails while tunnel traffic works.

## Limits

Creating a tunnel needs no account, and each new certificate is an ACME order
on the one shared ZeroSSL account plus DNS writes in the Cloudflare zone, so
the server limits what any one client can make it do. All limits are
cluster-wide: rates live in the `rate_limits` table, one conditional `UPDATE`
per request (an `INSERT` for a key not seen before), so every machine counts
against the same budget.

- **Tunnels per client address**: 30 an hour on average, 10 at once
  (`CREATE_RATE_PER_HOUR`, `CREATE_RATE_BURST`), counted per IPv4 address and
  per IPv6 /64. Over it, `POST /api/tunnel` answers 429 with `Retry-After` and
  `{"_tag":"RateLimitedError","message":"Too many tunnels created from this
  address; try again in N minutes"}`.
- **New certificates per tunnel**: 5 a day on average, 5 at once
  (`ISSUANCE_RATE_PER_DAY`, `ISSUANCE_RATE_BURST`). Only a bind with a CSR the
  tunnel does not have counts; binding its current CSR again (a resumed
  provision) answers as before, and renewals and requeued jobs are the
  server's own. Over it, the bind answers 429 the same way.
- **Only a tunnel's own names**: right before every ACME order, the job
  runner checks that a tunnel's job asks for exactly `<id>.<domain>` (and
  optionally `*.<id>.<domain>`) of that tunnel, with a CSR whose common name
  is the hostname and whose names are exactly those, and that a server job
  asks only for the API domain. Anything else (the apex or its wildcard,
  another tunnel's names, a CSR for other names; for example from a tampered
  record) is refused without contacting the CA (`acme_attempts{outcome="refused"}`,
  an `error` log, the tunnel's certificate `failed`). Imports are checked the
  same way.
- **CA cool-down**: five failed attempts in a row that point at the CA
  (network errors, timeouts, 5xx, unreadable answers, nonce trouble), or one
  rate limit, pause new issuance on every machine: for a minute, then twice
  as long each time it happens again before an attempt succeeds, up to an
  hour, and at least as long as a rate limit's `Retry-After`. The state is
  shared in `meta` (`ca_cooldown`) and read at most every 15 s. While it
  lasts no first issuance starts, and one renewal at a time does, which also
  finds out whether the CA works again (a success ends the cool-down).
  `opentunnel_acme_cooldowns_total` counts them; the log says "the CA keeps
  failing; pausing new certificate issuance".
- **Challenge records**: each attempt creates at most two TXT records (the
  hostname and its wildcard share `_acme-challenge.<id>.<domain>`), a tunnel
  has at most one first issuance at a time (and a renewal that a new bind
  abandons), and new certificates per tunnel and the backlog are limited as
  above, so records in the zone are bounded by the attempts running.
- **Challenge record cleanup**: an attempt deletes its records when it ends
  (deletes that Cloudflare rate limits or fails with 5xx are retried; one
  already gone counts as deleted), unless an authorization it answered could
  not be deactivated, when the CA might still check them. At shutdown every
  attempt in progress is ended and cleans up first (the job is resumed
  elsewhere): until October 2026 a machine stopped by a deploy (or a failed
  blue-green deploy deleting green machines that had started) exited
  mid-attempt and left its records, ~1,300 of them, mostly from deploys and
  their retries. Every 10 minutes one machine (a lease in `meta`,
  `dns_sweeper`) lists `_acme-challenge.*` TXT records and deletes, at most
  1,000 at 4 a second, those older than an hour under the domain whose value
  is a challenge value, except names of jobs some machine is running.
  `opentunnel_acme_dns_records_total{event}` counts `created`, `deleted`,
  `delete_failed` and `swept`.

- **Backlog**: while more than 200 certificate jobs are pending in the whole
  database (`ISSUANCE_BACKLOG_LIMIT`; the count is read at most every 5 s per
  machine, and when it cannot be read nothing is refused), creating tunnels
  and binding new CSRs answer 503 (`ServiceUnavailableError`, `certificate
  issuance is busy; try again later`) with `Retry-After: 30`, instead of
  queueing without bound.
- **Renewals first**: the job runner takes due renewals (and the domain's own
  certificate) before due first issuance, and first issuance never takes the
  last of a machine's `ISSUANCE_CONCURRENCY` slots, so a flood of new
  certificates cannot hold up renewals.

Rates use GCRA: each key stores when its budget is full again, a request
passes while that is at most `(burst - 1) × interval` ahead and pushes it one
`interval` (an hour / 30, a day / 5) further. Both clients retry 429 and 503
a few times, waiting `Retry-After` up to 8 s, then report the message
([protocol.md](protocol.md#retries-and-errors)).

**The client address.** `opentunnel.xyz` is proxied by Cloudflare, so the
PROXY header's source of an API connection is a Cloudflare edge. The client is
`CF-Connecting-IP` only when that source is in Cloudflare's published ranges
(`limits::CLOUDFLARE_RANGES`, from cloudflare.com/ips-v4 and ips-v6, October
2026; `TRUSTED_PROXY_RANGES` overrides them); from anywhere else the header is
ignored and the source itself is counted, so a client connecting to Fly
directly cannot spoof its way around the limit. Update the list when
Cloudflare publishes new ranges (an edge outside it would make all its
clients share one budget).

`opentunnel_requests_limited_total{limit}` counts refusals (`create_rate`,
`issuance_rate`, `issuance_backlog`).

## Observability

### Metrics

Every machine serves Prometheus metrics (OpenMetrics text) at `GET /metrics` on
`METRICS_LISTEN` (`[::]:9091`). It binds every interface: bound to the 6PN
address (`FLY_PRIVATE_IP`) like the internal listener, Fly's scraper no
longer reached it (October 2026). It needs no token: no `[[services]]` entry
exposes the port, so only Fly's scraper and the private network reach it,
which is the whole `anomaly-807` organization, so nothing in it may be secret
or per tenant: no tunnel IDs, hostnames or client addresses, only machine IDs
and fixed label values. `fly.toml`'s `[metrics]` section has Fly scrape it
every 15 s into its managed Prometheus, which adds `app`, `region`, `host` and
`instance` labels. No metric has a per-tunnel label.

| Metric | Type | Labels | |
| --- | --- | --- | --- |
| `opentunnel_process_open_fds`, `opentunnel_process_max_fds` | gauge | | open descriptors and the soft limit |
| `opentunnel_tokio_tasks` | gauge | | live Tokio tasks (follows connections and bridges) |
| `opentunnel_process_resident_memory_bytes` | gauge | | from `/proc/self/statm` |
| `opentunnel_uptime_seconds` | gauge | | |
| `opentunnel_accept_errors_total` | counter | `error` (`emfile`, `other`) | failed accepts; `emfile` is running out of descriptors |
| `opentunnel_api_tls_handshakes_total` | counter | `result` (`ok`, `failed`, `timeout`) | TLS for the API domain; through Cloudflare a failed handshake is a 525 |
| `opentunnel_connections_shed_total` | counter | `reason` (`handshakes`, `connections`) | public connections closed unserved because the machine is saturated: no API TLS handshake slot within 1 s, or at the connection limit (as many as three quarters of the memory hold at 64 KB each, at most 60,000; logged at startup) ([Capacity](#capacity)) |
| `opentunnel_requests_limited_total` | counter | `limit` (`create_rate`, `issuance_rate`, `issuance_backlog`) | API requests refused by a [limit](#limits) |
| `opentunnel_bridges_attached` | gauge | | |
| `opentunnel_bridge_attaches_total` | counter | `result` (`ok`, `bad_token`, `cert_not_ready`, `invalid_route`, `too_many_routes`, `route_conflict`, `error`) | |
| `opentunnel_bridge_backpressure_total` | counter | `event` (`stall`, `reset`) | a bridge reader waited 5 s for visitors to take data; a connection reset because its visitor did not keep up ([Bridge limits](#bridge-limits)) |
| `opentunnel_bridge_detaches_total` | counter | `reason` (`client_close`, `drop`, `idle_retire`, `drain`, `delete`, `server_close`) | attached bridges that ended |
| `opentunnel_visitor_connections_open` | gauge | | public tunnel connections held here (including forwarded ones) |
| `opentunnel_visitor_connections_total` | counter | `outcome` (`served_local`, `forwarded_out`, `forwarded_in`, `rejected_unknown_tunnel`, `rejected_unknown_route`, `rejected_no_bridge`, `rejected_cert_not_ready`, `rejected_too_many_connections`, `rejected_bad_hello`, `rejected_timeout`, `error`) | a forwarded visitor counts on both machines (`forwarded_out`, `forwarded_in`) |
| `opentunnel_visitor_bytes_total` | counter | `direction` (`in`, `out`) | counted on the machine with the bridge |
| `opentunnel_visitor_connection_duration_seconds` | histogram | | connections carried over a bridge here |
| `opentunnel_cluster_forward_failures_total` | counter | `reason` (`refused`, `connect`, `timeout`, `io`) | |
| `opentunnel_mesh_lookups_total` | counter | `result` (`hit`, `miss`) | a visitor without a local bridge: another machine holds the route, or none does |
| `opentunnel_mesh_peers` | gauge | `state` (`up`, `connecting`, `unreachable`) | other machines this one knows by address; `unreachable` includes one that answers without the mesh |
| `opentunnel_mesh_links_total` | counter | `event` (`up`, `down`) | mesh links that came up or went down (reconnects) |
| `opentunnel_mesh_table_bridges` | gauge | `machine` | bridges in this machine's table per machine holding them (itself included) |
| `opentunnel_mesh_propagation_seconds` | histogram | `kind` (`attached`, `detached`, `event`) | from a peer announcing a change to this machine applying it, by the two machines' clocks |
| `opentunnel_mesh_snapshot_bridges`, `opentunnel_mesh_snapshot_duration_seconds` | histogram | | snapshots received when links come up: their size, and from the peer taking it to applying it here |
| `opentunnel_db_query_duration_seconds` | histogram | `operation` (the `Store` method) | |
| `opentunnel_db_errors_total` | counter | `operation` | failed and timed out statements |
| `opentunnel_db_pool_connections` | gauge | `state` (`idle`, `in_use`) | |
| `opentunnel_acme_attempts_total` | counter | `kind` (`issue`, `renew`, `server`), `outcome` (`success`, `retry`, `failed`, `abandoned`, `refused`) | `failed` gave up; `abandoned`: the tunnel no longer wants it; `refused`: names the tunnel may not have |
| `opentunnel_acme_failures_total` | counter | `kind`, `class` (`network`, `timeout`, `http_5xx`, `http_429`, `bad_body`, `nonce`, `bad_nonce`, `authz_pending`, `dns`, `rejected`, `other`) | every failed attempt |
| `opentunnel_acme_issuance_duration_seconds` | histogram | `kind`, `outcome` | one attempt |
| `opentunnel_acme_cooldowns_total` | counter | | CA cool-downs this machine started ([Limits](#limits)) |
| `opentunnel_acme_dns_records_total` | counter | `event` (`created`, `deleted`, `delete_failed`, `swept`) | DNS-01 challenge TXT records; `swept`: leftovers the periodic sweep deleted |
| `opentunnel_certificate_jobs` | gauge | `status` (`pending`, `failed`: in the last 24 h) | the whole database, refreshed every minute on every machine (so take `max`, not `sum`) |
| `opentunnel_certificates_expiring` | gauge | | ready certificates of tunnels with a bridge here that expire within 14 days |

Fly's built-in `fly_instance_*` series (memory, CPU, `fly_instance_filefd_*`)
sit next to them.

Where to see them: Grafana at [fly-metrics.net](https://fly-metrics.net)
(Explore, the Prometheus data source), or the Prometheus API:

```bash
TOKEN=$(fly auth token)   # or a read-only token from `fly tokens create readonly`, sent as `FlyV1 <token>`
curl -s -G https://api.fly.io/prometheus/anomaly-807/api/v1/query -H "Authorization: FlyV1 $TOKEN" \
  --data-urlencode 'query=opentunnel_process_open_fds{app="opentunnel"}' | jq '.data.result[] | [.metric.region, .value[1]]'
```

Queries for the signals of past incidents:

```promql
# Descriptors as a fraction of the limit, per machine (the fd leak): alert above 0.5
max by (region) (opentunnel_process_open_fds{app="opentunnel"} / opentunnel_process_max_fds{app="opentunnel"})
# Tasks and memory growing while bridges and connections do not
opentunnel_tokio_tasks{app="opentunnel"}
opentunnel_tokio_tasks{app="opentunnel"} / (opentunnel_bridges_attached{app="opentunnel"} + opentunnel_visitor_connections_open{app="opentunnel"} + 1)
opentunnel_process_resident_memory_bytes{app="opentunnel"}
rate(opentunnel_accept_errors_total{app="opentunnel",error="emfile"}[5m]) > 0
# Certificate attempts failing, by class, and issuance that gave up
sum by (class) (increase(opentunnel_acme_failures_total{app="opentunnel"}[1h]))
sum(increase(opentunnel_acme_attempts_total{app="opentunnel",outcome="failed"}[1d]))
  / sum(increase(opentunnel_acme_attempts_total{app="opentunnel",outcome=~"success|failed"}[1d]))
max(opentunnel_certificate_jobs{app="opentunnel",status="failed"})
sum(opentunnel_certificates_expiring{app="opentunnel"}) > 0
# API TLS handshakes failing (Cloudflare 525s). 525s whose Host is a tunnel hostname are not these: requests
# for <id>.opentunnel.xyz sent to Cloudflare (mostly scanners) reach this server with that SNI and are closed
# when the tunnel has no bridge, like any visitor.
sum by (region, result) (rate(opentunnel_api_tls_handshakes_total{app="opentunnel",result!="ok"}[5m]))
# Visitors turned away, by reason; forwarding between machines failing
sum by (outcome) (rate(opentunnel_visitor_connections_total{app="opentunnel",outcome=~"rejected.*|error"}[5m]))
sum by (region, reason) (rate(opentunnel_cluster_forward_failures_total{app="opentunnel"}[5m]))
# The mesh: every machine should see all others up, and the same bridges per machine
min(opentunnel_mesh_peers{app="opentunnel",state="up"})
sum by (region, state) (opentunnel_mesh_peers{app="opentunnel",state!="up"}) > 0
sum by (region) (increase(opentunnel_mesh_links_total{app="opentunnel",event="down"}[1h]))
sum by (region) (opentunnel_mesh_table_bridges{app="opentunnel"})
histogram_quantile(0.99, sum by (le, kind) (rate(opentunnel_mesh_propagation_seconds_bucket{app="opentunnel"}[5m])))
# Slow storage, per operation
histogram_quantile(0.99, sum by (le, operation) (rate(opentunnel_db_query_duration_seconds_bucket{app="opentunnel"}[5m])))
```

### Logs

On Fly (`LOG_FORMAT=json`) every line on stderr is one JSON object:
`timestamp`, `level`, `message`, `target`, the event's fields, then `machine`
and `region`. Fields keep the same names everywhere: `tunnel`, `conn`,
`route`, `certificate`, `kind`, `attempt`, `error`, `error_class`, `status`.
Tokens, keys and the database URL are never logged.

- Each failed certificate attempt is a `warn` "certificate issuance attempt
  failed" with `attempt`, `error_class`, the HTTP `status` of an ACME error
  and `error` (which includes the ACME problem document or the start of the
  response body); retries are `info` "retrying certificate issuance", and
  giving up is an `error` "certificate issuance gave up".
- Descriptor use crossing 50% and 80% of the limit is a `warn` (repeated every
  ten minutes while it stays there), with `fds`, `limit` and `tasks`.
- Failed accepts are logged at most every ten seconds, with `error_class`
  (`emfile`) and how many were `suppressed`.
- Per-connection messages are `debug` (`RUST_LOG=opentunnel_server=debug`).

```bash
fly logs -a opentunnel -r iad --no-tail | sed 's/^[^{]*//' | jq -c 'select(.level != "info")'
fly logs -a opentunnel | sed 's/^[^{]*//' | jq -c 'select(.message | test("certificate issuance")) | {region, attempt, error_class, status, error}'
```

(`fly logs` prefixes each line with the time, region and machine; the `sed`
strips it.)

## Multiple regions

Machines in `iad`, `ord`, `sjc`, `gru`, `lhr`, `fra`, `cdg`, `jnb`, `sin`, `nrt` and
`syd` (one each today; busy regions may run several), behind one anycast
IPv4/IPv6. Fly sends each TCP connection to the nearest machine: a visitor to
the one nearest the visitor, and a client's bridge (through Cloudflare, which
proxies `opentunnel.xyz`) to the one nearest the client's Cloudflare colo. The
two meet through the mesh and forwarding over Fly's private network (6PN). The
code is `mesh.rs` (links, table, events) and `cluster.rs` (forwarding, route
checks, acting on events); with `INTERNAL_LISTEN=off` none of it runs.

```text
                    ┌── mesh link (TCP over 6PN, :9000): snapshot, attached/detached, events, pings ──┐
client ─▶ Cloudflare ─▶ machine A (iad) ─ bridge attached ─▶ "attached" to every peer         machine B (syd) ◀─ visitor
                                 ▲                                                             │ table: tunnel/route → A
                                 └──── TCP over 6PN to A:9000: "OPENTUNNEL-FORWARD/2 B A <time> <nonce> <id> <route> <visitor> <proof>\n"
                                       + ClientHello ──▶ "1" ──▶ raw bytes both ways ──────────┘
```

- **Membership.** Peers are the addresses of `<FLY_APP_NAME>.internal`
  (every started machine of the app), resolved every 5 s, plus `MESH_PEERS`.
  Every machine keeps one long-lived TCP link to every other one, on the
  internal listener. Both sides dial (the higher address waits 2 s first, so
  usually the lower one's link is the only one); if two links to one machine
  come up, both sides keep the same one: the newer life of the machine
  (`started_at`, then a random `epoch`), then the link dialed by the lower
  address. Failed dials back off from 200 ms to 5 s. An address that leaves DNS
  is dialed for 30 s more.
- **Links.** A challenge and response proves both sides hold
  `INTERNAL_TOKEN` without sending it (`peer_auth.rs`): the dialer sends
  `OPENTUNNEL-MESH/2 <machine> <nonce>\n`, the acceptor answers
  `OPENTUNNEL-MESH/2 <machine> <nonce> <proof>\n`, and the dialer, once that
  proof checks out, `<proof>\n`. Each proof is HMAC-SHA256 keyed with the
  secret over its role (`accept`, `dial`), both machine IDs and both nonces,
  checked in constant time; a machine that answers at a peer address without
  the secret learns only a fresh proof it cannot reuse, and a `hello` naming
  another machine than the one that proved itself ends the link. The link is
  authenticated, not encrypted (6PN itself is WireGuard between hosts). The
  `hello` address (where forwards to the peer's bridges go) must be the
  address the connection comes from (or was dialed at) and, on Fly, what
  `<machine>.vm.<app>.internal` resolves to; a machine ID already linked from
  another address is refused rather than taking its place. Before a peer has
  proven the secret it can make a machine hold at most a header line (1 KiB,
  10 s), and at most 256 such connections at once; its `hello` may be 4 KiB,
  later frames 16 MiB (snapshots go out in several frames,
  `snapshot`/`snapshot_part`, of at most 4 MiB of entries each). Peers'
  `attached_at` more than 5 s ahead of this machine's clock counts as now, so
  no peer can win every route forever, and a `tunnel deleted` event closes
  bridges only once the database says the tunnel is deleted. Then
  frames: a big-endian `u32` length and a JSON object
  with a `type`. First `hello` (format version, machine ID, region, internal
  address, epoch, `started_at`, draining), then a `snapshot` of the sender's
  own bridges with its sequence number, then `attached`/`detached` deltas
  numbered by that per-machine sequence (a gap closes the link, which
  reconnects with a fresh snapshot), `event`s, and a `ping` every second when
  idle. Every frame carries the sender's clock (`sent_at`) for the propagation
  metric. Unknown frame types and fields are ignored, so additions need no
  version bump. A peer that sends nothing for 5 s is down, as is one whose link
  closes or fails; a peer that falls 200,000 frames behind is disconnected and
  starts over.
- **The table.** Each machine is the only writer of its own entries (tunnel,
  bridge ID, routes, attach time), so nothing needs consensus: it announces
  `attached` before the client hears `attached` and `detached` when the bridge
  closes or is retired as silent, and every peer applies them in order.
  Lookups ("who holds tunnel X, route Y", "is tunnel X online elsewhere") are
  local reads. When a peer goes down its entries are dropped at once; when it
  comes back its snapshot replaces them, and a restarted machine (new epoch)
  replaces its previous life's entries the moment its new link is up. A
  draining machine's entries are dropped as soon as it announces `leaving`.
- **Events** go to every linked peer on the same links: tunnel created,
  certificate changed (bound, ready, renewed), tunnel deleted (the receiver
  closes its bridges of the tunnel and forgets its record), leaving, and job
  enqueued (wakes the job runners; leases still make each job run once).
  Receivers mark the tunnel's cached record stale, so the next upgrade or
  visitor reads it again. Events sent while a link is down are lost, so every
  link that comes up (startup, a reconnect, a healed partition) makes the
  receiver read cached "missing" and "not ready" answers again before trusting
  them, and check, in one query,
  whether any tunnel with a bridge here was deleted meanwhile. A link
  subscribes to its sender's announcements before its `hello` goes out, so
  anything announced after the receiver sees the link arrives over it, and
  anything before was written to the database before the receiver's check.
- **Cached records.** A machine caches tunnel records for routing, so the
  database stays off the visitor path. API calls, attaches, alarms and
  certificate updates read the record again (one query); routing re-reads a
  cached record only while it is missing or its certificate is not ready, and
  then only when told (an event, a new link), when the mesh is not complete (a
  peer starting or unreachable: then after 30 s for
  missing, 5 s for not ready, as before), or after a 10-minute safety TTL. Idle
  entries without bridges are dropped after 30 s. During a database outage
  the cached copy is used.
- **Forwarding.** A visitor for a route with no local bridge: look up the
  route in the table (the newest attach if two machines claim it), connect to
  the holder's internal address, send the header (sender and receiver machine
  IDs, the time, a nonce, tunnel, route, the visitor's address from PROXY v2,
  and an HMAC-SHA256 over all of them keyed with the shared secret) and the
  buffered ClientHello. The receiver checks that the header is for it, signed
  within 30 s of its clock, and that it has not seen the nonce (so a captured
  header cannot be replayed).
  The receiver parses the ClientHello itself and routes it exactly like a
  local visitor (`max_conns`, backpressure, analytics, the `open` message with
  the real visitor address), but never forwards again. It answers `1` before
  the stream or `0` when it has no bridge; on `0` or a failed connection the
  sender looks once more, skipping that machine, and otherwise closes. A
  signed forward or route check counts only from a machine linked now, from
  its linked address. The sender then copies both
  directions (`net::splice`, 32 KiB buffers, half-closes passed on, the same
  idle and half-close timeouts as local visitors); a reset or timeout on one
  side resets the other.
- **Route conflicts.** Attaching checks the table for the requested routes on
  other live machines and asks only those (`GET /internal/tunnel/<id>/routes`
  on the internal listener, signed like a forward in an `x-opentunnel-auth`
  header over the method and path, which
  retires silent bridges before answering); only a live answer is a
  `route_conflict`, so a machine that is down, draining or cannot be asked
  never blocks a client that moved. Two machines accepting the same route in
  the same instant is possible; visitors then go to the newer attach and
  nothing breaks.
- **Round trips.** Machines far from the database (~150 ms from `nrt`,
  `syd`) pay for every sequential statement, so the paths clients wait on take
  as few as possible. An attach reads the record and its renewal alarm in one
  query (sent as a plain text query, so it is one round trip even on a pooled
  connection that has not prepared it; for a tunnel new to the machine, the
  upgrade's read of moments before, which brings the alarm too, is used
  instead of a second one), checks route conflicts in memory
  (asking another machine only when the table says it holds a requested
  route), announces the bridge to the mesh, and answers `attached`. The rest
  runs afterwards without failing the attach: `lastConnectedAt` (at most
  hourly) and the renewal check, at most 10 attaches' worth at once so a
  storm's writes leave the pool to the reads attaches wait on. Closing a
  bridge touches no database at all, and does not wait for that bookkeeping.
  Reads of single tunnels (attaches, upgrades, visitors of tunnels not cached)
  are batched: while reads are in flight, new ones queue, and the next takes
  up to 200 queued IDs in one `WHERE id IN (...)` (at most 8 batches at once),
  so a storm on a machine 150 ms from the database is not capped at the pool
  size per round trip (~100 attaches a second before; see [Capacity](#capacity)).
  A database that does not answer an attach within 4 s (or a pool with no free
  connection within 3 s) fails it, or attaches from a cached record, well
  inside the clients' 10 s connect timeout, so they back off instead of
  reconnecting at once. The job runner and the alarm loop each take one query
  per wakeup, wake on local notifications (and `job enqueued` events) and when
  the next job or alarm is due, and otherwise poll every 30-60 s (jittered).
  `attaches_within_one_database_round_trip` in `service.rs` checks the attach
  against a database 100 ms away.
- **The internal port** binds only the machine's 6PN address and is not in
  `fly.toml`'s services, so it is unreachable from the Internet. 6PN is
  organization-wide, though (any app in `anomaly-807` reaches it), so nothing
  on it trusts the network: every link, forward and route check proves the
  secret as above. Its first line selects mesh link, forward, or HTTP.

Failure modes:

| What | Effect |
| --- | --- |
| A machine is deployed away (SIGTERM) | It announces `leaving`: peers drop its bridges at once and stop forwarding to it, while it keeps forwarding its own visitors to the others for the drain. Its bridges get `drain`/1012 and reattach to the new or next-nearest machine within seconds, which announces them |
| New machines join (deploy, scaling) | They appear in DNS, link to every machine within seconds and receive snapshots; until all their links are up, machines trust cached "missing"/"not ready" answers only briefly |
| A machine crashes | Its links close: peers drop its bridges at once (or within 5 s if it froze without closing them) and stop forwarding there; its clients reconnect elsewhere and attach at once (the route check does not count it) |
| A machine restarts | Its new life (new epoch) replaces the old entries as soon as its new link is up |
| 6PN between two machines fails (partition) | Each side drops the other's bridges within 5 s and serves its own; visitors for the other side's bridges are closed at once (no forward is tried). When the link heals, snapshots reconverge the tables and a check catches deletions made meanwhile |
| Database unavailable | Local visitors, attached bridges, forwarding and the mesh keep working from memory; attaches use cached records; API calls answer 503. A machine that starts meanwhile serves nothing and fails its checks, and exits after `STARTUP_DB_TIMEOUT_MS` so Fly restarts it ([Storage](#storage)) |
| One machine cannot reach the database (its host's network) | At startup: as above, it fails its checks and restarts every 2 minutes, up to 10 times. While running: its API calls answer 503 while bridges and visitors of tunnels it already knows keep working |
| An event is lost (a link down at the time) | The receiver reads cached "missing"/"not ready" answers again and checks for deleted tunnels when the link comes back |

Latency: PlanetScale is in us-east-1, ~200 ms from `syd`. The visitor path
reads the database only on a tunnel's first visitor per machine (the record);
locating the bridge is a memory lookup. An attach waits for one round trip
(see Round trips above). A change reaches the other machines in one 6PN
one-way trip (well under 1 ms between machines on one host in the tests;
`opentunnel_mesh_propagation_seconds` in production).

### Deploying

```bash
fly secrets set --app opentunnel --stage INTERNAL_TOKEN=$(openssl rand -hex 32)
fly deploy --app opentunnel                  # blue-green: new machines next to the old ones, then the old ones stop
fly scale vm shared-cpu-1x --memory 1024 --app opentunnel   # if existing machines kept the old size
for region in ord sjc gru lhr fra cdg jnb sin nrt syd; do
  fly scale count 1 --region $region --app opentunnel --yes
done                                         # or: fly machine clone <iad machine> --region <region>
fly status --app opentunnel                  # every machine passing checks
curl -s -X POST https://opentunnel.xyz/api/admin/stats -H "authorization: Bearer $ADMIN_TOKEN" | jq .cluster
```

`fly scale count` for a region keeps the other regions as they are, and
`fly scale count 2 --region iad` adds a second machine there: it joins the mesh
by itself. Every machine must have `INTERNAL_TOKEN` before it runs with
`INTERNAL_LISTEN` (staged secrets apply on the next deploy).

During a blue-green deploy the new machines link with the previous version's
for a minute or so, so the mesh, forward and route-check formats must stay
compatible with the version in production: frames and fields may be added
(unknown ones are ignored), but a handshake change needs a release that
accepts both first. The current handshakes (`OPENTUNNEL-MESH/2`,
`OPENTUNNEL-FORWARD/2`, `x-opentunnel-auth`) replaced ones that sent
`INTERNAL_TOKEN` itself in October 2026; those are refused now.

## Capacity

Measured with the load test below against the server confined like a Fly
machine: one core and 2 GB (`performance-1x`), or 1 GB and 6% of a core
(`shared-cpu-1x` with its burst balance used up, the worst case; with
balance left it bursts to the whole core).

**What a bridge costs.** Memory: ~22 KB per idle bridge for the connection
itself (rustls with its 4 KB record buffer, the two tasks, the queue, the
bridge state), plus its tunnel's cached record (~6 KB with a certificate,
chain and CSR), so ~29 KB in all, against ~190 KB before October 2026. In
production, where bridges carry traffic, it is ~50 KB (~250 KB before: cdg
went from 160 MB with 569 bridges to 37 MB with 456; an idle machine is
~16 MB). What went: tungstenite's 128 KiB read buffer per socket (and read and write
buffers that stayed as large as the largest frame a socket ever carried,
~100 KB more on a bridge that had carried visitors), replaced by
`websocket.rs`, which keeps no buffer between messages and writes frames
straight from their payload; 40 KB futures per connection task (the API
handlers and storage calls inline), now boxed while they run; and memory
glibc kept after bursts, now returned with `malloc_trim` every minute. CPU:
an attach (TCP, TLS 1.3, upgrade, attach, mesh announce) is ~0.14 ms, mostly
the X25519 key exchange; SHA-256 suites go first (SHA-384's key schedule runs
on SHA-512, which is not accelerated) and stateless session tickets let a
client resume. Holding 50,000 idle bridges (a ping each every 15 s) takes
~5% of the core. Sockets have `TCP_NODELAY`: before, small writes waited for
the peer's delayed ACK, 40 ms per attach and per visitor's first bytes.

**Reconnect storms.** The listen backlog is 16,384 (capped by the kernel's
`somaxconn`; Tokio's 1,024 overflowed). At most 256 API TLS handshakes run at
once; a new API connection that gets no slot within 1 s is closed before its
handshake (`opentunnel_connections_shed_total{reason="handshakes"}`), so its
client retries after its backoff instead of waiting in a queue until its
10 s timeout and retrying anyway. Clients (both) wait 125-250 ms after an
attached session ends, then double each failed attempt's delay up to 30 s
(equal jitter), and reset only after `attached`, so a storm drains at the
rate the machine attaches instead of compounding. Attach reads are batched
and bookkeeping writes bounded (see Round trips above).

**Results** (`examples/loadtest.rs`, server on one core and 2 GB, MySQL 8
local or behind a proxy adding 75 ms each way like `nrt`/`syd`, PROXY v2,
mesh on, records of real size):

| | Before (10,000 bridges) | After (50,000 bridges) |
| --- | --- | --- |
| Memory per bridge | 158 KB (190 KB with real records) | 22 KB (29 KB with real records) |
| Memory at the bridge count, steady | 1.56 GB (1.86 GB) | 1.41 GB; 1.7 GB after visitors and storms |
| Ramp, local DB | 1,980/s at 45% CPU, attach p50 41 ms | 2,990/s at 42% CPU, attach p50 < 1 ms |
| Ramp, DB 150 ms away | 113/s (offered 1,000/s), 46,000 upgrades answered 503 | 2,950/s, attach p50 227 ms, no failures |
| Idle CPU (pings) | 1.9% | 4.7% |
| Visitors (50 at once: ClientHello echoed, 5 × 4 KB round trips) | 2,050/s, first byte 40 ms | 4,400/s at 64% CPU, first byte p50 1 ms / p99 10 ms |
| Storm: all dropped at once, local DB | 3.8 s, 6,600 kernel resets | 16-19 s, peak 90% CPU, no client timeouts, attach p99 5.3 s |
| Storm, DB 150 ms away | 6.5 s | 16-19 s, no client timeouts |

On 1 GB and the shared core: 15,000 bridges take 440 MB (560 MB after
visitors) and, bursting, a storm of all of them drains in 3 s. Held to 6% of
the core, 4,000 bridges attach at 420/s (71/s before, with 1,650 client
timeouts) and a storm of them drains in 14 s (18 s before); a storm of 10,000
takes ~80 s, many attempts timing out while the core is starved.

**Limits.** Memory: ~20 MB at rest plus ~50 KB per bridge in production, so
60% memory is ~24,000 bridges on 2 GB and ~12,000 on 1 GB. CPU: ~1% of a core per 10,000 idle bridges, ~0.14 ms per
attach, ~0.15 ms per visitor connection. On a dedicated core memory binds
first; on `shared-cpu-1x` the storm a machine must absorb on a starved core
does (it should stay at a few thousand bridges).

**Production correction (2026-10-25).** Real bridges are not idle: their visitors, scanner probes for
offline tunnels, reconnects and API handshakes cost far more than the load test's idle bridges. Measured in
production, a machine's own CPU work is roughly 0.7-1% of a core per 100 bridges (fra: 7.4% at 2,015; cdg:
~6% at ~680, with heavier traffic per bridge). A `shared-cpu-1x` is only guaranteed 1/16 of a core (6.25%)
and runs on burst credit above that, so the CPU baseline, not memory, binds first: at **~700-1,000 bridges**
a machine sits at its baseline and slowly drains its credit, and at 0 credit Fly throttles it (the time shows
up as `steal` in `fly_instance_cpu`). Scale out a region when a machine's `fly_instance_cpu_balance` trends
down or its bridges pass ~800.

| Machine | Bridges at ~60% memory | Bridges at CPU baseline (production) | `soft_limit` / `hard_limit` (connections on :443) |
| --- | --- | --- | --- |
| `shared-cpu-1x`, 1 GB (`fly.toml` today) | ~12,000 | ~700-1,000 | 1,000 / 10,000 |
| `performance-1x`, 2 GB | ~24,000 | ~10,000+ (dedicated core) | 15,000 / 25,000 |

The limits count every connection on :443 (bridges, visitors, API calls).
Fly's proxy sends a new connection to the closest machine in the region that
is under `soft_limit`, so with two or more machines in a region they fill
evenly past it, which keeps storms per machine small; soft limits never move
traffic to another region. Above `hard_limit` a machine gets no new
connections, and only when every machine in the region is there does the
proxy use another region (bridges then attach there, and the mesh forwards
their visitors). Add a machine to a region before its machines average the
soft limit in `opentunnel_bridges_attached`, or when `fly_instance_memory`
passes 60% or CPU stays above 50%. The server's own limit (as many
connections as three quarters of the memory hold, at most 60,000) closes new
connections at once beyond it.

**The load test.** `crates/opentunnel-server/examples/loadtest.rs`: `seed`
writes tunnels with ready certificates straight into a database, `run`
attaches bridges like real clients (TCP from several loopback addresses, a
PROXY v2 header, TLS to the API domain, the upgrade, `attach`, pings every
15 s; the bridges echo visitor data), holds them, sends visitors through
them, drops them all at once and waits for them to attach again with the
clients' backoff, sampling the server's CPU and memory from `/proc`; `delay`
is a TCP proxy that puts the database 150 ms away.

```bash
docker run -d --name ot-load-mysql --tmpfs /var/lib/mysql -e MYSQL_ROOT_PASSWORD=opentunnel \
  -e MYSQL_DATABASE=lt -p 13306:3306 mysql:8.0 --max-connections=1000
cargo build --release -p opentunnel-server --example loadtest
LT=target/release/examples/loadtest
$LT seed --database-url mysql://root:opentunnel@127.0.0.1:13306/lt --count 50000
$LT delay --listen 127.0.0.1:13307 --target 127.0.0.1:13306 --delay-ms 75 &   # optional: a far database
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout key.pem -out cert.pem \
  -days 30 -subj /CN=opentunnel.test -addext subjectAltName=DNS:opentunnel.test
mkdir -p site && echo ok > site/index.html
# One core and 2 GB, like performance-1x:
systemd-run --user --scope -p MemoryMax=2G -p MemorySwapMax=0 env OPENTUNNEL_DOMAIN=opentunnel.test \
  DATABASE_URL=mysql://root:opentunnel@127.0.0.1:13306/lt TLS_CERT_FILE=cert.pem TLS_KEY_FILE=key.pem \
  WEBSITE_DIR=site ISSUER=local HTTP_LISTEN=off PROXY_PROTOCOL=true INTERNAL_LISTEN=127.0.0.1:9000 \
  INTERNAL_TOKEN=loadtest MESH_DNS=off RUST_LOG=warn taskset -c 0 target/release/opentunnel-server &
ulimit -n 500000
taskset -c 2-23 $LT run --count 50000 --rate 3000 --sources 8 --proxy-protocol --pid $(pgrep -n opentunnel-serv)
docker rm -f ot-load-mysql
```

`run --help` lists the phases' knobs (`--hold`, `--visitors`, `--echo-bytes`,
`--storms`, `--no-resume`, ...). More than ~28,000 bridges need more loopback
source addresses (`--sources`), and the kernel's `somaxconn` caps the server's
backlog (4096 by default; resets in a storm are that queue overflowing).

## Tests

The storage, service, API contract and end-to-end tests need a MySQL 8 server
whose user may create databases; each test creates its own `ot_test_*`
database. Without `TEST_DATABASE_URL` they print a note and skip.

```bash
docker run -d --name ot-mysql -e MYSQL_ROOT_PASSWORD=opentunnel -e MYSQL_DATABASE=opentunnel -p 3306:3306 mysql:8.0
export TEST_DATABASE_URL=mysql://root:opentunnel@127.0.0.1:3306/opentunnel
cargo test -p opentunnel-server
docker rm -f ot-mysql    # when done; it holds the test databases
```

- `cargo test -p opentunnel-server`: storage (revisions, imports, concurrent
  alarms, job leases), unit tests (SNI, PROXY protocol, CSRs, the bridge WebSocket codec,
  analytics, renewal scheduling with a manual clock, stale bridges, routing,
  cached answers and mesh events, imports), the API contract replay against the Worker's recorded responses,
  the Rust client end to end (provisioning, passthrough, shared tunnels,
  restarts, migrated tunnels, renewal on attach, a database outage), the
  imports and job names (`tests/migration.rs`: hostile records refused, jobs
  for other names refused), two and three servers on one database
  linked by the mesh (`tests/cluster.rs`: forwarding right after an attach,
  detaches, route conflicts and deletes across machines, machines in one region
  holding different routes, a crashed machine, a frozen one dropped after 5 s,
  a restart replacing its old entries, a partition healing, created and
  certificate-ready tunnels routable at once, signed requests, deletions the
  database does not confirm ignored, and jobs running once), the mesh alone (`tests/mesh.rs`: one link
  per pair, replication, newer claims, leaving, events, bad tokens, the
  challenge never revealing the secret, the old handshake refused, and 20,000
  bridges with 100 changes a second), signed forwards and route checks
  (`tests/cluster.rs`: replayed, stale, misaddressed and badly signed requests
  refused), the limits (`tests/limits.rs`: per client address, a spoofed
  `CF-Connecting-IP` ignored, the header believed from trusted proxies, per
  tunnel, the backlog; unit tests for the Cloudflare ranges and IPv6 /64
  keys; `store.rs` for GCRA under concurrency), and
  connections whose peers vanish (`tests/leaks.rs`: visitors that close while
  the target never ends, silent visitors, a bridge that goes away, partial
  ClientHellos; tasks and descriptors return to their baseline), and the
  bridge limits (`tests/bridge_limits.rs`: message sizes before and after attach,
  route lists, connections per bridge, many stalled visitors holding at most
  one bridge's budget, stalled visitors reset within one wait while pings and
  other visitors go on, a slow visitor getting a whole download).
- ACME against Pebble with external account binding and DNS-01 through
  pebble-challtestsrv:

  ```bash
  docker run -d --network host ghcr.io/letsencrypt/pebble-challtestsrv -dnsserver 127.0.0.1:8053 -management 127.0.0.1:8055 -http01 "" -https01 "" -tlsalpn01 "" -doh ""
  docker run -d --network host ghcr.io/letsencrypt/pebble -config /test/config/pebble-config-external-account-bindings.json -dnsserver 127.0.0.1:8053
  ISSUER=acme ACME_URL=https://localhost:14000/dir ACME_CA_BUNDLE=pebble.minica.pem \
    ACME_EAB_KID=kid-1 ACME_EAB_HMAC_KEY=zWNDZM6eQGHWpSRTPal5eIUYFTu7EajVIoguysqZ9wG44nMEtx3MUAsUDkMTQ12W \
    ACME_ACCOUNT_KEY_JWK="$(opentunnel-server account-key)" DNS_PROVIDER=challtestsrv \
    ACME_DNS_PROPAGATION_TIMEOUT_MS=0 ACME_POLL_INTERVAL_MS=500 opentunnel-server
  ```

  (`pebble.minica.pem` is `/test/certs/pebble.minica.pem` in the Pebble image.)
