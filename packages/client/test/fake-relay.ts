import "reflect-metadata";
import * as Net from "node:net";
import { Duplex } from "node:stream";
import * as Tls from "node:tls";
import type { ServerWebSocket } from "bun";
import { X509CertificateGenerator, SubjectAlternativeNameExtension } from "@peculiar/x509";
import { BridgeProtocol } from "@opentunnel/protocol/bridge-protocol";

export const HOSTNAME = "demo.test";
export const TOKEN = "secret-token";

const pem = (label: string, der: ArrayBuffer) =>
  `-----BEGIN ${label}-----\n${Buffer.from(der).toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;

/** A self-signed identity for `demo.test` and `*.demo.test`. */
export async function testIdentity() {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return {
    id: "demo",
    hostname: HOSTNAME,
    token: TOKEN,
    privateKey: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", keys.privateKey)),
    certificate: await selfSigned(keys),
    chain: "",
    certificateExpiry: new Date(Date.now() + 86_400_000),
  };
}

/** A new certificate for the same key, as a server renewal produces. */
export async function renewedCertificate(privateKeyPem: string) {
  const der = Buffer.from(privateKeyPem.replace(/-----[^-]+-----|\s/g, ""), "base64");
  const algorithm = { name: "ECDSA", namedCurve: "P-256" };
  const privateKey = await crypto.subtle.importKey("pkcs8", der, algorithm, true, ["sign"]);
  const { d: _d, key_ops: _ops, ...jwk } = await crypto.subtle.exportKey("jwk", privateKey);
  const publicKey = await crypto.subtle.importKey("jwk", jwk, algorithm, true, ["verify"]);
  return selfSigned({ privateKey, publicKey });
}

async function selfSigned(keys: CryptoKeyPair) {
  const certificate = await X509CertificateGenerator.createSelfSigned({
    name: `CN=${HOSTNAME}`,
    keys,
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 86_400_000),
    extensions: [
      new SubjectAlternativeNameExtension([
        { type: "dns", value: HOSTNAME },
        { type: "dns", value: `*.${HOSTNAME}` },
      ]),
    ],
  });
  return certificate.toString("pem");
}

type Control = Record<string, unknown> & { readonly type: string };

interface SocketData {
  session?: RelaySession;
}

export class RelaySession {
  readonly controls: Control[] = [];
  private readonly pipes = new Map<number, Duplex>();
  private readonly waiters: Array<(message: Control) => void> = [];

  constructor(
    readonly socket: ServerWebSocket<SocketData>,
    readonly routes: ReadonlyArray<string>,
  ) {}

  /** Opens a public connection and returns its plaintext side for a TLS client. */
  open(conn: number, sni: string, peer = "203.0.113.9"): Duplex {
    const socket = this.socket;
    const publicSide = new Duplex({
      read() {},
      write(chunk: Uint8Array, _encoding, callback) {
        socket.send(BridgeProtocol.buildDataFrame(conn, chunk));
        callback();
      },
      final(callback) {
        socket.send(JSON.stringify({ type: "end", conn }));
        callback();
      },
    });
    this.pipes.set(conn, publicSide);
    socket.send(JSON.stringify({ type: "open", conn, peer, sni, alpn: "" }));
    return publicSide;
  }

  /** Opens a public TLS connection to a route. */
  connectTls(conn: number, sni: string, ca: string, peer?: string): Promise<Tls.TLSSocket> {
    const socket = Tls.connect({ socket: this.open(conn, sni, peer), servername: sni, ca });
    return new Promise((resolve, reject) => {
      socket.once("secureConnect", () => resolve(socket));
      socket.once("error", reject);
    });
  }

  /** Resolves with the next control message from the client matching `type`. */
  next(type: string): Promise<Control> {
    const existing = this.controls.findIndex((message) => message.type === type);
    if (existing !== -1) return Promise.resolve(this.controls.splice(existing, 1)[0]!);
    return new Promise((resolve) => {
      const waiter = (message: Control) => {
        if (message.type !== type) return;
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        this.controls.splice(this.controls.indexOf(message), 1);
        resolve(message);
      };
      this.waiters.push(waiter);
    });
  }

  onMessage(message: string | Buffer) {
    if (typeof message === "string") {
      const control = JSON.parse(message) as Control;
      this.controls.push(control);
      if (control.type === "end") this.pipes.get(control.conn as number)?.push(null);
      if (control.type === "reset") this.pipes.get(control.conn as number)?.destroy();
      for (const waiter of [...this.waiters]) waiter(control);
      return;
    }
    const frame = BridgeProtocol.parseDataFrame(new Uint8Array(message));
    if (frame) this.pipes.get(frame.conn)?.push(Buffer.from(frame.payload));
  }

  close() {
    this.socket.close(1001, "test");
  }
}

export interface FakeRelay {
  readonly url: URL;
  readonly next: () => Promise<RelaySession>;
  attachError: string | undefined;
  /** The certificate the API reports; defaults to the identity's. */
  served: { certificate: string; chain: string } | undefined;
  readonly stop: () => void;
}

/** Serves the bridge and the certificate endpoint used by `ensure()`. */
export function fakeRelay(identity: { certificate: string; chain: string }): FakeRelay {
  const sessions: RelaySession[] = [];
  const waiters: Array<(session: RelaySession) => void> = [];
  const relay: FakeRelay = {
    url: new URL("http://127.0.0.1"),
    attachError: undefined,
    served: undefined,
    next: () => {
      const session = sessions.shift();
      if (session) return Promise.resolve(session);
      return new Promise((resolve) => waiters.push(resolve));
    },
    stop: () => server.stop(true),
  };
  const server = Bun.serve<SocketData>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/api/tunnel/demo/certificate") {
        return Response.json({
          id: "cert",
          state: {
            type: "ready",
            certificate: (relay.served ?? identity).certificate,
            chain: (relay.served ?? identity).chain,
            expiry: new Date(Date.now() + 86_400_000).toISOString(),
          },
        });
      }
      if (url.pathname === "/api/tunnel/demo/connect") {
        const upgraded = server.upgrade(request, {
          headers: { "Sec-WebSocket-Protocol": BridgeProtocol.WEBSOCKET_SUBPROTOCOL },
          data: {},
        });
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      message(socket, message) {
        if (socket.data.session) return socket.data.session.onMessage(message);
        const attach = JSON.parse(String(message)) as { token: string; routes: string[] };
        if (attach.token !== TOKEN || relay.attachError) {
          socket.send(JSON.stringify({ type: "attach_error", code: relay.attachError ?? "bad_token" }));
          socket.close(1008, "attach failed");
          return;
        }
        const session = new RelaySession(socket, attach.routes);
        socket.data.session = session;
        socket.send(
          JSON.stringify({
            type: "attached",
            session: `sess_${sessions.length}`,
            routes: attach.routes,
            heartbeat_ms: 15_000,
            idle_timeout_ms: 45_000,
          }),
        );
        const waiter = waiters.shift();
        if (waiter) waiter(session);
        else sessions.push(session);
      },
    },
  });
  (relay as { url: URL }).url = new URL(`http://127.0.0.1:${server.port}`);
  return relay;
}

