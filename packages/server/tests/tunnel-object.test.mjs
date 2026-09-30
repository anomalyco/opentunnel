import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { BridgeProtocol } from "@opentunnel/protocol/bridge-protocol";
import { hashToken } from "../src/crypto.ts";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(ctx, env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  env: {},
}));
const { TunnelObject } = await import("../src/tunnel-object.ts");

let clock;
afterEach(() => clock?.mockRestore());

class Bridge {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  sent = [];
  serializations = 0;
  close = mock(() => {
    // Leave OPEN to model a close handshake that has not released the socket yet.
    this.attachedWhenClosed = this.attachment.attached;
  });

  constructor(attachment = { kind: "bridge", attached: false }) {
    this.attachment = structuredClone(attachment);
  }
  serializeAttachment(value) {
    this.serializations++;
    this.attachment = structuredClone(value);
  }
  deserializeAttachment() {
    return structuredClone(this.attachment);
  }
  send(value) {
    this.sent.push(value);
  }
  controls() {
    return this.sent.filter((value) => typeof value === "string").map(JSON.parse);
  }
}

async function fixture(bridges) {
  const records = new Map([["tunnel", {
    id: "test-tunnel",
    hostname: "test.example.com",
    tokenHash: await hashToken("test-token"),
    state: "online",
    certificate: { state: { type: "ready" } },
  }]]);
  const ctx = {
    getWebSockets: () => bridges,
    storage: {
      get: async (key) => records.get(key),
      put: async (key, value) => records.set(key, value),
    },
  };
  return { object: new TunnelObject(ctx, {}), ctx, records };
}

function attached(lastSeen, routes = ["@"]) {
  return new Bridge({ kind: "bridge", attached: true, session: "old-session", routes, lastSeen });
}

async function attach(object, bridges, routes = ["@"]) {
  const bridge = new Bridge();
  bridges.push(bridge);
  await object.webSocketMessage(bridge, JSON.stringify({ type: "attach", token: "test-token", routes }));
  return bridge;
}

function tcp(hostname = "test.example.com") {
  const uint16 = (n) => [n >> 8, n & 255];
  const name = [...new TextEncoder().encode(hostname)];
  const names = [0, ...uint16(name.length), ...name];
  const sni = [...uint16(names.length), ...names];
  const extensions = [0, 0, ...uint16(sni.length), ...sni];
  const hello = [3, 3, ...new Array(32).fill(0), 0, 0, 2, 0x13, 1, 1, 0, ...uint16(extensions.length), ...extensions];
  const handshake = [1, 0, ...uint16(hello.length), ...hello];
  const bytes = Uint8Array.from([0x16, 3, 3, ...uint16(handshake.length), ...handshake]);
  const cancelled = mock();
  const aborted = mock();
  return {
    opened: Promise.resolve({ remoteAddress: "127.0.0.1" }),
    readable: new ReadableStream({ start: (controller) => controller.enqueue(bytes), cancel: cancelled }),
    writable: new WritableStream({ abort: aborted }),
    close: mock(async () => {}),
    cancelled,
    aborted,
  };
}

async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("Expected server event did not occur");
}

