import { expect, mock, test } from "bun:test";
import "reflect-metadata";

// Exercise the actual Durable Object entrypoints, mocking only the runtime and
// sockets. The ClientHello bytes are parsed by the production TLS parser.
mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(readonly ctx: unknown, readonly env: unknown) {}
  },
  env: { EVENTS: { send: async () => undefined } },
  waitUntil: (promise: Promise<unknown>) => void promise.catch(() => undefined),
}));
const { TunnelObject } = await import("../src/tunnel-object.js");
const { hashToken } = await import("../src/crypto.js");

class Bridge {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  attachment: Record<string, unknown> = { kind: "bridge", attached: false };
  readonly sent: Array<string | Uint8Array> = [];
  send(message: string | Uint8Array) { this.sent.push(message); }
  close() { this.readyState = WebSocket.CLOSED; }
  serializeAttachment(value: Record<string, unknown>) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return structuredClone(this.attachment); }
  opens() { return this.sent.filter((value): value is string => typeof value === "string").map((value) => JSON.parse(value)).filter((value) => value.type === "open"); }
}

function clientHello(sni: string): Uint8Array {
  const name = new TextEncoder().encode(sni);
  const u16 = (n: number) => [n >> 8, n & 255];
  const names = [0, ...u16(name.length), ...name];
  const extension = [0, 0, ...u16(names.length + 2), ...u16(names.length), ...names];
  const body = [3, 3, ...Array(32).fill(0), 0, 0, 2, 0, 47, 1, 0, ...u16(extension.length), ...extension];
  const handshake = [1, 0, ...u16(body.length), ...body];
  return Uint8Array.from([22, 3, 1, ...u16(handshake.length), ...handshake]);
}

function visitor(route: string) {
  let closed = false;
  let ended = false;
  let input!: ReadableStreamDefaultController<Uint8Array>;
  const hello = clientHello(`${route}.demo.opentunnel.xyz`);
  const socket = {
    opened: Promise.resolve({ remoteAddress: "203.0.113.9" }),
    readable: new ReadableStream<Uint8Array>({ start(controller) { input = controller; controller.enqueue(hello); } }),
    writable: new WritableStream<Uint8Array>(),
    close: async () => { closed = true; end(); },
  };
  function end() { if (!ended) { ended = true; input.close(); } }
  const fail = () => { if (!ended) { ended = true; input.error(new Error("visitor I/O failed")); } };
  return { socket, hello, end, fail, closed: () => closed };
}

