import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ApiRetry } from "@opentunnel/protocol/api-retry";
import { create, OpenTunnelStorage, type OpenTunnelPromiseClient } from "../src/promise/index.js";
import { testIdentity } from "./fake-relay.js";

/** Answers each request with the next status (an error page, `Retry-After: 0`), then with the identity's certificate. */
const flakyApi = (statuses: number[], certificate: () => string) => {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      const status = statuses[seen.length];
      seen.push(`${request.method} ${url.pathname}`);
      if (status !== undefined) {
        return new Response(`<html>error code: ${status}</html>`, {
          status,
          headers: { "content-type": "text/html", "retry-after": "0" },
        });
      }
      return Response.json({
        id: "cert",
        state: {
          type: "ready",
          certificate: certificate(),
          chain: "",
          expiry: new Date(Date.now() + 86_400_000).toISOString(),
        },
      });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) };
};

let identity: Awaited<ReturnType<typeof testIdentity>>;
let store: ReturnType<typeof OpenTunnelStorage.memory>;
let api: ReturnType<typeof flakyApi> | undefined;
let client: OpenTunnelPromiseClient | undefined;

const start = (statuses: number[]) => {
  api = flakyApi(statuses, () => identity.certificate);
  client = create({ api: api.url, store });
  return { api, client };
};

beforeEach(async () => {
  identity = await testIdentity();
  store = OpenTunnelStorage.memory();
  await store.save("default", identity);
});

afterEach(async () => {
  await client?.dispose();
  api?.stop();
});

describe("API requests", () => {
  test("are retried after transient failures", async () => {
    const { api, client } = start([525, 502, 429]);
    const ensured = await client.tunnel.ensure();
    expect(ensured.certificate).toBe(identity.certificate);
    expect(api.seen).toHaveLength(4);
  });

  test("are not retried after client errors", async () => {
    const { api, client } = start([401]);
    await expect(client.tunnel.ensure()).rejects.toThrow("Failed to read certificate");
    expect(api.seen).toHaveLength(1);
  });

  test("keep a valid saved certificate while the API keeps failing", async () => {
    const { api, client } = start(Array(20).fill(525));
    const ensured = await client.tunnel.ensure();
    expect(ensured.certificate).toBe(identity.certificate);
    expect(api.seen).toHaveLength(ApiRetry.RETRIES + 1);
  });

  test("fail with the HTTP status and Cloudflare's meaning of it", async () => {
    await store.save("default", { ...identity, certificateExpiry: new Date(Date.now() - 1000) });
    const { client } = start(Array(20).fill(525));
    await expect(client.tunnel.ensure()).rejects.toThrow(
      "Failed to read certificate: Cloudflare 525: the SSL handshake with the server failed (HTTP 525)",
    );
  });

  test("create a tunnel again only when the first attempt cannot have arrived", async () => {
    await store.remove("default");
    const { api, client } = start([525, 520]);
    await expect(client.tunnel.create()).rejects.toThrow(
      "Failed to create tunnel: Cloudflare 520: the server returned an unknown error (HTTP 520)",
    );
    expect(api.seen).toEqual(["POST /api/tunnel", "POST /api/tunnel"]);
  });

  test("go to OPENTUNNEL_API when no api option is passed", async () => {
    api = flakyApi([], () => identity.certificate);
    const previous = process.env.OPENTUNNEL_API;
    process.env.OPENTUNNEL_API = api.url;
    try {
      client = create({ store });
    } finally {
      if (previous === undefined) delete process.env.OPENTUNNEL_API;
      else process.env.OPENTUNNEL_API = previous;
    }
    await client.tunnel.ensure();
    expect(api.seen).toHaveLength(1);
  });
});
