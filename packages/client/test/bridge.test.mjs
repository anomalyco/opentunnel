import { afterAll, beforeAll, expect, test, spyOn } from "bun:test";
import { Effect, Exit } from "effect";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Net from "node:net";
import * as TLS from "node:tls";
import { request } from "node:https";
import WebSocket from "ws-node";
import { BridgeProtocol } from "@opentunnel/protocol/bridge-protocol";
import { connectBridge } from "../src/effect/bridge.ts";
import { OpenTunnelClient } from "../src/effect/client.ts";
import { OpenTunnelStorage } from "../src/effect/storage.ts";

let identity;
let fixture;
beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), "opentunnel-test-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=diagnostic.example", "-keyout", join(fixture, "key.pem"), "-out", join(fixture, "cert.pem")], { stdio: "ignore" });
  identity = {
    id: "diagnostic", hostname: "diagnostic.example", token: "synthetic-test-token",
    privateKey: readFileSync(join(fixture, "key.pem"), "utf8"),
    certificate: readFileSync(join(fixture, "cert.pem"), "utf8"), chain: "",
    certificateExpiry: new Date(Date.now() + 86_400_000),
  };
});
afterAll(() => rmSync(fixture, { recursive: true, force: true }));

function harness({ attach, control, fetch } = {}) {
  const peers = new Set();
  const publicSockets = new Map();
  const requests = [];
  let client;
  let sequence = 1;
  const upstreams = ["app", "api"].map((name) => Bun.serve({
    hostname: "127.0.0.1", port: 0, fetch: fetch ?? (() => new Response(name)),
  }));
  const send = WebSocket.prototype.send;
  const capture = spyOn(WebSocket.prototype, "send").mockImplementation(function (...args) {
    client = this;
    return send.apply(this, args);
  });
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname.endsWith("/certificate")) {
        requests.push(request.url);
        return Response.json({ id: "cert_diagnostic", state: {
          type: "ready", certificate: identity.certificate, chain: "", expiry: identity.certificateExpiry.toISOString(),
        } });
      }
      return server.upgrade(request, { headers: { "Sec-WebSocket-Protocol": "opentunnel" } })
        ? undefined : new Response("", { status: 400 });
    },
    websocket: {
      open(socket) { peers.add(socket); },
      close(socket) { peers.delete(socket); },
      drain() { for (const socket of publicSockets.values()) socket.resume(); },
      message(socket, data) {
        if (typeof data !== "string") {
          const frame = BridgeProtocol.parseDataFrame(data);
          if (frame) publicSockets.get(frame.conn)?.write(frame.payload);
          return;
        }
        const message = JSON.parse(data);
        if (message.type === "attach") {
          if (attach) attach(socket);
          else socket.send(JSON.stringify({ type: "attached" }));
        } else if (control) control(socket, message);
        else if (message.type === "ping") socket.send(JSON.stringify({ type: "pong", time_sent: message.time_sent }));
        if (message.type === "end") publicSockets.get(message.conn)?.end();
        if (message.type === "reset") publicSockets.get(message.conn)?.destroy();
      },
    },
  });
  const gateways = ["app", "api"].map((name) => Net.createServer((socket) => {
    const conn = sequence++;
    publicSockets.set(conn, socket);
    const peer = [...peers][0];
    peer.send(JSON.stringify({ type: "open", conn, sni: `${name}.diagnostic.example` }));
    socket.on("data", (data) => {
      peer.send(BridgeProtocol.buildDataFrame(conn, data));
      if (peer.bufferedAmount >= 1024 * 1024) socket.pause();
    });
    socket.on("end", () => peer.send(JSON.stringify({ type: "end", conn })));
    socket.on("error", () => {});
    socket.on("close", () => publicSockets.delete(conn));
  }));
  const options = {
    api: new URL(`http://127.0.0.1:${server.port}`), identity,
    routes: ["app", "api"].map((name, i) => ({ name, hostname: `${name}.diagnostic.example`, target: `127.0.0.1:${upstreams[i].port}` })),
  };
  return {
    options, peers, requests,
    get client() { return client; },
    async listen() {
      await Promise.all(gateways.map((gateway) => new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve))));
    },
    request(index = 0, body) {
      return new Promise((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port: gateways[index].address().port,
          servername: options.routes[index].hostname, rejectUnauthorized: false, agent: false,
          method: body ? "POST" : "GET", headers: body ? { "content-length": body.length } : undefined }, (response) => {
          let body = "";
          response.on("data", (chunk) => body += chunk);
          response.on("end", () => resolve(body));
          response.on("error", reject);
        });
        req.on("error", reject);
        req.setTimeout(2000, () => req.destroy(new Error("Test request timed out")));
        req.end(body);
      });
    },
    halfClose(body) {
      return new Promise((resolve, reject) => {
        const client = TLS.connect({ host: "127.0.0.1", port: gateways[0].address().port,
          servername: options.routes[0].hostname, rejectUnauthorized: false, allowHalfOpen: true });
        client.on("error", reject);
        client.on("data", () => {});
        client.on("end", resolve);
        client.setTimeout(2000, () => client.destroy(new Error("Half-close test timed out")));
        client.once("secureConnect", () => client.end(Buffer.concat([
          Buffer.from(`POST / HTTP/1.1\r\nHost: app.diagnostic.example\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`), body,
        ])));
      });
    },
    close() {
      capture.mockRestore();
      for (const socket of publicSockets.values()) socket.destroy();
      for (const gateway of gateways) gateway.close();
      for (const upstream of upstreams) upstream.stop(true);
      server.stop(true);
    },
  };
}

