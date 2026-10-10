#!/usr/bin/env bun
// TEMPORARY (migration from the Cloudflare Worker to the Fly server, see docs/cutover.md).
//
//   bun migration/worker.ts export <file>   every tunnel record, for `opentunnel-server import <file>`
//   bun migration/worker.ts handoff         close every bridge on the Worker so clients reconnect to Fly
//
// Lists the TunnelObject Durable Objects with the Cloudflare REST API and calls the Worker's temporary
// /api/admin/* endpoints (packages/server/src/admin-export.ts on the migration patch) for them in batches.
//
// Environment:
//   CLOUDFLARE_API_TOKEN   token with "Workers Scripts: Read" on the account (lists Durable Objects)
//   ADMIN_EXPORT_TOKEN     the Worker's ADMIN_EXPORT_TOKEN secret
//   WORKER_URL             the Worker, e.g. https://opentunnel.xyz or its workers.dev URL
//   CLOUDFLARE_ACCOUNT_ID  default 15d29c8639fd3733b1b5486a2acfd968
//   DO_NAMESPACE_ID        default ced86e42c2644cc9bce4d8db0bc245c4 (opentunnel-production TunnelObject)

const BATCH = 50;
const command = process.argv[2];

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "15d29c8639fd3733b1b5486a2acfd968";
const namespace = process.env.DO_NAMESPACE_ID ?? "ced86e42c2644cc9bce4d8db0bc245c4";

interface ObjectListing {
  readonly success: boolean;
  readonly errors?: ReadonlyArray<{ readonly message: string }>;
  readonly result: ReadonlyArray<{ readonly id: string; readonly hasStoredData: boolean }>;
  readonly result_info?: { readonly cursor?: string; readonly count?: number };
}

async function listObjects(): Promise<string[]> {
  const token = required("CLOUDFLARE_API_TOKEN");
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const url = new URL(
      `https://api.cloudflare.com/client/v4/accounts/${account}/workers/durable_objects/namespaces/${namespace}/objects`,
    );
    url.searchParams.set("limit", "10000");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    const body = (await response.json()) as ObjectListing;
    if (!response.ok || !body.success) {
      throw new Error(`listing Durable Objects failed: ${body.errors?.map((error) => error.message).join(", ")}`);
    }
    for (const object of body.result) if (object.hasStoredData) ids.push(object.id);
    cursor = body.result_info?.cursor || undefined;
  } while (cursor);
  return ids;
}

async function admin<T>(path: string, targets: { objects?: string[]; names?: string[] }): Promise<T> {
  const base = required("WORKER_URL").replace(/\/$/, "");
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${required("ADMIN_EXPORT_TOKEN")}`, "content-type": "application/json" },
      body: JSON.stringify(targets),
    });
    if (response.ok) return (await response.json()) as T;
    const text = await response.text();
    if (attempt >= 3 || response.status === 404 || response.status === 400) {
      throw new Error(`${path} failed: HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    await Bun.sleep(1_000 * attempt);
  }
}

const batches = <A>(items: ReadonlyArray<A>) =>
  Array.from({ length: Math.ceil(items.length / BATCH) }, (_, index) => items.slice(index * BATCH, (index + 1) * BATCH));

const targets = (objects: string[]) => {
  // Single tunnels can be named on the command line instead: `export <file> <id> <id>...`.
  const names = process.argv.slice(command === "export" ? 4 : 3);
  return names.length > 0 ? { names } : { objects };
};

if (command === "export") {
  const file = process.argv[3];
  if (!file) throw new Error("usage: bun migration/worker.ts export <file> [tunnel-id...]");
  const named = process.argv.length > 4;
  const objects = named ? [] : await listObjects();
  console.error(named ? "exporting named tunnels" : `${objects.length} Durable Objects with stored data`);
  const chosen = targets(objects);
  const list = chosen.names ?? chosen.objects;
  const records: unknown[] = [];
  for (const batch of batches(list)) {
    const body = await admin<{ records: Array<{ record: unknown }> }>(
      "/api/admin/export",
      chosen.names ? { names: batch } : { objects: batch },
    );
    records.push(...body.records.filter((entry) => entry.record));
    console.error(`exported ${records.length}`);
  }
  await Bun.write(file, JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), records }, null, 2) + "\n");
  console.error(`wrote ${records.length} records to ${file}`);
} else if (command === "handoff") {
  const named = process.argv.length > 3;
  const chosen = targets(named ? [] : await listObjects());
  const list = chosen.names ?? chosen.objects;
  let closed = 0;
  for (const batch of batches(list)) {
    const body = await admin<{ results: Array<{ closed: number }> }>(
      "/api/admin/handoff",
      chosen.names ? { names: batch } : { objects: batch },
    );
    for (const result of body.results) closed += result.closed;
  }
  console.error(`closed ${closed} bridges on ${list.length} tunnels`);
} else {
  console.error("usage: bun migration/worker.ts export <file> [tunnel-id...] | handoff [tunnel-id...]");
  process.exit(1);
}