export function echoServer(): { readonly target: string; readonly stop: () => void } {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        socket.write(Buffer.concat([Buffer.from("echo:"), data]));
      },
    },
  });
  return { target: `127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/** A target that records what its first connection sends. */
export async function recordingServer(): Promise<{
  readonly target: string;
  /** Resolves once the target has received at least `bytes` bytes. */
  readonly received: (bytes: number) => Promise<Buffer>;
  /** Everything received so far. */
  readonly data: () => Buffer;
  readonly stop: () => void;
}> {
  const chunks: Buffer[] = [];
  let wanted: { bytes: number; resolve: (data: Buffer) => void } | undefined;
  const check = () => {
    const data = Buffer.concat(chunks);
    if (wanted && data.length >= wanted.bytes) wanted.resolve(data);
  };
  const server = Net.createServer((socket) => {
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      check();
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as Net.AddressInfo;
  return {
    target: `127.0.0.1:${port}`,
    received: (bytes) =>
      new Promise((resolve) => {
        wanted = { bytes, resolve };
        check();
      }),
    data: () => Buffer.concat(chunks),
    stop: () => server.close(),
  };
}

if (import.meta.main) {
  // Standalone mode for cross-implementation testing: prints the relay URL,
  // writes the identity to stdout as JSON, and opens one public connection to
  // `api` when a client attaches.
  const identity = await testIdentity();
  const relay = fakeRelay(identity);
  const echo = echoServer();
  console.log(JSON.stringify({ url: relay.url.href, identity, echo: echo.target }));
  const session = await relay.next();
  const socket = await session.connectTls(1, `api.${HOSTNAME}`, identity.certificate);
  socket.write("ping");
  socket.once("data", (data) => {
    console.log(JSON.stringify({ routes: session.routes, reply: data.toString() }));
    process.exit(0);
  });
}
