import { Option } from "effect";
import * as Net from "node:net";
import { Duplex } from "node:stream";
import * as Tls from "node:tls";
import { BridgeProtocol } from "@opentunnel/protocol/bridge-protocol";
import { Names } from "@opentunnel/protocol/names";
import type {
  OpenTunnelClientEvent,
  OpenTunnelIdentity,
  OpenTunnelRoutes,
  OpenTunnelStatus,
} from "./types.js";

const VERSION = "0.1.0";
const MAX_CONNS = 256;
/** Bytes queued on the WebSocket before local sockets stop being read. */
const HIGH_WATER_MARK = 1024 * 1024;
const LOW_WATER_MARK = 256 * 1024;
/** Bytes buffered for one public connection before it is treated as stalled. */
const STALLED_CHANNEL_BYTES = 8 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * How often to check for a renewed certificate: rarely while the current one
 * is fresh, every minute once renewal is due (it completes within minutes).
 */
const CERTIFICATE_CHECK_FRESH_MS = 12 * 60 * 60 * 1000;
const CERTIFICATE_CHECK_DUE_MS = 60 * 1000;
const RENEWAL_WINDOW_MS = 30 * DAY_MS;

type SessionEnd =
  | { readonly type: "shutdown" }
  | { readonly type: "routes-changed" }
  | { readonly type: "fatal"; readonly error: Error }
  | { readonly type: "retry"; readonly error: string; readonly attached: boolean };

export class OpenTunnelAttachError extends Error {
  constructor(readonly code: string) {
    super(`Bridge attach failed: ${code}`);
  }
}

const fatalAttachCodes = new Set<string>([
  BridgeProtocol.BridgeErrorCode.BAD_TOKEN,
  BridgeProtocol.BridgeErrorCode.CERT_NOT_READY,
]);

export const validateRoutes = (routes: OpenTunnelRoutes): void => {
  for (const [name, target] of Object.entries(routes)) {
    if (!Names.isValidRoute(name)) throw new Error(`Invalid route name '${name}'`);
    if (!Names.parseTarget(target)) {
      throw new Error(`Invalid target '${target}' for route '${name}': use host:port`);
    }
  }
};

const secureContextFor = (identity: OpenTunnelIdentity) =>
  Tls.createSecureContext({
    key: identity.privateKey,
    cert: `${identity.certificate}\n${identity.chain}`,
  });

const sameNames = (left: OpenTunnelRoutes, right: OpenTunnelRoutes) => {
  const a = Object.keys(left).sort();
  const b = Object.keys(right).sort();
  return a.length === b.length && a.every((name, index) => name === b[index]);
};

const backoff = (attempt: number) => {
  const base = Math.min(
    BridgeProtocol.BridgeTiming.RECONNECT_BACKOFF_MIN_MS * 2 ** Math.min(attempt, 16),
    BridgeProtocol.BridgeTiming.RECONNECT_BACKOFF_MAX_MS,
  );
  return Math.round(base / 2 + Math.random() * (base / 2));
};

export interface TunnelOptions {
  readonly api: URL;
  readonly identity: OpenTunnelIdentity;
  readonly routes: OpenTunnelRoutes;
  readonly onEvent: (event: OpenTunnelClientEvent) => void;
  /** Called with the identity after the server renews its certificate. */
  readonly onRenewed?: (identity: OpenTunnelIdentity) => void;
}

/**
 * A running tunnel: one bridge session at a time, reconnecting with backoff
 * until closed or a fatal attach error.
 */
export class Tunnel {
  private routes: OpenTunnelRoutes;
  private identity: OpenTunnelIdentity;
  private secureContext: Tls.SecureContext;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private session: Session | undefined;
  private shutdown = false;
  private wake: (() => void) | undefined;
  private readonly status: {
    -readonly [K in keyof OpenTunnelStatus]: OpenTunnelStatus[K];
  };
  readonly ready: Promise<void>;
  readonly closed: Promise<void>;

  constructor(private readonly options: TunnelOptions) {
    validateRoutes(options.routes);
    this.routes = { ...options.routes };
    this.identity = options.identity;
    this.secureContext = secureContextFor(options.identity);
    this.status = {
      state: "connecting",
      hostname: options.identity.hostname,
      routes: this.routes,
      connections: 0,
    };
    let ready!: () => void;
    let failed!: (error: unknown) => void;
    this.ready = new Promise((resolve, reject) => {
      ready = resolve;
      failed = reject;
    });
    this.closed = this.run(ready).then(
      () => ready(),
      (error) => {
        failed(error);
        throw error;
      },
    );
    this.ready.catch(() => undefined);
    void this.refreshCertificate();
  }

