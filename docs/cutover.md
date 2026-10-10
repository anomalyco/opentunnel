# Cutover: Cloudflare Worker → Fly

How to move opentunnel.xyz from the Cloudflare Worker (`opentunnel-production`,
Durable Objects, AWS TCP relay) to the Rust server on Fly without any user
doing anything. Installed clients keep their tunnel IDs, tokens, hostnames and
certificates; they reconnect on their own.

## How nothing breaks

- **Records move with their IDs, token hashes and certificate state.** The
  Worker gets a temporary, authenticated, read-only export endpoint; every
  Durable Object's record is exported and imported into the server's MySQL
  database on PlanetScale.
- **Visitors move before clients.** `*.opentunnel.xyz` points at Fly first.
  Fly serves tunnels whose client is attached to it, and hands every other
  connection, still encrypted, to the Worker's `/api/relay`, exactly as the
  AWS relay does today (the legacy fallback). So a tunnel works whichever
  server its client is attached to.
- **Clients move last.** After the API domain points at Fly, the Worker closes
  every bridge (`handoff`, close code 1012). Clients reconnect with backoff,
  resolve opentunnel.xyz again and attach to Fly. A client whose resolver still
  returns Cloudflare just reattaches to the Worker and stays reachable through
  the fallback; the next handoff moves it.
- **Nothing created during the window is lost.** Imports run again right
  before each DNS change, and the server also imports any tunnel it does not
  know from the Worker on first use (the pull-through), so a tunnel created on
  the Worker a second before a client reconnects to Fly still works. Re-imports
  never overwrite a record the Fly server has changed since.
- **Issuance in flight finishes.** Records imported mid-issuance or
  mid-renewal (within the last two days) get a new job on Fly after 15
  minutes if the Worker's Workflow has not finished by then; certificates keep
  serving meanwhile. Older stuck issuance resumes when its client binds again,
  as provisioning clients do.

## Before you start

- `flyctl` logged in to the Anomaly org; `pscale` logged in
  (`pscale auth login`) with access to the PlanetScale org `anomalyco`; `bun`;
  access to the Cloudflare
  account `15d29c8639fd3733b1b5486a2acfd968` and the opentunnel.xyz zone
  (`43d8e5cf1c0ccc8c3868125be74a5e68`).
- The Worker's secret values (Worker secrets cannot be read back, so take them
  from where they were created): `ACME_EAB_KID`, `ACME_EAB_HMAC_KEY`,
  `ACME_ACCOUNT_KEY_JWK`, `CLOUDFLARE_API_TOKEN`, `RELAY_TOKEN`.
  - Reuse `ACME_ACCOUNT_KEY_JWK` so Fly uses the same ZeroSSL account. If it is
    lost, `opentunnel-server account-key` makes a new one; use it with fresh
    EAB credentials from the ZeroSSL dashboard. Tunnel certificates do not
    depend on the account (renewals reuse each tunnel's CSR).
  - If `RELAY_TOKEN` is lost, set a new one on the Worker in step 2 (and on
    the AWS relay, which then needs a restart).
- A Cloudflare API token with **Workers Scripts: Read** on the account, for
  listing Durable Objects (`CF_LIST_TOKEN` below).
- The Worker's workers.dev URL, `https://opentunnel-production.<account-subdomain>.workers.dev`
  (Workers & Pages → the Worker → Settings → Domains & Routes once step 2 enables it).
- Generate two new secrets: `openssl rand -hex 32` for `ADMIN_EXPORT_TOKEN`
  (the Worker's export) and another for `ADMIN_TOKEN` (the Fly server's admin).
- A day ahead, lower the TTL of the `*.opentunnel.xyz` A record to 60 s so the
  later switch (and a rollback) propagates fast.

Shell variables used below:

```bash
export WORKER_URL=https://opentunnel-production.<account-subdomain>.workers.dev
export ADMIN_EXPORT_TOKEN=...   # the Worker's export secret
export ADMIN_TOKEN=...          # the Fly server's admin secret
export FLY_IPV4=...             # after step 1
fly_admin() {                   # POST to the Fly server's admin API, before or after DNS points at it
  curl -sf --resolve opentunnel.xyz:443:$FLY_IPV4 -X POST "https://opentunnel.xyz/api/admin/$1" \
    -H "authorization: Bearer $ADMIN_TOKEN" "${@:2}"
}
```

## 1. Create the database and the Fly app

The database: PlanetScale (Vitess, MySQL 8) database `opentunnel` in the org
`anomalyco`, region AWS us-east-1 (`us-east`), the closest to Fly's `iad`.
The smallest cluster size is plenty (a few hundred rows); keep foreign keys
disallowed (the default). The server creates its tables on first start, so the
password needs the `admin` role (the default for `pscale password create`).
Leave safe migrations off until the first deploy has created the tables (with
them on, PlanetScale refuses direct DDL; later schema changes would then go
through a deploy request).

```bash
pscale database create opentunnel --org anomalyco --engine mysql --region us-east --wait
pscale password create opentunnel main fly-opentunnel --org anomalyco --role admin
# Shown once: username, password, and host (e.g. aws.connect.psdb.cloud). Build the URL:
export DATABASE_URL='mysql://<username>:<password>@<host>/opentunnel?ssl-mode=VERIFY_IDENTITY'
```

The Fly app, from this branch's checkout:

```bash
fly apps create opentunnel --org <org>
fly ips allocate-v4 --app opentunnel     # dedicated IPv4: raw TCP on 443 needs one (billed monthly)
fly ips allocate-v6 --app opentunnel
fly ips list --app opentunnel            # note the v4 as FLY_IPV4 and the v6 as FLY_IPV6
fly secrets set --app opentunnel --stage \
  DATABASE_URL="$DATABASE_URL" \
  ACME_EAB_KID=... ACME_EAB_HMAC_KEY=... ACME_ACCOUNT_KEY_JWK='{"kty":"EC",...}' \
  CLOUDFLARE_API_TOKEN=... ADMIN_TOKEN=$ADMIN_TOKEN INTERNAL_TOKEN=$(openssl rand -hex 32) \
  ANALYTICS_URL=... ANALYTICS_TOKEN=... \
  LEGACY_WORKER_URL=$WORKER_URL RELAY_TOKEN=... LEGACY_EXPORT_TOKEN=$ADMIN_EXPORT_TOKEN
```

`ANALYTICS_URL` is the HTTP ingest endpoint of the production event stream the
Worker's `EVENTS` binding wrote to (Pipelines stream
`251a89241c3a461c9007f6b6f345ed8b`), with a token allowed to write to it.

