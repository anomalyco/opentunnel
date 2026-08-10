import { Deferred, Effect, Queue, Stream } from "effect";
import { createConnection, type Socket } from "node:net";
import { createServer, type Server } from "node:tls";
import WebSocket from "ws";
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
  readonly server: Server;
  readonly pending: Buffer[];
  relay?: Socket;
  active: boolean;
}

const dataFrame = (connection: number, payload: Uint8Array): Uint8Array => {
  const output = new Uint8Array(4 + payload.byteLength);
  new DataView(output.buffer).setUint32(0, connection, false);
  output.set(payload, 4);
  return output;
};

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

  const events = yield* Queue.unbounded<OpenTunnelClientEvent>();
  const closed = yield* Deferred.make<void>();
  const emit = (event: OpenTunnelClientEvent) => {
    Effect.runFork(Queue.offer(events, event));
  };

  const bridge = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<WebSocket>((resolve, reject) => {
          const url = new URL(`/api/tunnel/${options.identity.id}/connect`, options.api);
          url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
          const socket = new WebSocket(url, BridgeProtocol.WEBSOCKET_SUBPROTOCOL);
          const timeout = setTimeout(() => {
            socket.close();
            reject(new Error("Bridge attach timeout"));
          }, BridgeProtocol.BridgeTiming.CONNECT_TIMEOUT_MS);
          const fail = (cause: unknown) => {
            clearTimeout(timeout);
            reject(cause);
          };
          socket.once("error", fail);
          socket.once("open", () => {
            socket.send(JSON.stringify({
              type: "attach",
              token: options.identity.token,
              transport: "ws",
              routes: options.routes.map((route) => route.name),
              client: { version: "0.1.0", max_conns: 256 },
            }));
          });
          const attached = (data: WebSocket.RawData, binary: boolean) => {
            if (binary) return;
            try {
              const message = JSON.parse(data.toString()) as { type?: string; code?: string };
              if (message.type === "attach_error") {
                socket.off("message", attached);
                fail(new Error(`Bridge attach failed: ${message.code ?? "unknown"}`));
              } else if (message.type === "attached") {
                clearTimeout(timeout);
                socket.off("error", fail);
                socket.off("message", attached);
                resolve(socket);
              }
            } catch {
              // Ignore messages until an attach response arrives.
            }
          };
          socket.on("message", attached);
        }),
      catch: (cause) => new OpenTunnelClientError({ message: "Failed to attach bridge", cause }),
    }),
    (socket) => Effect.sync(() => socket.close()),
  );

  const channels = new Map<number, Channel>();
  const routes = new Map(options.routes.map((route) => [route.name, route]));
  let heartbeat: ReturnType<typeof setInterval>;

  const closeChannel = (connection: number, reset = false) => {
    const channel = channels.get(connection);
    if (!channel?.active) return;
    channel.active = false;
    channels.delete(connection);
    channel.relay?.destroy();
    channel.server.close();
    emit({ type: "route-close", route: channel.route, connection });
    if (bridge.readyState === WebSocket.OPEN) {
      bridge.send(JSON.stringify(
        reset
          ? { type: "reset", conn: connection, code: "upstream_io_error" }
          : { type: "end", conn: connection },
      ));
    }
  };

  const openChannel = (message: { conn: number; sni: string; alpn: string }) => {
    const name = routeName(message.sni, options.identity.hostname);
    const route = name ? routes.get(name) : undefined;
    if (!route) {
      bridge.send(JSON.stringify({ type: "reset", conn: message.conn, code: "unknown_route" }));
      return;
    }
    const server = createServer({
      key: options.identity.privateKey,
      cert: `${options.identity.certificate}\n${options.identity.chain}`,
    });
    const channel: Channel = { route: route.name, server, pending: [], active: true };
    channels.set(message.conn, channel);
    emit({ type: "route-open", route: route.name, connection: message.conn });

    server.on("secureConnection", (tlsSocket) => {
      const target = new URL(`tcp://${route.target}`);
      const upstream = createConnection({
        host: target.hostname,
        port: Number(target.port),
      });
      tlsSocket.pipe(upstream).pipe(tlsSocket);
      upstream.on("error", () => closeChannel(message.conn, true));
    });
    server.on("error", () => closeChannel(message.conn, true));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return closeChannel(message.conn, true);
      const relay = createConnection({ host: "127.0.0.1", port: address.port });
      channel.relay = relay;
      relay.on("connect", () => {
        for (const payload of channel.pending) relay.write(payload);
        channel.pending.length = 0;
      });
      relay.on("data", (payload) =>
        bridge.send(dataFrame(message.conn, typeof payload === "string" ? Buffer.from(payload) : payload)),
      );
      relay.on("end", () => closeChannel(message.conn));
      relay.on("error", () => closeChannel(message.conn, true));
    });
  };

  const onMessage = (data: WebSocket.RawData, binary: boolean) => {
    if (!binary) {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (
        message.type === "open" &&
        typeof message.conn === "number" &&
        typeof message.sni === "string"
      ) {
        openChannel({
          conn: message.conn,
          sni: message.sni,
          alpn: typeof message.alpn === "string" ? message.alpn : "",
        });
      } else if (message.type === "end" && typeof message.conn === "number") {
        channels.get(message.conn)?.relay?.end();
      } else if (message.type === "reset" && typeof message.conn === "number") {
        closeChannel(message.conn, true);
      } else if (message.type === "ping" && typeof message.time_sent === "number") {
        bridge.send(JSON.stringify({ type: "pong", time_sent: message.time_sent }));
      }
      return;
    }
    const bytes = new Uint8Array(data as ArrayBuffer);
    const parsed = BridgeProtocol.parseDataFrame(bytes);
    if (!parsed) return;
    const channel = channels.get(parsed.conn);
    if (!channel) return;
    if (channel.relay) channel.relay.write(parsed.payload);
    else channel.pending.push(Buffer.from(parsed.payload));
  };

  const onClose = (code: number, reason: Buffer) => {
    clearInterval(heartbeat);
    for (const connection of [...channels.keys()]) closeChannel(connection, true);
    emit({ type: "disconnected", reason: `${code} ${reason.toString()}`.trim() });
    Effect.runFork(Deferred.succeed(closed, undefined));
  };
  bridge.on("message", onMessage);
  bridge.once("close", onClose);
  heartbeat = setInterval(() => {
    if (bridge.readyState === WebSocket.OPEN) {
      bridge.send(JSON.stringify({ type: "ping", time_sent: Date.now() }));
    }
  }, BridgeProtocol.BridgeTiming.HEARTBEAT_MS);
  emit({ type: "connected" });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      clearInterval(heartbeat);
      bridge.off("message", onMessage);
      bridge.off("close", onClose);
      for (const connection of [...channels.keys()]) closeChannel(connection, true);
      bridge.close();
      Effect.runFork(Queue.shutdown(events));
      Effect.runFork(Deferred.succeed(closed, undefined));
    }),
  );

  return {
    tunnel: options.identity,
    routes: options.routes,
    events: Stream.fromQueue(events),
    closed: Deferred.await(closed),
    close: Effect.sync(() => bridge.close()),
  } satisfies OpenTunnelConnection;
});