async function until(check: () => boolean) {
  for (let n = 0; n < 200; n++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error("admission fixture deadline");
}

async function fixture() {
  const records = new Map<string, unknown>([["tunnel", {
    id: "demo", hostname: "demo.opentunnel.xyz", tokenHash: await hashToken("fixture-token"),
    certificate: { state: { type: "ready", expiry: "2099-01-01T00:00:00.000Z" } },
  }]]);
  const bridges: Bridge[] = [];
  const ctx = {
    storage: {
      get: async (key: string) => records.get(key),
      put: async (key: string, value: unknown) => { records.set(key, value); },
      getAlarm: async () => 1,
    },
    getWebSockets: () => bridges.filter((bridge) => bridge.readyState === WebSocket.OPEN),
  };
  const object = new TunnelObject(ctx as never, {} as never);
  const objects = [object];
  const visitors: Array<{ input: ReturnType<typeof visitor>; done: Promise<void> }> = [];
  const attach = async (route: string, capacity?: unknown) => {
    const bridge = new Bridge();
    bridges.push(bridge);
    await object.webSocketMessage(bridge as never, JSON.stringify({ type: "attach", token: "fixture-token", routes: [route],
      ...(capacity === undefined ? {} : { client: { max_conns: capacity } }),
    }));
    return bridge;
  };
  const open = (route: string, current = object) => {
    const input = visitor(route);
    const done = current.connect(input.socket as never);
    visitors.push({ input, done });
    return input;
  };
  const finish = async () => {
    for (const bridge of bridges) {
      bridge.close();
      for (const current of objects) await current.webSocketClose(bridge as never, 1000, "test cleanup", true);
    }
    for (const { input } of visitors) input.end();
    await Promise.all(visitors.map(({ done }) => done));
  };
  const restore = () => {
    const current = new TunnelObject(ctx as never, {} as never);
    objects.push(current);
    return current;
  };
  return { object, attach, open, restore, finish };
}

test("full bridges refuse visitors before sending open or ClientHello data", async () => {
  const f = await fixture();
  try {
    const bridge = await f.attach("api", 2);
    expect(bridge.attachment.maxConns).toBe(2);
    f.open("api"); f.open("api");
    await until(() => bridge.opens().length === 2);
    const sentBefore = bridge.sent.length;
    const refused = f.open("api");
    await until(() => refused.closed() || bridge.opens().length === 3);
    expect(refused.closed()).toBe(true);
    expect(bridge.sent.length).toBe(sentBefore);
  } finally { await f.finish(); }
});

test("simultaneous visitors cannot reserve the same last slot", async () => {
  const f = await fixture();
  try {
    const bridge = await f.attach("api", 2);
    const inputs = Array.from({ length: 8 }, () => f.open("api"));
    await until(() => bridge.opens().length + inputs.filter((input) => input.closed()).length === 8);
    expect(bridge.opens()).toHaveLength(2);
    expect(inputs.filter((input) => input.closed())).toHaveLength(6);
  } finally { await f.finish(); }
});

for (const type of ["end", "reset"] as const) test(`${type} frees capacity without allowing another bridge to free it`, async () => {
  const f = await fixture();
  try {
    const bridge = await f.attach("api", 1);
    const other = await f.attach("web", 1);
    const first = f.open("api");
    await until(() => bridge.opens().length === 1);
    const conn = bridge.opens()[0].conn;
    await f.object.webSocketMessage(other as never, JSON.stringify({ type, conn }));
    const refused = f.open("api");
    await until(() => refused.closed() || bridge.opens().length === 2);
    expect(refused.closed()).toBe(true);
    await f.object.webSocketMessage(bridge as never, JSON.stringify({ type, conn }));
    first.end();
    f.open("api");
    await until(() => bridge.opens().length === 2);
  } finally { await f.finish(); }
});

test("capacity is per bridge, including distinct routes on one tunnel", async () => {
  const f = await fixture();
  try {
    const api = await f.attach("api", 1);
    const web = await f.attach("web", 1);
    f.open("api");
    await until(() => api.opens().length === 1);
    f.open("web");
    await until(() => web.opens().length === 1);
    const refused = f.open("api");
    await until(() => refused.closed() || api.opens().length === 2);
    expect(refused.closed()).toBe(true);
  } finally { await f.finish(); }
});

test("bridge disconnect releases capacity for its replacement", async () => {
  const f = await fixture();
  try {
    const old = await f.attach("api", 1);
    const input = f.open("api");
    await until(() => old.opens().length === 1);
    old.close();
    await f.object.webSocketClose(old as never, 1006, "disconnected", false);
    input.end();
    const next = await f.attach("api", 1);
    f.open("api");
    await until(() => next.opens().length === 1);
  } finally { await f.finish(); }
});

test("visitor I/O failure frees capacity", async () => {
  const f = await fixture();
  try {
    const bridge = await f.attach("api", 1);
    const first = f.open("api");
    await until(() => bridge.opens().length === 1);
    first.fail();
    await until(() => bridge.sent.some((value) => typeof value === "string" && JSON.parse(value).type === "reset"));
    f.open("api");
    await until(() => bridge.opens().length === 2);
  } finally { await f.finish(); }
});

test("a restored object reads capacity from the bridge attachment", async () => {
  const f = await fixture();
  try {
    const bridge = await f.attach("api", 1);
    const restored = f.restore();
    f.open("api", restored);
    await until(() => bridge.opens().length === 1);
    const refused = f.open("api", restored);
    await until(() => refused.closed() || bridge.opens().length === 2);
    expect(refused.closed()).toBe(true);
  } finally { await f.finish(); }
});

test("attach defaults legacy clients to 256 and refuses invalid advertised capacities", async () => {
  const f = await fixture();
  try {
    const legacy = await f.attach("api");
    expect(legacy.attachment.maxConns).toBe(256);
    for (const capacity of [0, -1, 1.5, "256", null, 2 ** 32]) {
      const bridge = await f.attach("invalid", capacity);
      expect(bridge.readyState).toBe(WebSocket.CLOSED);
      expect(bridge.attachment.attached).toBe(false);
      expect(bridge.sent).toContain(JSON.stringify({ type: "attach_error", code: "bad_attach" }));
    }
  } finally { await f.finish(); }
});