describe("bridge leases", () => {
  test("reclaims a stale competing route before close and cancels only its TCP channels", async () => {
    let now = 100_000;
    clock = spyOn(Date, "now").mockImplementation(() => now);
    const old = attached(now);
    const healthy = attached(now, ["other"]);
    const bridges = [old, healthy];
    const { object, records } = await fixture(bridges);
    const oldTcp = tcp();
    const healthyTcp = tcp("other.test.example.com");
    let oldDone = false;
    const oldConnection = object.connect(oldTcp).then(() => { oldDone = true; });
    const healthyConnection = object.connect(healthyTcp);
    await until(() => old.controls().some((control) => control.type === "open") && healthy.controls().some((control) => control.type === "open"));

    now += 45_001;
    await object.webSocketMessage(healthy, JSON.stringify({ type: "ping", time_sent: 0 }));
    const replacement = await attach(object, bridges);
    expect(replacement.attachment.attached).toBe(true);
    expect(old.attachment.attached).toBe(false);
    expect(old.attachedWhenClosed).toBe(false);
    await until(() => oldDone);
    await oldConnection;
    expect(oldTcp.cancelled).toHaveBeenCalledTimes(1);
    expect(oldTcp.aborted).toHaveBeenCalledTimes(1);
    expect(healthyTcp.cancelled).not.toHaveBeenCalled();
    expect(healthy.close).not.toHaveBeenCalled();
    expect(old.controls().filter((control) => control.type === "end" || control.type === "reset")).toEqual([]);

    await object.webSocketClose(old);
    expect(records.get("tunnel").state).toBe("online");
    const conn = healthy.controls().find((control) => control.type === "open").conn;
    await object.webSocketMessage(healthy, JSON.stringify({ type: "reset", conn }));
    await healthyConnection;
  });

  test("healthy heartbeats retain ownership using server time, not echoed client time", async () => {
    let now = 100_000;
    clock = spyOn(Date, "now").mockImplementation(() => now);
    const old = attached(now);
    const bridges = [old];
    const { object } = await fixture(bridges);
    for (let i = 0; i < 4; i++) {
      now += 15_000;
      await object.webSocketMessage(old, JSON.stringify({ type: "ping", time_sent: 9_999_999_999 }));
      expect(old.attachment.lastSeen).toBe(now);
      const competitor = await attach(object, bridges);
      expect(competitor.controls()[0]).toEqual({ type: "attach_error", code: "route_conflict" });
    }
    expect(old.close).not.toHaveBeenCalled();
    expect(old.controls()[0]).toEqual({ type: "pong", time_sent: 9_999_999_999 });
    now += 45_000;
    expect((await attach(object, bridges)).attachment.attached).toBe(true);
  });

  test("checkpoints data activity without serializing every frame", async () => {
    let now = 100_000;
    clock = spyOn(Date, "now").mockImplementation(() => now);
    const old = attached(now);
    const { object } = await fixture([old]);
    const frame = BridgeProtocol.buildDataFrame(1, new Uint8Array([7])).buffer;
    for (let i = 0; i < 100; i++) {
      now += 100;
      await object.webSocketMessage(old, frame);
    }
    expect(old.serializations).toBe(0);
    now += 5_000;
    await object.webSocketMessage(old, frame);
    expect(old.serializations).toBe(1);
    expect(old.attachment.lastSeen).toBe(now);
  });

  test("legacy attachments get one persisted grace period across object reconstruction", async () => {
    let now = 100_000;
    clock = spyOn(Date, "now").mockImplementation(() => now);
    const old = attached(undefined);
    const bridges = [old];
    const { object, ctx } = await fixture(bridges);
    expect((await attach(object, bridges)).controls()[0].code).toBe("route_conflict");
    expect(old.attachment.lastSeen).toBe(100_000);
    now += 30_000;
    const restored = new TunnelObject(ctx, {});
    expect((await attach(restored, bridges)).controls()[0].code).toBe("route_conflict");
    expect(old.attachment.lastSeen).toBe(100_000);
    now += 15_000;
    expect((await attach(new TunnelObject(ctx, {}), bridges)).attachment.attached).toBe(true);
    expect(old.attachedWhenClosed).toBe(false);
  });

  test("TCP routing lazily expires a stale bridge and rejects closing bridges", async () => {
    clock = spyOn(Date, "now").mockReturnValue(145_000);
    for (const state of [WebSocket.OPEN, WebSocket.CLOSING]) {
      const old = attached(state === WebSocket.OPEN ? 100_000 : 145_000);
      old.readyState = state;
      const { object } = await fixture([old]);
      const connection = tcp();
      await object.connect(connection);
      expect(connection.close).toHaveBeenCalledTimes(1);
      expect(old.attachment.attached).toBe(false);
      expect(old.sent).toEqual([]);
    }
  });

  test("TCP lookup starts the legacy grace period without detaching a healthy bridge", async () => {
    clock = spyOn(Date, "now").mockReturnValue(100_000);
    const old = attached(undefined);
    const { object } = await fixture([old]);
    const connection = tcp();
    const done = object.connect(connection);
    await until(() => old.controls().some((control) => control.type === "open"));
    expect(old.attachment.lastSeen).toBe(100_000);
    expect(old.close).not.toHaveBeenCalled();
    const conn = old.controls().find((control) => control.type === "open").conn;
    await object.webSocketMessage(old, JSON.stringify({ type: "reset", conn }));
    await done;
  });
});
