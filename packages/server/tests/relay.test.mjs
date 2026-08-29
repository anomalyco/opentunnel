import { afterEach, expect, test, spyOn } from "bun:test";
import { createConnection, createServer } from "node:net";
import { createHash } from "node:crypto";
import { once } from "node:events";
import WebSocket from "ws-node";

const cleanups = [];
let sequence = 0;
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until(predicate, timeout = 3000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("Expected local relay event did not occur");
}

async function relay(url) {
  const keys = ["RELAY_TOKEN", "RELAY_URL", "LISTEN_HOST", "LISTEN_PORT"];
  const previous = keys.map((key) => process.env[key]);
  let server;
  try {
    Object.assign(process.env, { RELAY_TOKEN: "local-test-token", RELAY_URL: url, LISTEN_HOST: "127.0.0.1", LISTEN_PORT: "0" });
    ({ server } = await import(`../relay/index.mjs?test=${sequence++}`));
  } finally {
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    });
  }
  if (!server.listening) await once(server, "listening");
  const accepted = once(server, "connection");
  const client = createConnection({ host: "127.0.0.1", port: server.address().port, allowHalfOpen: true });
  client.on("error", () => {});
  const [socket] = await accepted;
  cleanups.push(async () => {
    client.destroy();
    socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { client, socket };
}

function worker(message = () => {}) {
  let peer;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response("Expected upgrade", { status: 400 });
    },
    websocket: {
      idleTimeout: 0,
      backpressureLimit: 64 * 1024 * 1024,
      open(socket) { peer = socket; },
      message,
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `ws://127.0.0.1:${server.port}`, peer: () => peer };
}

test("native TCP/WebSocket relay preserves ordered response bytes and end across backpressure", async () => {
  const uploaded = [];
  let uploadEnded = false;
  const backend = worker((peer, message) => {
    if (typeof message === "string") uploadEnded = JSON.parse(message).type === "end";
    else uploaded.push(Buffer.from(message));
  });
  const { client, socket } = await relay(backend.url);
  client.pause();
  await until(() => backend.peer() !== undefined);

  const upload = Buffer.from("request before TCP half-close");
  client.end(upload);
  await until(() => uploadEnded);
  expect(Buffer.concat(uploaded)).toEqual(upload);
  expect(socket.destroyed).toBe(false);

  const chunks = Array.from({ length: 48 }, (_, i) => Buffer.alloc(64 * 1024, i));
  let blocked = false;
  let violations = 0;
  let blockedWrites = 0;
  const write = socket.write;
  socket.prependListener("drain", () => { blocked = false; });
  socket.write = function (...args) {
    if (blocked) violations++;
    const result = write.apply(this, args);
    blocked = !result;
    if (blocked) blockedWrites++;
    return result;
  };
  for (const chunk of chunks) backend.peer().send(chunk);
  backend.peer().send(JSON.stringify({ type: "end" }));
  backend.peer().close(1000, "complete");
  await Bun.sleep(50);
  const received = [];
  client.on("data", (chunk) => received.push(chunk));
  const ended = once(client, "end");
  client.resume();
  await ended;
  expect(Buffer.concat(received)).toEqual(Buffer.concat(chunks));
  expect(blockedWrites).toBeGreaterThan(0);
  expect(violations).toBe(0);
}, 10_000);

test("native relay terminates an overloaded slow TCP consumer with a bounded write buffer", async () => {
  const backend = worker();
  const { client, socket } = await relay(backend.url);
  client.pause();
  await until(() => backend.peer() !== undefined);
  let maximum = 0;
  const write = socket.write;
  socket.write = function (...args) {
    const result = write.apply(this, args);
    maximum = Math.max(maximum, this.writableLength);
    return result;
  };
  const chunk = Buffer.alloc(64 * 1024, 7);
  for (let i = 0; i < 256; i++) backend.peer().send(chunk);
  await until(() => socket.destroyed);
  expect(maximum).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(maximum).toBeGreaterThan(0);
}, 10_000);

test("native relay rejects binary data after the remote half-close", async () => {
  const backend = worker();
  const { socket } = await relay(backend.url);
  await until(() => backend.peer() !== undefined);
  backend.peer().send(JSON.stringify({ type: "end" }));
  backend.peer().send(Buffer.from("late data"));
  await until(() => socket.destroyed);
});

test("WebSocket send backpressure pauses and resumes the TCP producer", async () => {
  let bridge;
  const emit = WebSocket.prototype.emit;
  const capture = spyOn(WebSocket.prototype, "emit").mockImplementation(function (...args) {
    bridge = this;
    return emit.apply(this, args);
  });
  cleanups.push(() => capture.mockRestore());
  let remote;
  let received = 0;
  const backend = createServer((socket) => {
    remote = socket;
    let request = "";
    const upgrade = (chunk) => {
      request += chunk.toString();
      if (!request.includes("\r\n\r\n")) return;
      socket.off("data", upgrade);
      const key = request.match(/sec-websocket-key:\s*(.+)\r\n/i)[1].trim();
      const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.on("data", (chunk) => { received += chunk.length; });
      socket.pause();
    };
    socket.on("data", upgrade);
    socket.on("error", () => {});
  });
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  cleanups.push(async () => {
    remote?.destroy();
    await new Promise((resolve) => backend.close(resolve));
  });
  const { client, socket } = await relay(`ws://127.0.0.1:${backend.address().port}`);
  await until(() => bridge?.readyState === WebSocket.OPEN);
  const size = 32 * 1024 * 1024;
  client.end(Buffer.alloc(size, 9));
  try {
    await until(() => socket.isPaused() && bridge.bufferedAmount >= 1024 * 1024);
  } catch (error) {
    const state = { tcpBytesRead: socket.bytesRead, tcpPaused: socket.isPaused(), bufferedAmountWhileOpen: bridge.bufferedAmount };
    const closed = new Promise((resolve) => bridge.addEventListener("close", resolve, { once: true }));
    bridge.terminate();
    await closed;
    throw new Error(`${error.message}: ${JSON.stringify({ ...state, bufferedAmountAfterClose: bridge.bufferedAmount })}`);
  }
  expect(bridge.bufferedAmount).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(socket.destroyed).toBe(false);
  remote.resume();
  await until(() => received >= size && bridge.bufferedAmount <= 256 * 1024 && !socket.isPaused());
  remote.destroy();
  await until(() => socket.destroyed);
  await Bun.sleep(30);
  expect(socket.isPaused()).toBe(true);
}, 10_000);