test("transport errors after attachment and during teardown do not crash", async () => {
  const h = harness();
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const connection = yield* connectBridge(h.options);
      expect(() => h.client.emit("error", new ErrorEvent("error"))).not.toThrow();
      yield* connection.closed;
      expect(() => h.client.emit("error", new ErrorEvent("error"))).not.toThrow();
    })));
  } finally { h.close(); }
});

test("failed and interrupted attachment closes the socket promptly", async () => {
  for (const attach of [socket => socket.close(1008, "rejected"), () => {}]) {
    const h = harness({ attach });
    const started = performance.now();
    try {
      const exit = await Effect.runPromiseExit(Effect.scoped(connectBridge(h.options)), { signal: AbortSignal.timeout(100) });
      expect(Exit.isFailure(exit)).toBe(true);
      expect(performance.now() - started).toBeLessThan(500);
      await Bun.sleep(20);
      expect(h.peers.size).toBe(0);
    } finally { h.close(); }
  }
});

test("one TLS listener forwards concurrent encrypted connections to the correct routes", async () => {
  const h = harness();
  const listeners = [];
  const create = TLS.createServer;
  const capture = spyOn(TLS, "createServer").mockImplementation((...args) => {
    const server = create(...args);
    listeners.push(server);
    return server;
  });
  try {
    await h.listen();
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* connectBridge(h.options);
      const bodies = yield* Effect.promise(() => Promise.all(Array.from({ length: 12 }, (_, i) => h.request(i % 2))));
      expect(bodies).toEqual(Array.from({ length: 12 }, (_, i) => i % 2 ? "api" : "app"));
      expect(listeners.filter(listener => listener.listening).length).toBe(1);
    })));
    expect(listeners.every(listener => !listener.listening)).toBe(true);
  } finally { capture.mockRestore(); h.close(); }
});

test("certificate validation happens once for two routes and once on reconnect", async () => {
  const h = harness();
  const storage = OpenTunnelStorage.memory();
  try {
    await Effect.runPromise(Effect.gen(function* () {
      yield* storage.save("diagnostic", identity);
      const client = yield* OpenTunnelClient;
      for (const route of h.options.routes) yield* client.route.add({ profile: "diagnostic", name: route.name, target: route.target });
      expect(h.requests.length).toBe(0);
      yield* Effect.scoped(client.tunnel.connect({ profile: "diagnostic" }));
      expect(h.requests.length).toBe(1);
      yield* Effect.scoped(client.tunnel.connect({ profile: "diagnostic" }));
      expect(h.requests.length).toBe(2);
    }).pipe(Effect.provide(OpenTunnelClient.layer({ api: h.options.api, storage }))));
  } finally { h.close(); }
});

