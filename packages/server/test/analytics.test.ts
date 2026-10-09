import { beforeEach, describe, expect, mock, test } from "bun:test";

const sent: unknown[][] = [];
const pending: Promise<unknown>[] = [];
const workers = {
  DurableObject: class {
    constructor(readonly ctx: unknown, readonly env: unknown) {}
  },
  env: { EVENTS: { send: async (records: unknown[]) => void sent.push(records) } } as {
    EVENTS?: { send(records: unknown[]): Promise<void> };
  },
  waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
};
mock.module("cloudflare:workers", () => workers);

const { Analytics } = await import("../src/analytics.js");

beforeEach(() => {
  sent.length = 0;
  pending.length = 0;
  workers.env.EVENTS = { send: async (records) => void sent.push(records) };
});

describe("analytics", () => {
  test("builds the platform envelope", () => {
    const event = Analytics.event(
      "connection.closed",
      { tunnel_id: "abc", outcome: "closed", duration_ms: 12, bytes_in: 3, bytes_out: 4 },
      new Date("2026-10-07T12:00:00.000Z"),
    );
    expect(event).toEqual({
      source: "opentunnel",
      type: "connection.closed",
      timestamp: "2026-10-07T12:00:00.000Z",
      payload: { schema_version: 1, tunnel_id: "abc", outcome: "closed", duration_ms: 12, bytes_in: 3, bytes_out: 4 },
    });
  });

  test("publishes one record without blocking", async () => {
    Analytics.publish("tunnel.deleted", { tunnel_id: "abc", age_ms: 5 });
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject([{ source: "opentunnel", type: "tunnel.deleted", payload: { tunnel_id: "abc" } }]);
  });

  test("drops events when the binding fails or is missing", async () => {
    const error = console.error;
    console.error = () => undefined;
    try {
      workers.env.EVENTS = { send: async () => { throw new Error("stream unavailable"); } };
      Analytics.publish("tunnel.deleted", { tunnel_id: "abc", age_ms: 5 });
      workers.env.EVENTS = undefined;
      Analytics.publish("tunnel.deleted", { tunnel_id: "abc", age_ms: 5 });
      await expect(Promise.all(pending)).resolves.toBeDefined();
    } finally {
      console.error = error;
    }
  });

  test("classifies clients by user agent", () => {
    expect(Analytics.client("opentunnel/0.4.1")).toEqual({ client: "cli", client_version: "0.4.1" });
    expect(Analytics.client("opentunnel-sdk/0.1.2")).toEqual({ client: "sdk", client_version: "0.1.2" });
    expect(Analytics.client("Bun/1.4.2")).toEqual({ client: "sdk" });
    expect(Analytics.client("Mozilla/5.0 (X11)")).toEqual({ client: "other" });
    expect(Analytics.client(undefined)).toEqual({ client: "none" });
    expect(Analytics.client("")).toEqual({ client: "none" });
  });

  test("keeps only country and colo from request metadata", () => {
    const request = { cf: { country: "DE", colo: "FRA", city: "Berlin", asn: 1 } } as unknown as Request;
    expect(Analytics.geo(request)).toEqual({ country: "DE", colo: "FRA" });
    expect(Analytics.geo({} as Request)).toEqual({});
  });

  test("buckets certificate failures", () => {
    expect(Analytics.certificateFailure("ACME_EAB_KID and ACME_EAB_HMAC_KEY are required")).toBe("config");
    expect(Analytics.certificateFailure("rateLimited | HTTP 429 | too many")).toBe("acme_rate_limit");
    expect(Analytics.certificateFailure("DNS record creation failed")).toBe("dns");
    expect(Analytics.certificateFailure("ACME authorization ended in invalid")).toBe("acme_authorization");
    expect(Analytics.certificateFailure("ACME order ended in invalid")).toBe("acme_order");
    expect(Analytics.certificateFailure("badNonce | HTTP 400")).toBe("acme_http");
    expect(Analytics.certificateFailure("Failed to persist certificate state: tunnel or certificate not found"))
      .toBe("persist");
    expect(Analytics.certificateFailure("socket hang up")).toBe("other");
  });
});