  /**
   * Fetches the server's current certificate and, when the server has
   * renewed it, uses it for new connections. Checks on start, then on a timer.
   */
  private async refreshCertificate(): Promise<void> {
    if (this.shutdown) return;
    try {
      const url = new URL(
        `/api/tunnel/${encodeURIComponent(this.identity.id)}/certificate`,
        this.options.api,
      );
      const response = await fetch(url, { headers: { authorization: `Bearer ${this.identity.token}` } });
      const body = response.ok
        ? ((await response.json()) as {
            state?: { type?: string; certificate?: string; chain?: string; expiry?: string };
          })
        : undefined;
      const state = body?.state;
      if (
        state?.type === "ready" &&
        state.certificate &&
        state.expiry &&
        state.certificate !== this.identity.certificate
      ) {
        const renewed: OpenTunnelIdentity = {
          ...this.identity,
          certificate: state.certificate,
          chain: state.chain ?? "",
          certificateExpiry: new Date(state.expiry),
        };
        this.secureContext = secureContextFor(renewed);
        this.identity = renewed;
        this.options.onRenewed?.(renewed);
        this.emit({ type: "certificate-renewed", expiry: state.expiry });
      }
    } catch {
      // Not fatal: the current certificate keeps serving; retry on the next check.
    }
    if (this.shutdown) return;
    const due = this.identity.certificateExpiry.getTime() - Date.now() < RENEWAL_WINDOW_MS;
    this.refreshTimer = setTimeout(
      () => void this.refreshCertificate(),
      due ? CERTIFICATE_CHECK_DUE_MS : CERTIFICATE_CHECK_FRESH_MS,
    );
    this.refreshTimer.unref?.();
  }

  getStatus(): OpenTunnelStatus {
    return { ...this.status, routes: { ...this.status.routes } };
  }

  /**
   * Replaces the routes. Changing only targets applies to new connections
   * immediately; adding or removing names re-attaches the bridge.
   */
  setRoutes(routes: OpenTunnelRoutes): void {
    validateRoutes(routes);
    const previous = this.routes;
    this.routes = { ...routes };
    this.status.routes = this.routes;
    if (!sameNames(previous, this.routes)) this.session?.end({ type: "routes-changed" });
    this.wake?.();
  }

  close(): Promise<void> {
    this.shutdown = true;
    clearTimeout(this.refreshTimer);
    this.session?.end({ type: "shutdown" });
    this.wake?.();
    return this.closed.catch(() => undefined);
  }

  private emit(event: OpenTunnelClientEvent) {
    this.options.onEvent(event);
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    }).finally(() => {
      this.wake = undefined;
    });
  }

  private async run(onReady: () => void): Promise<void> {
    let attempt = 0;
    try {
      while (!this.shutdown) {
        if (Object.keys(this.routes).length === 0) {
          this.status.state = "waiting-routes";
          await this.sleep(2 ** 31 - 1);
          continue;
        }
        this.status.state = "connecting";
        this.emit({ type: "connecting", attempt });
        const session = new Session(this.options, this.routes, () => this.secureContext, {
          emit: (event) => this.emit(event),
          target: (route) => this.routes[route],
          attached: (sessionID) => {
            this.status.state = "connected";
            this.status.session = sessionID;
            this.status.lastError = undefined;
            this.status.connectedAt = Date.now();
            onReady();
          },
          connections: (count) => {
            this.status.connections = count;
          },
        });
        this.session = session;
        const end = await session.run();
        this.session = undefined;
        this.status.session = undefined;
        this.status.connections = 0;

        if (end.type === "shutdown") break;
        if (end.type === "fatal") throw end.error;
        if (end.type === "routes-changed") {
          this.emit({ type: "disconnected", reason: "routes changed" });
          attempt = 0;
          continue;
        }
        if (end.attached) attempt = 0;
        this.emit({ type: "disconnected", reason: end.error });
        const delay = backoff(attempt);
        attempt++;
        this.status.state = "reconnecting";
        this.status.lastError = end.error;
        this.emit({ type: "reconnecting", attempt, delayMs: delay });
        await this.sleep(delay);
      }
      this.status.state = "stopped";
      this.emit({ type: "stopped" });
    } catch (error) {
      this.status.state = "stopped";
      this.status.lastError = error instanceof Error ? error.message : String(error);
      this.emit({ type: "stopped", error: this.status.lastError });
      throw error;
    }
  }
}

interface SessionHooks {
  readonly emit: (event: OpenTunnelClientEvent) => void;
  readonly target: (route: string) => string | undefined;
  readonly attached: (session: string) => void;
  readonly connections: (count: number) => void;
}