## 2. Deploy the export endpoint to the Worker

The endpoint is `migration/worker-export.patch`: it adds `/api/admin/export`
and `/api/admin/handoff` (404 without the `ADMIN_EXPORT_TOKEN` bearer secret)
and turns on workers.dev for production, so Fly can still reach the Worker once
opentunnel.xyz points away from it.

```bash
git -C ../opentunnel fetch origin
git -C ../opentunnel worktree add ../opentunnel-export origin/master
cd ../opentunnel-export
git am ../opentunnel-fly/migration/worker-export.patch
bun install --frozen-lockfile && bun run ready
echo "{\"ADMIN_EXPORT_TOKEN\":\"$ADMIN_EXPORT_TOKEN\"}" > secrets.json   # existing secrets persist
bun run deploy --mode production --secrets-file secrets.json && rm secrets.json
```

Master's `deploy.yml` redeploys the Worker on every push to master that
touches it, which would remove the endpoint: merge the patch to master (it is
inert without the secret) or hold such merges until the Worker is
decommissioned.

Check it, with the ID of a tunnel you own:

```bash
curl -sf -X POST $WORKER_URL/api/admin/export -H "authorization: Bearer $ADMIN_EXPORT_TOKEN" \
  -H 'content-type: application/json' -d '{"names":["<your-tunnel-id>"]}'
```

## 3. Deploy the server and get its certificate

```bash
fly deploy --app opentunnel     # or run the "Deploy to Fly" workflow
fly logs --app opentunnel       # wait for "installed a new certificate for the API domain"
```

"the database is not ready" repeating in the logs means `DATABASE_URL` is
wrong or PlanetScale is unreachable; the server keeps retrying. Once it starts,
`pscale shell opentunnel main --org anomalyco` should show the tables
(`SHOW TABLES`).

The domain certificate is issued with DNS-01, which does not depend on where
opentunnel.xyz points. Then:

```bash
curl -sf --resolve opentunnel.xyz:443:$FLY_IPV4 https://opentunnel.xyz/health          # {"ok":true}
openssl s_client -connect $FLY_IPV4:443 -servername opentunnel.xyz </dev/null 2>/dev/null \
  | openssl x509 -noout -issuer -dates
curl -sf http://$FLY_IPV4/health
```

## 4. First export and import

```bash
CLOUDFLARE_API_TOKEN=$CF_LIST_TOKEN bun migration/worker.ts export export-1.json
fly_admin import --data-binary @export-1.json      # {"inserted": ~500, ...}
fly_admin stats
```

Check a tunnel you own end to end against Fly from one test machine: add
`$FLY_IPV4 opentunnel.xyz <id>.opentunnel.xyz <route>.<id>.opentunnel.xyz` to
its `/etc/hosts`, restart its client (`opentunnel down && opentunnel up`), and
open `https://<route>.<id>.opentunnel.xyz`. `opentunnel status` should say
connected. Remove the hosts entries and restart the client afterwards.

