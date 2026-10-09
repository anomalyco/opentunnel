import { createServer } from "node:net";

// Carries each TCP connection on *.opentunnel.xyz:443 to the Worker over its own WebSocket. One connection
// failing must never take the process down: every connection drives its own teardown, and sends only
// happen on an open WebSocket.

const token = process.env.RELAY_TOKEN;
if (!token) throw new Error("RELAY_TOKEN is required");

const relayUrl = new URL(process.env.RELAY_URL ?? "wss://opentunnel.xyz/api/relay");
relayUrl.searchParams.set("token", token);
const port = Number(process.env.LISTEN_PORT ?? 8443);
const host = process.env.LISTEN_HOST ?? "127.0.0.1";

// Cloudflare sheds some Worker requests under load, so a WebSocket can fail before it opens. Nothing has
// been sent yet (the client socket stays paused until the bridge opens), so another attempt is safe.
const OPEN_ATTEMPTS = 3;
const retryDelay = (attempt) => 100 * 2 ** (attempt - 1) * (0.5 + Math.random() / 2);

const server = createServer({ allowHalfOpen: true }, (socket) => {
  socket.pause();
  let bridge;
  // The client may finish sending before the Worker answers; the end is passed on once the bridge opens.
  let ended = false;

  const send = (data) => {
    if (bridge?.readyState === WebSocket.OPEN) bridge.send(data);
  };
  const close = () => {
    if (bridge?.readyState === WebSocket.CONNECTING || bridge?.readyState === WebSocket.OPEN) bridge.close();
    socket.destroy();
  };

  const open = (attempt) => {
    const current = new WebSocket(relayUrl);
    current.binaryType = "arraybuffer";
    bridge = current;
    let opened = false;
    let failed = false;
    const fail = () => {
      if (failed) return;
      failed = true;
      if (!opened && attempt < OPEN_ATTEMPTS && !socket.destroyed) {
        setTimeout(() => {
          if (!socket.destroyed) open(attempt + 1);
        }, retryDelay(attempt));
        return;
      }
      socket.destroy();
    };

    current.addEventListener("open", () => {
      opened = true;
      if (ended) send(JSON.stringify({ type: "end" }));
      else socket.resume();
    });
    current.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        try {
          if (JSON.parse(event.data).type === "end") socket.end();
        } catch {
          close();
        }
        return;
      }
      if (!socket.destroyed) socket.write(Buffer.from(event.data));
    });
    current.addEventListener("close", fail);
    current.addEventListener("error", (event) => {
      console.error(
        `Worker relay error${opened ? "" : ` (attempt ${attempt}/${OPEN_ATTEMPTS})`}:`,
        event.error?.message ?? event.message ?? "unknown",
      );
      fail();
    });
  };
  open(1);

  socket.on("data", (chunk) => send(chunk));
  socket.on("end", () => {
    ended = true;
    send(JSON.stringify({ type: "end" }));
  });
  socket.on("error", close);
  socket.on("close", close);
});

server.on("error", (error) => {
  console.error("Relay server error:", error);
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`OpenTunnel relay listening on ${host}:${port}`);
});
