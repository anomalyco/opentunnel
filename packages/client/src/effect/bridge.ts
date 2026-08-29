import { Deferred, Effect, Queue, Stream } from "effect";
import { createConnection, type Socket } from "node:net";
import { createServer, type TLSSocket } from "node:tls";
// An alias bypasses Bun's native ws shim, whose bufferedAmount does not track queued sends.
import WebSocket from "ws-node";
import { BridgeProtocol } from "@opentunnel/protocol/bridge-protocol";
import { OpenTunnelClientError } from "./errors.js";
import type {
  OpenTunnelClientEvent,
  OpenTunnelConnection,
  OpenTunnelIdentity,
  OpenTunnelRoute,
} from "./types.js";

interface Channel {
  readonly route: string;
  readonly relay: Socket;
  port?: number;
  tls?: TLSSocket;
  upstream?: Socket;
}

const MAX_CHANNELS = 256;
const BRIDGE_HIGH_WATER = 1024 * 1024;
const BRIDGE_LOW_WATER = BRIDGE_HIGH_WATER / 2;
const MAX_BRIDGE_BUFFER = 16 * 1024 * 1024;

const routeName = (sni: string, hostname: string): string | undefined => {
  const suffix = `.${hostname}`;
  if (!sni.endsWith(suffix)) return undefined;
  const route = sni.slice(0, -suffix.length);
  return route && !route.includes(".") ? route : undefined;
};