## 5. Point visitors at Fly: `*.opentunnel.xyz`

In the zone, change `*.opentunnel.xyz` from A `35.170.151.254` (AWS) to A
`$FLY_IPV4`, DNS only (grey cloud), TTL 60; add AAAA `$FLY_IPV6`.

Every visitor connection now reaches Fly, which forwards it to the Worker
because no client is attached to Fly yet. Check:

```bash
curl -sI https://<route>.<id>.opentunnel.xyz            # a tunnel still on the Worker
fly_admin stats                                         # legacy_forwarded is rising
```

The AWS relay is idle once the old record's TTL has passed; stop it after an
hour (do not delete it until step 10).

## 6. Second export and import

Right before the next step, to catch tunnels created since step 4:

```bash
CLOUDFLARE_API_TOKEN=$CF_LIST_TOKEN bun migration/worker.ts export export-2.json
fly_admin import --data-binary @export-2.json
```

## 7. Point the API at Fly: `opentunnel.xyz`

Replace the proxied apex record with A `$FLY_IPV4` and AAAA `$FLY_IPV6`, DNS
only, TTL 60. The Worker route `opentunnel.xyz/*` stops receiving requests as
resolvers pick this up (proxied records were served with a 300 s TTL).

```bash
dig +short opentunnel.xyz @1.1.1.1; dig +short opentunnel.xyz @8.8.8.8   # the Fly IP
curl -sf https://opentunnel.xyz/health
curl -sf https://opentunnel.xyz/install | head -3
curl -s https://opentunnel.xyz/api/tunnel/xxxxxxxxxxxx      # {"_tag":"TunnelNotFoundError",...}
```

New tunnels are created on Fly from now on.

## 8. Final import, then hand clients over

Wait about 10 minutes, then:

```bash
CLOUDFLARE_API_TOKEN=$CF_LIST_TOKEN bun migration/worker.ts export export-3.json
fly_admin import --data-binary @export-3.json      # rows already changed on Fly count as kept_local
bun migration/worker.ts handoff                    # closes every bridge on the Worker
```

Clients reconnect within seconds (backoff starts at 250 ms) and attach to Fly.
Watch `bridges_attached` in `fly_admin stats` climb to the usual ~280 and
`legacy_forwarded` stop growing. Run `handoff` again after 30 minutes and after
a few hours for clients whose resolvers were slow; it only closes bridges that
are still on the Worker.

## 9. Verify

- `fly_admin stats`: `cluster.bridges` near the usual count, `jobs_failed` 0,
  `legacy_forwarded` flat. Counters other than `cluster` are the answering
  machine's only (see docs/server.md, "Multiple regions"; scaling out to every
  region is described there).
- `fly logs`: no repeated errors; `bridge.connected` analytics arriving.
- Create a tunnel from scratch on a clean machine:
  `curl -fsSL https://opentunnel.xyz/install | sh && opentunnel route add 3000`.
- Cloudflare's Worker analytics show requests dropping to zero.

## 10. Decommission (after a quiet week)

When `legacy_forwarded` has not moved for days and the Worker gets no
requests:

1. Take a last export from the Worker as an archive
   (`bun migration/worker.ts export final-worker.json`) and from Fly
   (`fly_admin export > fly-backup.json`).
2. `fly secrets unset LEGACY_WORKER_URL RELAY_TOKEN LEGACY_EXPORT_TOKEN --app opentunnel`.
3. Delete the Worker `opentunnel-production` (and with it its Durable Objects
   and Workflow), the AWS relay instance, and its RELAY_TOKEN.
4. Remove the code marked TEMPORARY (`migration/`, the legacy parts of
   `crates/opentunnel-server/src/migration.rs`, the `LEGACY_*` settings) and
   add a `push` trigger on master to `.github/workflows/fly-deploy.yml`.

## Rollback

- **Before step 7** (only `*` moved): point `*.opentunnel.xyz` back at
  `35.170.151.254` and start the AWS relay if it was stopped. Clients never
  left the Worker.
- **After step 7**: restore the proxied apex record and the `*` record to the
  AWS relay, then restart the Fly machines (`fly machine restart` for each),
  which close their bridges with 1012 so clients reconnect to the Worker. Caveats:
  tunnels created on Fly do not exist on the Worker (their clients get 404 on
  the bridge and keep retrying until rolled forward again), and certificates
  renewed on Fly are unknown to the Worker (the clients keep the newer one,
  which stays valid). To keep those, export from Fly (`fly_admin export`) before
  rolling back; nothing imports into the Worker, so the safest course after
  step 8 is to fix forward.
