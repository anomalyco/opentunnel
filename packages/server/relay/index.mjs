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

const server = createServer({ allowHalfOpen: true }, (socket) => {
  socket.pause();
  const bridge = new WebSocket(relayUrl);
  bridge.binaryType = "arraybuffer";
  // The client may finish sending before the Worker answers; the end is passed on once the bridge opens.
  let ended = false;

  const send = (data) => {
    if (bridge.readyState === WebSocket.OPEN) bridge.send(data);
  };
  const close = () => {
    if (bridge.readyState === WebSocket.CONNECTING || bridge.readyState === WebSocket.OPEN) bridge.close();
    socket.destroy();
  };

  bridge.addEventListener("open", () => {
    if (ended) send(JSON.stringify({ type: "end" }));
    else socket.resume();
  });
  bridge.addEventListener("message", (event) => {
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
  bridge.addEventListener("close", () => socket.destroy());
  bridge.addEventListener("error", (event) => {
    console.error("Worker relay error:", event.error?.message ?? event.message ?? "unknown");
    socket.destroy();
  });

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