test("explicit connection close releases listeners even while the caller scope stays open", async () => {
  const h = harness();
  const listeners = [];
  const create = TLS.createServer;
  const capture = spyOn(TLS, "createServer").mockImplementation((...args) => {
    const listener = create(...args);
    listeners.push(listener);
    return listener;
  });
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      for (let i = 0; i < 3; i++) {
        const connection = yield* connectBridge(h.options);
        yield* connection.close;
        yield* connection.closed;
        expect(listeners.every(listener => !listener.listening)).toBe(true);
      }
    })));
  } finally { capture.mockRestore(); h.close(); }
});

test("TLS transport half-close delivers all queued request bytes to the upstream", async () => {
  let received;
  const completed = new Promise(resolve => received = resolve);
  const h = harness({ async fetch(request) {
    const bytes = await request.arrayBuffer();
    received(bytes.byteLength);
    return new Response("complete");
  } });
  try {
    await h.listen();
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* connectBridge(h.options);
      const body = Buffer.alloc(4 * 1024 * 1024, 8);
      yield* Effect.promise(() => h.halfClose(body));
      expect(yield* Effect.promise(() => completed)).toBe(body.length);
    })));
  } finally { h.close(); }
});

test("a silent bridge times out, but timely pongs keep a bridge alive", async () => {
  const timing = { ...BridgeProtocol.BridgeTiming };
  BridgeProtocol.BridgeTiming.HEARTBEAT_MS = 20;
  BridgeProtocol.BridgeTiming.IDLE_TIMEOUT_MS = 80;
  try {
    for (const silent of [true, false]) {
      const h = harness(silent ? { control() {} } : {});
      try {
        await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
          const connection = yield* connectBridge(h.options);
          if (silent) yield* connection.closed;
          else {
            yield* Effect.sleep(140);
            expect(h.peers.size).toBe(1);
          }
        })));
      } finally { h.close(); }
    }
  } finally { Object.assign(BridgeProtocol.BridgeTiming, timing); }
});

test("valid TLS uploads to a slow target drain without resetting the channel", async () => {
  let paused = false;
  const pause = WebSocket.prototype.pause;
  const capture = spyOn(WebSocket.prototype, "pause").mockImplementation(function () {
    pause.call(this);
    paused ||= this.isPaused;
  });
  const h = harness({ async fetch(request) {
    if (!request.body) return new Response("app");
    const reader = request.body.getReader();
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      await Bun.sleep(1);
    }
    return new Response(String(size));
  } });
  try {
    await h.listen();
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* connectBridge(h.options);
      const body = Buffer.alloc(8 * 1024 * 1024, 7);
      expect(yield* Effect.promise(() => h.request(0, body))).toBe(String(body.length));
      expect(paused).toBe(true);
      expect(yield* Effect.promise(() => h.request())).toBe("app");
    })));
  } finally { capture.mockRestore(); h.close(); }
});

test("a paused network peer backpressures TLS responses without unbounded WebSocket buffering", async () => {
  let front;
  let back;
  const size = 32 * 1024 * 1024;
  const h = harness({ fetch() {
    front.pause();
    return new Response(Buffer.alloc(size, "x"));
  } });
  const destination = Number(h.options.api.port);
  const proxy = Net.createServer((socket) => {
    front = socket;
    back = Net.createConnection({ host: "127.0.0.1", port: destination });
    socket.on("error", () => {});
    back.on("error", () => {});
    socket.pipe(back).pipe(socket);
  });
  try {
    await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
    h.options.api = new URL(`http://127.0.0.1:${proxy.address().port}`);
    await h.listen();
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* connectBridge(h.options);
      const response = h.request();
      response.catch(() => {});
      yield* Effect.promise(async () => {
        const deadline = performance.now() + 1000;
        while (h.client.bufferedAmount < 1024 * 1024) {
          if (performance.now() > deadline) throw new Error("WebSocket did not reach its high-water mark");
          await Bun.sleep(5);
        }
        await Bun.sleep(100);
      });
      expect(h.client.readyState).toBe(WebSocket.OPEN);
      expect(h.client.bufferedAmount).toBeLessThan(2 * 1024 * 1024);
      front.resume();
      expect((yield* Effect.promise(() => response)).length).toBe(size);
    })));
  } finally {
    front?.destroy();
    back?.destroy();
    await new Promise(resolve => proxy.close(resolve));
    h.close();
  }
}, 10_000);
