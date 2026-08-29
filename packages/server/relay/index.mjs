import { createServer } from "node:net";
// Use the npm implementation rather than Bun's native shim to observe outbound backpressure.
import WebSocket from "ws-node";

const token = process.env.RELAY_TOKEN;
if (!token) throw new Error("RELAY_TOKEN is required");

const relayUrl = new URL(process.env.RELAY_URL ?? "wss://opentunnel.xyz/api/relay");
relayUrl.searchParams.set("token", token);
const port = Number(process.env.LISTEN_PORT ?? 8443);
const host = process.env.LISTEN_HOST ?? "127.0.0.1";
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;
const MAX_BUFFER = 4 * 1024 * 1024;

export const server = createServer({ allowHalfOpen: true }, (socket) => {
  console.log(`TCP client ${socket.remoteAddress}:${socket.remotePort}`);
  socket.pause();
  const bridge = new WebSocket(relayUrl);
  bridge.binaryType = "arraybuffer";
  let stopped = false;
  let poll;
  let blocked = false;
  let remoteEnded = false;
  const pending = [];
  let pendingBytes = 0;

  const stop = (error) => {
    if (stopped) return;
    stopped = true;
    clearTimeout(poll);
    poll = undefined;
    pending.length = 0;
    pendingBytes = 0;
    socket.destroy(error);
    bridge.terminate();
  };
  const waitForBridge = () => {
    poll = undefined;
    if (stopped || socket.destroyed || bridge.readyState !== WebSocket.OPEN) return;
    if (bridge.bufferedAmount > MAX_BUFFER) return stop(new Error("Relay WebSocket buffer limit"));
    if (bridge.bufferedAmount > LOW_WATER) {
      poll = setTimeout(waitForBridge, 10);
    } else {
      socket.resume();
    }
  };

  bridge.addEventListener("open", () => {
    if (stopped || socket.destroyed) return stop();
    console.log("Worker relay connected");
    socket.resume();
  });
  bridge.addEventListener("message", (event) => {
    if (stopped || socket.destroyed || bridge.readyState !== WebSocket.OPEN) return;
    if (typeof event.data === "string") {
      try {
        if (JSON.parse(event.data).type === "end") {
          remoteEnded = true;
          if (pending.length === 0 && !socket.writableEnded) socket.end();
        }
      } catch {
        stop(new Error("Invalid relay control message"));
      }
      return;
    }
    if (remoteEnded) return stop(new Error("Relay data after end"));
    const chunk = Buffer.from(event.data);
    if (chunk.length === 0) return;
    if (pendingBytes + socket.writableLength + chunk.length > MAX_BUFFER || pending.length >= 1024) {
      return stop(new Error("Relay TCP buffer limit"));
    }
    // Native WebSocket cannot pause reception. Keep a bounded queue until TCP drains.
    if (blocked) {
      pending.push(chunk);
      pendingBytes += chunk.length;
    } else {
      blocked = !socket.write(chunk);
    }
  });
  bridge.addEventListener("close", (event) => {
    console.error(`Worker relay closed: ${event.code} ${event.reason}`);
    clearTimeout(poll);
    poll = undefined;
    socket.pause();
    // A clean close after end must not discard the response still draining to TCP.
    if (!stopped && remoteEnded && event.code === 1000 && !socket.writableFinished) {
      socket.once("finish", () => stop());
    } else {
      stop();
    }
  });
  bridge.addEventListener("error", (event) => {
    console.error("Worker relay error", event.error ?? event.message ?? event);
    stop();
  });

  socket.on("drain", () => {
    if (stopped || socket.destroyed) return;
    blocked = false;
    while (pending.length > 0 && !blocked) {
      const chunk = pending.shift();
      pendingBytes -= chunk.length;
      blocked = !socket.write(chunk);
    }
    if (remoteEnded && pending.length === 0 && !socket.writableEnded) socket.end();
  });
  socket.on("data", (chunk) => {
    if (stopped || bridge.readyState !== WebSocket.OPEN) return;
    if (bridge.bufferedAmount + chunk.length > MAX_BUFFER) return stop(new Error("Relay WebSocket buffer limit"));
    try {
      bridge.send(chunk);
    } catch (error) {
      return stop(error);
    }
    if (bridge.bufferedAmount >= HIGH_WATER) {
      socket.pause();
      if (poll === undefined) poll = setTimeout(waitForBridge, 10);
    }
  });
  socket.on("end", () => {
    if (stopped || bridge.readyState !== WebSocket.OPEN) return;
    try {
      bridge.send(JSON.stringify({ type: "end" }));
    } catch (error) {
      stop(error);
    }
  });
  socket.on("error", (error) => stop(error));
  socket.on("close", () => stop());
});

server.listen(port, host, () => {
  console.log(`OpenTunnel relay listening on ${host}:${port}`);
});