class Session {
  private socket: WebSocket | undefined;
  private finish: ((end: SessionEnd) => void) | undefined;
  private readonly channels = new Map<number, Channel>();
  private readonly drainWaiters: Array<() => void> = [];
  private drainTimer: ReturnType<typeof setInterval> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private attachTimeout: ReturnType<typeof setTimeout> | undefined;
  private lastReceived = Date.now();
  private attached = false;

  constructor(
    private readonly options: TunnelOptions,
    private readonly routes: OpenTunnelRoutes,
    private readonly secureContext: () => Tls.SecureContext,
    private readonly hooks: SessionHooks,
  ) {}

  run(): Promise<SessionEnd> {
    return new Promise((resolve) => {
      this.finish = resolve;
      const url = new URL(
        `/api/tunnel/${encodeURIComponent(this.options.identity.id)}/connect`,
        this.options.api,
      );
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url, BridgeProtocol.WEBSOCKET_SUBPROTOCOL);
      socket.binaryType = "arraybuffer";
      this.socket = socket;
      this.attachTimeout = setTimeout(
        () => this.end({ type: "retry", error: "bridge attach timed out", attached: false }),
        BridgeProtocol.BridgeTiming.CONNECT_TIMEOUT_MS,
      );
      socket.addEventListener("open", () => {
        this.sendControl({
          type: "attach",
          token: this.options.identity.token,
          transport: "ws",
          routes: Object.keys(this.routes).sort(),
          client: { version: VERSION, max_conns: MAX_CONNS },
        });
      });
      socket.addEventListener("message", (event) => {
        this.lastReceived = Date.now();
        if (typeof event.data === "string") this.onControl(event.data);
        else this.onData(new Uint8Array(event.data as ArrayBuffer));
      });
      socket.addEventListener("close", (event) => {
        const reason = `${event.code} ${event.reason}`.trim();
        this.end({ type: "retry", error: `bridge closed: ${reason}`, attached: this.attached });
      });
    });
  }

  end(end: SessionEnd) {
    const finish = this.finish;
    if (!finish) return;
    this.finish = undefined;
    clearTimeout(this.attachTimeout);
    clearInterval(this.heartbeat);
    clearInterval(this.drainTimer);
    for (const waiter of this.drainWaiters.splice(0)) waiter();
    for (const channel of [...this.channels.values()]) channel.destroy("bridge disconnected");
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) this.socket.close(1000);
    finish(end);
  }

  private onControl(text: string) {
    const decoded = BridgeProtocol.decodeServerMessage(text);
    if (Option.isNone(decoded)) return;
    const message = decoded.value;
    if (!this.attached) {
      if (message.type === "attached") {
        this.attached = true;
        clearTimeout(this.attachTimeout);
        const heartbeatMs = Math.max(message.heartbeat_ms, 1_000);
        const idleTimeoutMs = Math.max(message.idle_timeout_ms, 5_000);
        this.heartbeat = setInterval(() => {
          if (Date.now() - this.lastReceived > idleTimeoutMs) {
            this.end({ type: "retry", error: "bridge idle timeout", attached: true });
            return;
          }
          this.sendControl({ type: "ping", time_sent: Date.now() });
        }, heartbeatMs);
        this.hooks.attached(message.session);
        this.hooks.emit({ type: "connected", session: message.session, routes: [...message.routes] });
      } else if (message.type === "attach_error") {
        this.end(
          fatalAttachCodes.has(message.code)
            ? { type: "fatal", error: new OpenTunnelAttachError(message.code) }
            : { type: "retry", error: `attach failed: ${message.code}`, attached: false },
        );
      }
      return;
    }
    switch (message.type) {
      case "open":
        return this.open(message.conn, message.sni, message.peer);
      case "end":
        return this.channels.get(message.conn)?.endInbound();
      case "reset":
        return this.channels.get(message.conn)?.destroy(message.code, false);
      case "ping":
        return this.sendControl({ type: "pong", time_sent: message.time_sent });
      case "drain":
        return this.end({ type: "retry", error: `server draining: ${message.reason}`, attached: true });
    }
  }

  private onData(frame: Uint8Array) {
    const parsed = BridgeProtocol.parseDataFrame(frame);
    if (!parsed) return;
    this.channels.get(parsed.conn)?.push(parsed.payload);
  }

  private open(conn: number, sni: string, peer: string) {
    const route = Names.routeForSni(sni, this.options.identity.hostname);
    const target = route === undefined ? undefined : this.hooks.target(route);
    const parsed = target === undefined ? undefined : Names.parseTarget(target);
    if (route === undefined || !parsed) {
      this.sendControl({ type: "reset", conn, code: BridgeProtocol.BridgeErrorCode.UNKNOWN_ROUTE });
      return;
    }
    const channel = new Channel(conn, route, parsed, this.secureContext(), this);
    this.channels.set(conn, channel);
    this.hooks.connections(this.channels.size);
    this.hooks.emit({ type: "connection-opened", conn, route, peer });
  }

  /** Called by a channel once it has fully closed. */
  closed(channel: Channel, error: string | undefined) {
    if (this.channels.get(channel.conn) !== channel) return;
    this.channels.delete(channel.conn);
    this.hooks.connections(this.channels.size);
    this.hooks.emit({
      type: "connection-closed",
      conn: channel.conn,
      route: channel.route,
      ...(error === undefined ? {} : { error }),
    });
  }

  sendControl(message: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  /** Sends data for a connection; `done` runs once the WebSocket can take more. */
  sendData(conn: number, data: Uint8Array, done: (error?: Error) => void) {
    const socket = this.socket;
    if (!this.finish || socket?.readyState !== WebSocket.OPEN) {
      done(new Error("bridge closed"));
      return;
    }
    for (let offset = 0; offset < data.byteLength; offset += BridgeProtocol.DataFrame.MAX_PAYLOAD_SIZE) {
      const chunk = data.subarray(offset, offset + BridgeProtocol.DataFrame.MAX_PAYLOAD_SIZE);
      socket.send(BridgeProtocol.buildDataFrame(conn, chunk));
    }
    if (socket.bufferedAmount < HIGH_WATER_MARK) {
      done();
      return;
    }
    this.drainWaiters.push(() => done());
    this.drainTimer ??= setInterval(() => {
      if (this.socket && this.socket.bufferedAmount > LOW_WATER_MARK && this.finish) return;
      clearInterval(this.drainTimer);
      this.drainTimer = undefined;
      for (const waiter of this.drainWaiters.splice(0)) waiter();
    }, 5);
  }
}

