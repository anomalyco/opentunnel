import { describe, expect, mock, test } from "bun:test";

const records = new Map<string, unknown>([["abc", { version: 1, id: "abc", tokenHash: "00" }]]);
const handedOff: string[] = [];
const id = (value: string) => ({ toString: () => value });
const env = {
  ADMIN_EXPORT_TOKEN: "secret",
  TUNNELS: {
    idFromString: (value: string) => id(value),
    idFromName: (name: string) => id(`hex-${name}`),
    get: (objectId: { toString(): string }) => {
      const name = objectId.toString().replace(/^hex-/, "");
      return {
        exportRecord: async () => ({ record: records.get(name) ?? null, alarm: records.has(name) ? 5 : null }),
        handoff: async () => {
          handedOff.push(name);
          return 2;
        },
      };
    },
  },
};
mock.module("cloudflare:workers", () => ({ DurableObject: class {}, env, waitUntil: () => {} }));

const { handleAdmin } = await import("../src/admin-export.js");

const post = (path: string, body: unknown, token = "secret") =>
  handleAdmin(
    new Request(`https://opentunnel.test${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

describe("admin export", () => {
  test("ignores other paths", async () => {
    expect(await handleAdmin(new Request("https://opentunnel.test/api/tunnel"))).toBeUndefined();
  });

  test("hides the endpoints without the token", async () => {
    expect((await post("/api/admin/export", { names: ["abc"] }, "wrong"))!.status).toBe(404);
    const get = await handleAdmin(new Request("https://opentunnel.test/api/admin/export"));
    expect(get!.status).toBe(404);
  });

  test("exports records by name and object ID", async () => {
    const response = (await post("/api/admin/export", { names: ["abc", "missing"], objects: ["hex-abc"] }))!;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      records: [
        { objectId: "hex-abc", record: records.get("abc"), alarm: 5 },
        { objectId: "hex-abc", name: "abc", record: records.get("abc"), alarm: 5 },
        { objectId: "hex-missing", name: "missing", record: null, alarm: null },
      ],
    });
  });

  test("rejects malformed and oversized requests", async () => {
    expect((await post("/api/admin/export", { names: [1] }))!.status).toBe(400);
    expect((await post("/api/admin/export", { names: Array(101).fill("a") }))!.status).toBe(400);
  });

  test("hands off bridges", async () => {
    const response = (await post("/api/admin/handoff", { names: ["abc"] }))!;
    expect(await response.json()).toEqual({ results: [{ objectId: "hex-abc", name: "abc", closed: 2 }] });
    expect(handedOff).toEqual(["abc"]);
  });
});
