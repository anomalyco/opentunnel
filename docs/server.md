# The OpenTunnel server

`crates/opentunnel-server` is the whole hosted service in one async Rust
binary (Tokio, rustls with `ring`, hyper, MySQL on PlanetScale through sqlx), run as one machine per Fly
region against one shared database ([Multiple regions](#multiple-regions)). It replaced the Cloudflare
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
   consuming anything it cannot replay.
2. SNI equal to the domain: the bytes already read are replayed into rustls,
   which serves HTTP/1.1 and HTTP/2 (ALPN) with the server's own certificate.
3. SNI `<id>.<domain>` or `<route>.<id>.<domain>`: the tunnel picks the bridge
   that claimed the route, sends `open` and the ClientHello as data frames,
   then copies both directions in 32 KiB frames. Visitor reads wait while the
   bridge's send queue is full (backpressure); a visitor that stops reading for
   30 s is reset so it cannot stall the bridge. `end` half-closes, `reset`
   aborts with an RST. Anything else (unknown tunnel, no bridge, certificate
   not ready, deeper names) is closed, exactly as before.
4. No bridge for the route on this machine: the visitor is forwarded to the
   machine that has one ([Multiple regions](#multiple-regions)), and only if
   no machine has it, to the legacy Worker (migration) or closed.

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
| `CertificateWorkflow` (ZeroSSL, EAB, DNS-01, retries, `describeError`) | `acme.rs` + `dns.rs` + durable, leased `jobs` rows: three attempts, 15 s then 30 s apart, resumed after restarts |
| Workflow instance named after the certificate ID | Job keyed by certificate ID (`ensure_issuance` adds it only if missing) |
| Cloudflare-managed certificate for `opentunnel.xyz` | `jobs::ServerCertificates`: the same ACME issuance for the domain, renewed 30 days before expiry, hot-swapped |
| Static assets | `website.rs`: `dist/website` in memory, Cloudflare's HTML handling (`/index.html` → `/`), ETags |
| Pipelines `EVENTS` binding | `analytics.rs`: identical event envelopes and payloads, posted in batches to `ANALYTICS_URL` |

Two things changed by necessity: analytics no longer carry `country` and
`colo` (they came from Cloudflare's request metadata), and a tunnel's `state`
in the API is computed from live bridges, so it is never stale after a
restart.

## Storage

MySQL 8, in production the PlanetScale database `opentunnel` (org
`anomalyco`, AWS us-east-1, next to Fly's `iad`), reached through
`DATABASE_URL` with TLS (`sqlx`, rustls with `ring`, Mozilla's roots). Tables
(`store.rs`, all `utf8mb4` with binary collation, so IDs stay case-sensitive):

- `tunnels`: `id`, `record` (the `StoredTunnel` JSON exactly as serialized:
  token hash, hostname, certificate state, CSR and identifiers,
  `lastConnectedAt`, `renewal`, `deletedAt`, ...; `LONGTEXT` because MySQL's
  `JSON` type would reorder keys), `revision`, `deleted` and `issuing`
  (derived from the record for queries), `alarm_at`, `region` (reserved), and
  `local_update`, which is 0 while a row is exactly as imported so a later
  import may refresh it.
- `jobs`: issuance jobs (`issue`, `renew`, `server`) with attempts, the next
  run time, and a lease (`lease_owner`, `lease_until`).
- `server_certificates`: the domain's key, CSR, certificate and expiry.
- `meta`: the API certificate's current job, and the local test CA when
  `ISSUER=local`.
- `bridges` (schema 2): the registry of attached bridges, one row per tunnel,
  route and machine (`bridge_id`, `region`, the machine's internal `address`,
  `updated_at`).
- `schema_migrations`: the schema version.

The schema keeps to what Vitess allows: a primary key on every table, no
foreign keys, triggers or stored procedures. On startup the server creates
missing tables with `CREATE TABLE IF NOT EXISTS` and records the version; once
the database is at its version it runs no DDL at all (so PlanetScale's safe
migrations may be turned on afterwards; later schema changes then go through a
deploy request). A database at a newer version is refused. Schema 2 only adds
the `bridges` table; with safe migrations on, create it through a deploy
request (the statement is in `store.rs`) before deploying, or the new server
keeps retrying at startup.

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
- The legacy pull-through import is the same insert-first import, so two
  machines importing one tunnel at once insert it once.
- The domain's key is created insert-if-absent and its job is requested with a
  compare-and-set on `meta`.

When the database is unavailable the server keeps running: the pool (10
connections, 5 s acquire timeout, connections checked before use and
recycled after 30 minutes) reconnects on its own, every statement gives up
after 10 s, and API calls that need storage answer 503
(`{"_tag":"ServiceUnavailableError","message":"storage unavailable"}`). Tunnels
with an attached bridge keep their record in memory, so visitor traffic and
token checks for them never touch the database; a bridge that attaches during
an outage is accepted from a cached record. At startup the server waits,
retrying, until the database answers.

Back it up with `opentunnel-server export <file>` (or
`POST /api/admin/export`); `opentunnel-server import <file>` writes an export
into the database at `DATABASE_URL`. PlanetScale's own backups also cover it.

## Configuration

Every flag also reads an environment variable (`opentunnel-server --help`).

| Variable | Default | |
| --- | --- | --- |
| `OPENTUNNEL_DOMAIN` | `opentunnel.xyz` | API domain; tunnels are `<id>.<domain>` |
| `TLS_LISTEN` / `HTTP_LISTEN` | `0.0.0.0:8443` / `0.0.0.0:8080` (`[::]` in the image) | `HTTP_LISTEN=off` disables HTTP |
| `HTTP_MODE` | `redirect` | `serve` runs the whole app on plain HTTP (development, tests) |
| `PROXY_PROTOCOL` | `false` | require a PROXY v1/v2 header on :443 (`true` on Fly) |
| `DATABASE_URL` | | secret: `mysql://user:password@host/opentunnel?ssl-mode=VERIFY_IDENTITY` (PlanetScale's "MySQL" connection string). TLS with certificate checks is the default and is required unless the host is loopback |
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
| `DNS_PROVIDER` | `cloudflare` | or `challtestsrv` (Pebble's test DNS) |
| `CLOUDFLARE_ZONE_ID` | the opentunnel.xyz zone | |
| `CLOUDFLARE_API_TOKEN` | | secret: DNS edit on the zone, only for DNS-01 |
| `ISSUANCE_CONCURRENCY` | `4` | ACME orders at once |
| `ANALYTICS_URL`, `ANALYTICS_TOKEN` | | the platform event stream's HTTP endpoint and bearer token; analytics are off without the URL |
| `ADMIN_TOKEN` | | secret: enables `POST /api/admin/{import,export,stats}` |
| `INTERNAL_LISTEN` | `off` | the internal listener for other machines (`[::]:9000` on Fly, bound to `FLY_PRIVATE_IP`); `off` runs a single machine without the registry |
| `INTERNAL_TOKEN` | | secret shared by all machines, required with `INTERNAL_LISTEN` |
| `INTERNAL_ADDRESS` | `[FLY_PRIVATE_IP]:<port>` | where other machines reach this one |
| `FLY_MACHINE_ID`, `FLY_REGION`, `FLY_PRIVATE_IP` | random, `local`, | set by Fly: the registry's machine ID (also the job lease owner), region, and 6PN address |
| `CLUSTER_HEARTBEAT_MS` | `60000` | registry heartbeat; rows older than three are ignored |
| `LEGACY_WORKER_URL`, `RELAY_TOKEN`, `LEGACY_EXPORT_TOKEN` | | TEMPORARY, migration only ([cutover.md](cutover.md)) |

Set secrets with `fly secrets set NAME=value ... -a opentunnel`.

## Operations

- `fly logs -a opentunnel`; `RUST_LOG=opentunnel_server=debug` for per-connection detail.
- `POST /api/admin/stats` (bearer `ADMIN_TOKEN`) returns tunnel, alarm, job,
  attached-bridge and legacy-forward counts. The top-level connection and
  bridge counts are the answering machine's; `machine` has its ID, region and
  forwarding counters (`forwarded_out`, `forwarded_in`, `forward_failures`)
  and live Tokio tasks (`tasks`, which should follow open connections and
  bridges, not grow over time), and `cluster` the registry's view: bridges in total, per region, and per
  machine. The request lands on the machine nearest the caller's Cloudflare
  colo.
- Deploys are rolling, one machine at a time: on SIGTERM the machine removes
  its registry rows, sends every bridge `drain` and closes it with 1012, and
  clients reconnect with backoff to the next-nearest machine (a few seconds of
  downtime for them). Issuance jobs resume where they stopped, on any machine.
- The domain certificate is requested on first start and checked hourly;
  until it exists, TLS to the domain fails while tunnel traffic works.

## Multiple regions

Ten machines, one in each of `iad`, `ord`, `sjc`, `gru`, `lhr`, `fra`, `bom`,
`sin`, `nrt` and `syd`, behind one anycast IPv4/IPv6. Fly sends each TCP
connection to the nearest machine: a visitor to the one nearest the visitor,
and a client's bridge (through Cloudflare, which proxies `opentunnel.xyz`) to
the one nearest the client's Cloudflare colo. The two meet through a registry
in MySQL and forwarding over Fly's private network (6PN). The code is
`cluster.rs`; with `INTERNAL_LISTEN=off` none of it runs.

```text
visitor ─▶ machine B (syd) ── no bridge here ── registry: tunnel/route → machine A
             │                                                     │
             └── TCP over 6PN to A:9000 ──▶ "OPENTUNNEL-FORWARD/1 <secret> <id> <route> <visitor>\n"
                                              + ClientHello ◀── "1" ── then raw bytes both ways
client ─▶ Cloudflare ─▶ machine A (iad) ─▶ bridge attached, rows in `bridges`
```

- **Registry.** On attach, the machine upserts one `bridges` row per route
  (tunnel, route, machine, bridge ID, region, internal address) and deletes
  them when the bridge closes or is retired as silent. Every heartbeat (60 s)
  it refreshes `updated_at` on all its rows, records bridges whose upsert
  failed (database outage), retries failed removals, and closes local bridges
  of tunnels deleted elsewhere. Readers ignore rows older than three
  heartbeats, so a crashed machine's rows expire after at most three minutes;
  a machine deletes all rows with its own ID at startup and on clean shutdown,
  and anyone deletes rows untouched for thirty heartbeats.
- **Forwarding.** A visitor for a route with no local bridge: look up the
  route's freshest row on another machine (cached 30 s, a miss 10 s), connect
  to its internal address, send the header (shared secret, tunnel, route, the
  visitor's address from PROXY v2) and the buffered ClientHello. The receiver
  parses the ClientHello itself and routes it exactly like a local visitor
  (`max_conns`, backpressure, analytics, the `open` message with the real
  visitor address), but never forwards again. It answers `1` before the stream
  or `0` when it has no bridge; on `0` or a failed connection the sender drops
  its cache entry (and skips an unreachable machine for 30 s), looks up once
  more, and otherwise falls back to the legacy Worker (if configured) or
  closes. The sender then copies both directions (`copy_bidirectional`,
  32 KiB buffers); a reset on one side resets the other.
- **Control.** The internal listener also serves a small HTTP/1.1 API,
  authenticated with `Authorization: Bearer <INTERNAL_TOKEN>` (compared in
  constant time): `GET /internal/tunnel/<id>/routes` (the routes this
  machine's live bridges hold, after retiring silent ones) and `POST
  /internal/tunnel/<id>/close` (a deletion). Deleting a tunnel on any machine
  closes its bridges on every machine in the registry and removes its rows.
  Attaching checks the registry for the requested routes on other machines
  and asks those machines whether they still hold them; only a live answer is
  a `route_conflict`, so a crashed or draining machine's leftover rows never
  block a client that moved. Two machines accepting the same route in the same
  instant is possible; visitors then go to the newer row and nothing breaks.
- **Cached records.** A machine caches tunnel records for routing, so the
  database stays off the visitor path. With other machines writing, API calls,
  attaches, alarms and certificate updates read the record again (one query),
  and routing re-reads a cached record only while it is missing or its
  certificate is not ready. During a database outage the cached copy is used.
- **The internal port** binds only the machine's 6PN address and is not in
  `fly.toml`'s services, so it is unreachable from the Internet.

Failure modes:

| What | Effect |
| --- | --- |
| A machine restarts (deploy) | Its rows are removed first, its bridges get `drain`/1012 and reattach to the next-nearest machine within seconds; forwards to it fail over to the new location after one refused attempt |
| A machine crashes | Forwards to it fail fast (connection refused or 3 s timeout), the sender skips it for 30 s; its rows expire after three heartbeats; its clients reconnect elsewhere and attach at once (the route check cannot reach it, so it does not count) |
| 6PN between two machines fails | Visitors for that pair are closed (or go to the legacy Worker); local traffic is unaffected |
| Database unavailable | Local visitors and attached bridges keep working from memory; lookups for remote bridges fail (closed); registry changes are retried by the heartbeat |
| A delete's close request does not arrive | The owning machine's heartbeat sees the tunnel deleted and closes its bridges within a minute |

Latency: PlanetScale is in us-east-1, ~200 ms from `syd`. The visitor path
reads the database only on a tunnel's first visitor per machine (record load
and, without a local bridge, one registry lookup per 30 s); attaching costs a
few queries.

### Deploying

```bash
fly secrets set --app opentunnel --stage INTERNAL_TOKEN=$(openssl rand -hex 32)
fly deploy --app opentunnel                  # rolling, one machine at a time; iad first
fly scale vm shared-cpu-1x --memory 1024 --app opentunnel   # if existing machines kept the old size
for region in ord sjc gru lhr fra bom sin nrt syd; do
  fly scale count 1 --region $region --app opentunnel --yes
done                                         # or: fly machine clone <iad machine> --region <region>
fly status --app opentunnel                  # ten machines, one per region, all passing checks
curl -s -X POST https://opentunnel.xyz/api/admin/stats -H "authorization: Bearer $ADMIN_TOKEN" | jq .cluster
```

`fly scale count` for a region keeps the other regions as they are. Every
machine must have `INTERNAL_TOKEN` before it runs with `INTERNAL_LISTEN`
(staged secrets apply on the next deploy), and the first deploy of this
version creates the `bridges` table (schema 2; see [Storage](#storage)).

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
  alarms, job leases, the registry), unit tests (SNI, PROXY protocol, CSRs,
  analytics, renewal scheduling with a manual clock, stale bridges, routing,
  imports), the API contract replay against the Worker's recorded responses,
  the Rust client end to end (provisioning, passthrough, shared tunnels,
  restarts, migrated tunnels, renewal on attach, a database outage), the
  migration paths against a fake Worker, and two servers on one database
  (`tests/cluster.rs`: forwarding, route conflicts and deletes across
  machines, a crashed machine, a restart, and jobs running once).
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