export const connectBridge = Effect.fn("OpenTunnelClient.connectBridge")(function* (options: {
  readonly api: URL;
  readonly identity: OpenTunnelIdentity;
  readonly routes: ReadonlyArray<OpenTunnelRoute>;
}) {
  if (options.routes.length === 0) {
    return yield* new OpenTunnelClientError({ message: "At least one route is required" });
  }

  // Events are telemetry; a slow observer must not retain unlimited messages or fibers.
  const events = yield* Queue.sliding<OpenTunnelClientEvent>(1024);
  const closed = yield* Deferred.make<void>();
  const emit = (event: OpenTunnelClientEvent) => Queue.offerUnsafe(events, event);
  const channels = new Map<number, Channel>();
  const ports = new Map<number, number>();
  const serverSockets = new Set<Socket>();
  const upstreams = new Set<Socket>();
  const blocked = new Set<number>();
  const routes = new Map(options.routes.map((route) => [route.name, route]));
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let drain: ReturnType<typeof setInterval> | undefined;
  let attached = false;
  let disconnected = false;
  let lastPong = performance.now();

  const server = yield* Effect.acquireRelease(
    Effect.try({
      try: () => createServer({
        key: options.identity.privateKey,
        cert: `${options.identity.certificate}\n${options.identity.chain}`,
        handshakeTimeout: BridgeProtocol.BridgeTiming.CONNECT_TIMEOUT_MS,
        allowHalfOpen: true,
      }),
      catch: (cause) => new OpenTunnelClientError({ message: "Failed to create TLS listener", cause }),
    }),
    (listener) => Effect.promise(async () => {
      for (const socket of serverSockets) socket.destroy();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }),
  );
  server.on("connection", (socket) => {
    serverSockets.add(socket);
    socket.once("close", () => serverSockets.delete(socket));
  });
  yield* Effect.tryPromise({
    try: (signal) => new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        server.off("error", finish);
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      server.once("error", finish);
      server.listen(0, "127.0.0.1", () => finish());
    }),
    catch: (cause) => new OpenTunnelClientError({ message: "Failed to listen for TLS", cause }),
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    return yield* new OpenTunnelClientError({ message: "TLS listener has no address" });
  }

  const url = new URL(`/api/tunnel/${options.identity.id}/connect`, options.api);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const bridge = yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        const socket = new WebSocket(url, BridgeProtocol.WEBSOCKET_SUBPROTOCOL, { maxPayload: MAX_BRIDGE_BUFFER });
        // Keep this handler during teardown: terminating a handshake can emit a late error.
        socket.on("error", () => {
          disconnect("Bridge transport error");
          socket.terminate();
        });
        return socket;
      },
      catch: (cause) => new OpenTunnelClientError({ message: "Failed to create bridge", cause }),
    }),
    (socket) => Effect.sync(() => socket.terminate()),
  );

  const send = (payload: string | Uint8Array) => {
    if (disconnected || bridge.readyState !== WebSocket.OPEN) return;
    if (bridge.bufferedAmount + payload.length > MAX_BRIDGE_BUFFER) {
      disconnect("Bridge backpressure limit");
      bridge.terminate();
      return;
    }
    try {
      bridge.send(payload);
    } catch {
      disconnect("Bridge send failed");
      bridge.terminate();
      return;
    }
    if (bridge.bufferedAmount < BRIDGE_HIGH_WATER || drain) return;
    for (const channel of channels.values()) channel.relay.pause();
    drain = setInterval(() => {
      if (bridge.bufferedAmount > BRIDGE_LOW_WATER) return;
      clearInterval(drain);
      drain = undefined;
      for (const channel of channels.values()) channel.relay.resume();
    }, 10);
  };

  const closeChannel = (connection: number, reset = false) => {
    const channel = channels.get(connection);
    if (!channel) return;
    channels.delete(connection);
    if (channel.port) ports.delete(channel.port);
    if (reset) {
      channel.relay.destroy();
      channel.tls?.destroy();
      channel.upstream?.destroy();
    } else {
      channel.relay.destroySoon();
      channel.tls?.destroySoon();
      channel.upstream?.destroySoon();
    }
    if (blocked.delete(connection) && blocked.size === 0 && !disconnected) {
      lastPong = performance.now();
      bridge.resume();
    }
    emit({ type: "route-close", route: channel.route, connection });
    send(JSON.stringify(reset
      ? { type: "reset", conn: connection, code: "upstream_io_error" }
      : { type: "end", conn: connection }));
  };

  function disconnect(reason: string) {
    if (disconnected) return;
    disconnected = true;
    clearInterval(heartbeat);
    clearInterval(drain);
    for (const connection of channels.keys()) closeChannel(connection, true);
    for (const socket of serverSockets) socket.destroy();
    for (const socket of upstreams) socket.destroy();
    server.close(() => {});
    if (attached) emit({ type: "disconnected", reason });
    Deferred.doneUnsafe(closed, Effect.void);
  }

  server.on("secureConnection", (tls) => {
    const connection = ports.get(tls.remotePort ?? 0);
    const channel = connection === undefined ? undefined : channels.get(connection);
    const route = channel && routes.get(channel.route);
    if (!channel || !route || connection === undefined) return tls.destroy();
    channel.tls = tls;
    const target = new URL(`tcp://${route.target}`);
    const upstream = createConnection({ host: target.hostname, port: Number(target.port) });
    channel.upstream = upstream;
    upstreams.add(upstream);
    upstream.once("close", () => upstreams.delete(upstream));
    tls.on("error", () => closeChannel(connection, true));
    upstream.on("error", () => closeChannel(connection, true));
    tls.pipe(upstream).pipe(tls);
  });
  server.on("tlsClientError", (_error, socket) => {
    const connection = ports.get(socket.remotePort ?? 0);
    if (connection !== undefined) closeChannel(connection, true);
    socket.destroy();
  });
  server.on("error", () => {
    disconnect("TLS listener error");
    bridge.terminate();
  });

  const openChannel = (connection: number, sni: string) => {
    const name = routeName(sni, options.identity.hostname);
    const route = name && routes.get(name);
    if (!route || channels.has(connection) || channels.size >= MAX_CHANNELS) {
      send(JSON.stringify({ type: "reset", conn: connection, code: "unknown_route" }));
      return;
    }
    const relay = createConnection({ host: "127.0.0.1", port: address.port, allowHalfOpen: true });
    const channel: Channel = { route: route.name, relay };
    channels.set(connection, channel);
    emit({ type: "route-open", route: route.name, connection });
    relay.once("connect", () => {
      if (!channels.has(connection)) return relay.destroy();
      channel.port = relay.localPort;
      ports.set(channel.port!, connection);
    });
    if (drain) relay.pause();
    relay.on("data", (payload) => send(BridgeProtocol.buildDataFrame(
      connection, typeof payload === "string" ? Buffer.from(payload) : payload,
    )));
    relay.on("end", () => closeChannel(connection));
    relay.on("error", () => closeChannel(connection, true));
    relay.on("drain", () => {
      if (!blocked.delete(connection) || blocked.size > 0 || disconnected) return;
      lastPong = performance.now();
      bridge.resume();
    });
  };

  const onMessage = (data: WebSocket.RawData, binary: boolean) => {
    if (!attached || disconnected) return;
    try {
      if (!binary) {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.type === "open" && typeof message.conn === "number" && typeof message.sni === "string") {
          openChannel(message.conn, message.sni);
        } else if (message.type === "end" && typeof message.conn === "number") {
          channels.get(message.conn)?.relay.end();
        } else if (message.type === "reset" && typeof message.conn === "number") {
          closeChannel(message.conn, true);
        } else if (message.type === "ping" && typeof message.time_sent === "number") {
          send(JSON.stringify({ type: "pong", time_sent: message.time_sent }));
        } else if (message.type === "pong" && typeof message.time_sent === "number") {
          lastPong = performance.now();
        }
        return;
      }
      const bytes = Array.isArray(data) ? Buffer.concat(data)
        : data instanceof Uint8Array ? data : new Uint8Array(data);
      const parsed = BridgeProtocol.parseDataFrame(bytes);
      if (!parsed) return;
      const channel = channels.get(parsed.conn);
      if (!channel) return;
      if (!channel.relay.write(parsed.payload)) {
        blocked.add(parsed.conn);
        bridge.pause();
      }
    } catch {
      disconnect("Invalid bridge message");
      bridge.terminate();
    }
  };
  const onClose = (code: number, reason: Buffer) => disconnect(`${code} ${reason.toString()}`.trim());
  bridge.on("message", onMessage);
  bridge.once("close", onClose);
  yield* Effect.addFinalizer(() => Effect.gen(function* () {
    disconnect("Bridge closed");
    bridge.off("message", onMessage);
    bridge.off("close", onClose);
    yield* Queue.shutdown(events);
  }));

  yield* Effect.tryPromise({
    try: (signal) => new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timeout);
        bridge.off("error", finish);
        bridge.off("open", onOpen);
        bridge.off("message", onAttached);
        bridge.off("close", onEarlyClose);
        signal.removeEventListener("abort", abort);
        if (error) {
          bridge.terminate();
          reject(error);
        } else resolve();
      };
      const abort = () => finish(signal.reason);
      const onEarlyClose = () => finish(new Error("Bridge closed before attachment"));
      const onOpen = () => bridge.send(JSON.stringify({
        type: "attach", token: options.identity.token, transport: "ws",
        routes: options.routes.map((route) => route.name),
        client: { version: "0.1.0", max_conns: MAX_CHANNELS },
      }));
      const onAttached = (data: WebSocket.RawData, binary: boolean) => {
        if (binary) return;
        try {
          const message = JSON.parse(data.toString()) as { type?: string; code?: string };
          if (message.type === "attach_error") finish(new Error(`Bridge attach failed: ${message.code ?? "unknown"}`));
          else if (message.type === "attached") {
            attached = true;
            lastPong = performance.now();
            emit({ type: "connected" });
            finish();
          }
        } catch {
          finish(new Error("Invalid bridge attach response"));
        }
      };
      const timeout = setTimeout(() => finish(new Error("Bridge attach timeout")), BridgeProtocol.BridgeTiming.CONNECT_TIMEOUT_MS);
      bridge.once("error", finish);
      bridge.once("open", onOpen);
      bridge.on("message", onAttached);
      bridge.once("close", onEarlyClose);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else if (bridge.readyState === WebSocket.CLOSED || disconnected) onEarlyClose();
      else if (bridge.readyState === WebSocket.OPEN) onOpen();
    }),
    catch: (cause) => new OpenTunnelClientError({ message: "Failed to attach bridge", cause }),
  });
  heartbeat = setInterval(() => {
    // Receiving is intentionally paused while local writes drain, including pong frames.
    if (blocked.size === 0 && performance.now() - lastPong >= BridgeProtocol.BridgeTiming.IDLE_TIMEOUT_MS) {
      disconnect("Bridge heartbeat timeout");
      bridge.terminate();
    } else send(JSON.stringify({ type: "ping", time_sent: Date.now() }));
  }, BridgeProtocol.BridgeTiming.HEARTBEAT_MS);

  return {
    tunnel: options.identity,
    routes: options.routes,
    events: Stream.fromQueue(events),
    closed: Deferred.await(closed),
    close: Effect.sync(() => {
      disconnect("Bridge closed");
      bridge.terminate();
    }),
  } satisfies OpenTunnelConnection;
});