/** Terminates TLS for one public connection and forwards it to the target. */
class Channel {
  private readonly raw: Duplex;
  private readonly tls: Tls.TLSSocket;
  private upstream: Net.Socket | undefined;
  private done = false;

  constructor(
    readonly conn: number,
    readonly route: string,
    target: { readonly host: string; readonly port: number },
    secureContext: Tls.SecureContext,
    private readonly session: Session,
  ) {
    this.raw = new Duplex({
      allowHalfOpen: true,
      read() {},
      write: (chunk: Uint8Array, _encoding, callback) => session.sendData(conn, chunk, callback),
      final: (callback) => {
        session.sendControl({ type: "end", conn });
        callback();
      },
    });
    this.tls = new Tls.TLSSocket(this.raw as unknown as Net.Socket, {
      isServer: true,
      secureContext,
    });
    this.tls.on("secure", () => {
      const upstream = Net.connect({ host: target.host, port: target.port, allowHalfOpen: true });
      this.upstream = upstream;
      upstream.setNoDelay(true);
      upstream.on("error", (error) =>
        this.destroy(
          upstream.connecting
            ? BridgeProtocol.BridgeErrorCode.UPSTREAM_CONNECT_FAILED
            : BridgeProtocol.BridgeErrorCode.UPSTREAM_IO_ERROR,
          true,
          error.message,
        ),
      );
      this.tls.pipe(upstream);
      upstream.pipe(this.tls);
    });
    this.tls.on("error", (error) =>
      this.destroy(BridgeProtocol.BridgeErrorCode.UPSTREAM_IO_ERROR, true, error.message),
    );
    this.tls.on("close", () => this.finish(undefined));
  }

  push(payload: Uint8Array) {
    if (this.done) return;
    if (this.raw.readableLength > STALLED_CHANNEL_BYTES) {
      this.destroy(BridgeProtocol.BridgeErrorCode.UPSTREAM_IO_ERROR, true, "local connection stalled");
      return;
    }
    this.raw.push(payload);
  }

  endInbound() {
    if (!this.done) this.raw.push(null);
  }

  /** Aborts the connection, optionally telling the server. */
  destroy(code: string, notify = true, error = code) {
    if (this.done) return;
    if (notify) this.session.sendControl({ type: "reset", conn: this.conn, code });
    this.finish(error);
  }

  private finish(error: string | undefined) {
    if (this.done) return;
    this.done = true;
    this.upstream?.destroy();
    this.tls.destroy();
    this.raw.destroy();
    this.session.closed(this, error);
  }
}
