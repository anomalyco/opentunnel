// TEMPORARY (migration to the Fly server, see docs/cutover.md): read-only export of tunnel records and the bridge
// handoff, both behind the ADMIN_EXPORT_TOKEN bearer secret. Remove once the Worker is decommissioned.
import { env } from "cloudflare:workers";
import { hashToken } from "./crypto.js";

const MAX_TARGETS = 100;

interface Targets {
  readonly objects?: ReadonlyArray<string>;
  readonly names?: ReadonlyArray<string>;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Compares hashes so the comparison takes the same time for every wrong token. */
const authorized = async (request: Request): Promise<boolean> => {
  const secret = env.ADMIN_EXPORT_TOKEN;
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const token = /^bearer /i.test(header) ? header.slice(7) : "";
  const [expected, actual] = await Promise.all([hashToken(secret), hashToken(token)]);
  let difference = 0;
  for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  return difference === 0;
};

const stubs = (targets: Targets) => [
  ...(targets.objects ?? []).map((objectId) => {
    const id = env.TUNNELS.idFromString(objectId);
    return { objectId: id.toString(), name: undefined as string | undefined, stub: env.TUNNELS.get(id) };
  }),
  ...(targets.names ?? []).map((name) => {
    const id = env.TUNNELS.idFromName(name);
    return { objectId: id.toString(), name, stub: env.TUNNELS.get(id) };
  }),
];

const parseTargets = async (request: Request): Promise<Targets | undefined> => {
  try {
    const body = (await request.json()) as Targets;
    const strings = (value: unknown) =>
      value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"));
    if (!strings(body.objects) || !strings(body.names)) return undefined;
    if ((body.objects?.length ?? 0) + (body.names?.length ?? 0) > MAX_TARGETS) return undefined;
    return body;
  } catch {
    return undefined;
  }
};

/** Handles `/api/admin/*`, or returns undefined for any other path. */
export async function handleAdmin(request: Request): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/admin/")) return undefined;
  if (request.method !== "POST" || !(await authorized(request))) return new Response(null, { status: 404 });
  const targets = await parseTargets(request);
  if (!targets) return json({ error: `expected { objects?: string[], names?: string[] } with at most ${MAX_TARGETS} entries` }, 400);
  if (url.pathname === "/api/admin/export") {
    const records = await Promise.all(
      stubs(targets).map(async ({ objectId, name, stub }) => ({
        objectId,
        ...(name ? { name } : {}),
        ...(await stub.exportRecord()),
      })),
    );
    return json({ records });
  }
  if (url.pathname === "/api/admin/handoff") {
    const results = await Promise.all(
      stubs(targets).map(async ({ objectId, name, stub }) => ({
        objectId,
        ...(name ? { name } : {}),
        closed: await stub.handoff(),
      })),
    );
    return json({ results });
  }
  return new Response(null, { status: 404 });
}
