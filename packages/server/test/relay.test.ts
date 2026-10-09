import { afterEach, expect, test } from "bun:test";
import { connect } from "node:net";
import { join } from "node:path";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A stand-in for the Worker's /api/relay: the first `shed` upgrades fail with 503, later ones echo. */
function worker(shed: number) {
  let upgrades = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      upgrades++;
      if (upgrades <= shed) return new Response("shed", { status: 503 });
      if (server.upgrade(request)) return;
      return new Response("expected a WebSocket", { status: 426 });
    },
    websocket: {
      message(ws, message) {
        ws.send(message);
      },
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `ws://127.0.0.1:${server.port}/api/relay`, upgrades: () => upgrades };
}

async function relay(url: string) {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../relay/index.mjs")], {
    env: { ...process.env, RELAY_TOKEN: "token", RELAY_URL: url, LISTEN_PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  });
  cleanups.push(() => child.kill());
  const reader = child.stdout.getReader();
  let output = "";
  while (!output.includes("listening")) {
    const { value, done } = await reader.read();
    if (done) throw new Error("relay exited");
    output += new TextDecoder().decode(value);
  }
  return port;
}

function client(port: number) {
  const socket = connect(port, "127.0.0.1");
  cleanups.push(() => socket.destroy());
  const received: Buffer[] = [];
  socket.on("data", (chunk) => received.push(chunk));
  const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
  return { socket, received: () => Buffer.concat(received).toString(), closed };
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("timed out");
}

test("a connection survives the Worker refusing its first WebSocket attempts", async () => {
  const upstream = worker(2);
  const port = await relay(upstream.url);
  const { socket, received } = client(port);

  socket.write("hello");
  await until(() => received() === "hello");
  expect(upstream.upgrades()).toBe(3);
});

test("a connection is closed once every WebSocket attempt fails", async () => {
  const upstream = worker(Number.POSITIVE_INFINITY);
  const port = await relay(upstream.url);
  const { socket, closed } = client(port);

  socket.write("hello");
  await closed;
  expect(upstream.upgrades()).toBe(3);
});
