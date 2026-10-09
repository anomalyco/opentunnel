import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { BridgeProtocol } from "@opentunnel/protocol/bridge-protocol";
import { hashToken } from "../src/crypto.js";

const published: { type: string; payload: Record<string, unknown> }[] = [];
mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  env: { EVENTS: { send: async (records: typeof published) => void published.push(...records) } },
  waitUntil: (promise: Promise<unknown>) => void promise,
}));

const { TunnelObject } = await import("../src/tunnel-object.js");

const HOSTNAME = "abc.opentunnel.test";
const STALE_MS = BridgeProtocol.BridgeTiming.IDLE_TIMEOUT_MS + BridgeProtocol.BridgeTiming.HEARTBEAT_MS;

let now = 1_000_000;
beforeEach(() => {
  now = 1_000_000;
  published.length = 0;
  spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => mock.restore());

class FakeBridge {
  readyState: number = WebSocket.OPEN;
  sent: unknown[] = [];
  serializations = 0;
  closed: [number, string] | undefined;
  attachment: Record<string, unknown>;

  constructor(attachment: Record<string, unknown> = { kind: "bridge", attached: false }) {
    this.attachment = structuredClone(attachment);
  }
  serializeAttachment(value: Record<string, unknown>) {
    this.serializations++;
    this.attachment = structuredClone(value);
  }
  deserializeAttachment() {
    return structuredClone(this.attachment);
  }
  send(value: unknown) {
    this.sent.push(value);
  }
  // A vanished client never completes the close handshake, so the socket stays open.
  close(code: number, reason: string) {
    this.closed = [code, reason];
  }
  controls() {
    return this.sent.filter((value): value is string => typeof value === "string").map((value) => JSON.parse(value));
  }
}

const attachedBridge = (routes: string[], seenAt?: number) =>
  new FakeBridge({
    kind: "bridge",
    attached: true,
    session: "sess_old",
    routes,
    ...(seenAt === undefined ? {} : { seenAt }),
    analytics: { client: "sdk", tunnel: "abc", attachedAt: now, activeAt: now },
  });

async function tunnelObject(bridges: FakeBridge[]) {
  const records = new Map<string, unknown>([
    [
      "tunnel",
      {
        version: 1,
        id: "abc",
        hostname: HOSTNAME,
        tokenHash: await hashToken("token"),
        state: "online",
        createdAt: new Date(0).toISOString(),
        certificate: { id: "cert_1", state: { type: "ready", certificate: "", chain: "", expiry: "2099-01-01T00:00:00Z" } },
      },
    ],
  ]);
  const ctx = {
    getWebSockets: () => bridges,
    storage: {
      get: async (key: string) => records.get(key),
      put: async (key: string, value: unknown) => void records.set(key, value),
      getAlarm: async () => 1,
      setAlarm: async () => {},
    },
  };
  return { object: new TunnelObject(ctx as never, {} as never), records };
}

async function attach(object: InstanceType<typeof TunnelObject>, bridges: FakeBridge[], routes: string[]) {
  const bridge = new FakeBridge();
  bridges.push(bridge);
  await object.webSocketMessage(bridge as never, JSON.stringify({ type: "attach", token: "token", routes }));
  return bridge;
}

/** A public TCP connection whose ClientHello names `sni`, held open until `end()`. */
function publicConnection(sni: string) {
  const uint16 = (n: number) => [n >> 8, n & 255];
  const name = [...new TextEncoder().encode(sni)];
  const names = [0, ...uint16(name.length), ...name];
  const list = [...uint16(names.length), ...names];
  const extensions = [0, 0, ...uint16(list.length), ...list];
  const hello = [3, 3, ...new Array(32).fill(0), 0, 0, 2, 0x13, 1, 1, 0, ...uint16(extensions.length), ...extensions];
  const handshake = [1, 0, ...uint16(hello.length), ...hello];
  const record = Uint8Array.from([0x16, 3, 1, ...uint16(handshake.length), ...handshake]);
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const socket = {
    opened: Promise.resolve({ remoteAddress: "192.0.2.1" }),
    readable: new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        c.enqueue(record);
      },
    }),
    writable: new WritableStream<Uint8Array>(),
    close: mock(async () => {}),
  };
  return { socket, end: () => controller.close() };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe("stale bridges", () => {
  test("a live bridge keeps its routes", async () => {
    const live = attachedBridge(["api"], now);
    const bridges = [live];
    const { object } = await tunnelObject(bridges);

    now += STALE_MS;
    const next = await attach(object, bridges, ["api"]);

    expect(next.controls()).toEqual([{ type: "attach_error", code: "route_conflict" }]);
    expect(live.attachment.attached).toBe(true);
    expect(live.closed).toBeUndefined();
  });

  test("a silent bridge gives its routes to the next attach, even though its close never completes", async () => {
    const stale = attachedBridge(["api"], now);
    const bridges = [stale];
    const { object } = await tunnelObject(bridges);

    now += STALE_MS + 1;
    const next = await attach(object, bridges, ["api"]);

    expect(next.controls()[0]).toMatchObject({ type: "attached", routes: ["api"] });
    expect(stale.attachment.attached).toBe(false);
    expect(stale.closed).toEqual([1001, "idle timeout"]);
    await tick();
    expect(published.filter((event) => event.type === "bridge.disconnected").map((event) => event.payload)).toEqual([
      expect.objectContaining({ session_id: "sess_old", code: 1001, clean: false }),
    ]);

    // Cloudflare eventually reports the close; it was already accounted for.
    await object.webSocketClose(stale as never, 1006, "", false);
    await tick();
    expect(published.filter((event) => event.type === "bridge.disconnected")).toHaveLength(1);
  });

  test("pings and data keep a bridge live, recorded at most once per heartbeat", async () => {
    const bridge = attachedBridge(["api"], now);
    const bridges = [bridge];
    const { object } = await tunnelObject(bridges);
    const socket = bridge as never;

    for (let i = 0; i < 10; i++) {
      now += 1_000;
      await object.webSocketMessage(socket, BridgeProtocol.buildDataFrame(1, new Uint8Array([1])).buffer as ArrayBuffer);
    }
    expect(bridge.serializations).toBe(0);

    now += BridgeProtocol.BridgeTiming.HEARTBEAT_MS;
    await object.webSocketMessage(socket, JSON.stringify({ type: "ping", time_sent: now }));
    expect(bridge.attachment.seenAt).toBe(now);

    now += STALE_MS;
    const next = await attach(object, bridges, ["api"]);
    expect(next.controls()).toEqual([{ type: "attach_error", code: "route_conflict" }]);
  });

  test("bridges attached before seenAt existed get one idle period from the first check", async () => {
    const legacy = attachedBridge(["api"]);
    const bridges = [legacy];
    const { object } = await tunnelObject(bridges);

    const first = await attach(object, bridges, ["api"]);
    expect(first.controls()).toEqual([{ type: "attach_error", code: "route_conflict" }]);
    expect(legacy.attachment.seenAt).toBe(now);

    now += STALE_MS + 1;
    const second = await attach(object, bridges, ["api"]);
    expect(second.controls()[0]).toMatchObject({ type: "attached" });
  });

  test("public connections are not routed into a silent bridge, and its open connections end", async () => {
    const stale = attachedBridge(["api"], now);
    const bridges = [stale];
    const { object, records } = await tunnelObject(bridges);

    const earlier = publicConnection(`api.${HOSTNAME}`);
    const earlierDone = object.connect(earlier.socket as never);
    for (let i = 0; i < 50 && !stale.controls().some((control) => control.type === "open"); i++) await tick();
    expect(stale.controls().filter((control) => control.type === "open")).toHaveLength(1);

    now += STALE_MS + 1;
    const later = publicConnection(`api.${HOSTNAME}`);
    await object.connect(later.socket as never);

    expect(stale.controls().filter((control) => control.type === "open")).toHaveLength(1);
    expect(later.socket.close).toHaveBeenCalled();
    expect(stale.attachment.attached).toBe(false);
    expect((records.get("tunnel") as { state: string }).state).toBe("offline");

    earlier.end();
    await earlierDone;
    await tick();
    expect(
      published.filter((event) => event.type === "connection.closed").map((event) => event.payload.outcome),
    ).toEqual(["no_bridge", "bridge_disconnected"]);
  });
});
