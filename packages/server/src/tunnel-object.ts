import "reflect-metadata";
import { DurableObject, env } from "cloudflare:workers";
import { Pkcs10CertificateRequest, SubjectAlternativeNameExtension } from "@peculiar/x509";
import { BridgeProtocol } from "@opentunnel/protocol/bridge-protocol";
import { Certificate } from "@opentunnel/protocol/certificate";
import { CSR } from "@opentunnel/protocol/csr";
import { Tunnel } from "@opentunnel/protocol/tunnel";
import { concatBytes, parseClientHello } from "./tls-client-hello.js";
import type { StoredTunnel } from "./stored-tunnel.js";
import { hashToken } from "./crypto.js";

interface BridgeAttachment {
  readonly kind: "bridge";
  readonly attached: boolean;
  readonly session?: string;
  readonly routes?: ReadonlyArray<string>;
}

interface Channel {
  readonly bridge: WebSocket;
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly done: Promise<void>;
  finish(error?: unknown): void;
}

interface TunnelInfoResult {
  readonly status: "ok" | "not-found" | "unauthorized";
  readonly tunnel?: Tunnel.Info;
}

interface CertificateResult {
  readonly status: "ok" | "not-found" | "unauthorized" | "no-certificate";
  readonly certificate?: Certificate.Info;
}

interface BindCertificateResult {
  readonly status:
    | "ok"
    | "not-found"
    | "unauthorized"
    | "in-progress"
    | "invalid-request"
    | "invalid-hostname"
    | "workflow-unavailable";
  readonly certificate?: Certificate.Info;
  readonly message?: string;
  readonly provided?: string;
  readonly expected?: string;
}

const tunnelView = (record: StoredTunnel): Tunnel.Info => ({
  id: record.id,
  hostname: record.hostname,
  state: record.state,
  ...(record.certificateID ? { certificateID: record.certificateID } : {}),
}) as Tunnel.Info;

const certificateView = (certificate: Certificate.Info): Certificate.Info => ({
  id: certificate.id,
  state: { ...certificate.state },
}) as Certificate.Info;

const parseControl = (message: string): Record<string, unknown> | undefined => {
  try {
    const value = JSON.parse(message);
    return typeof value === "object" && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
};

const validRoute = (route: string): boolean =>
  route === "@" || /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(route);

export class TunnelObject extends DurableObject<Cloudflare.Env> {
  private readonly channels = new Map<number, Channel>();
  private sequence = 1;

  private async record(): Promise<StoredTunnel | undefined> {
    return this.ctx.storage.get<StoredTunnel>("tunnel");
  }

  private async save(record: StoredTunnel): Promise<void> {
    await this.ctx.storage.put("tunnel", record);
  }

  async initialize(input: {
    readonly id: string;
    readonly hostname: string;
    readonly tokenHash: string;
  }): Promise<Tunnel.Info | undefined> {
    const existing = await this.record();
    if (existing && !existing.deletedAt) return undefined;
    const record: StoredTunnel = {
      version: 1,
      id: Tunnel.ID.makeUnsafe(input.id),
      hostname: CSR.Hostname.makeUnsafe(input.hostname),
      tokenHash: input.tokenHash,
      state: "offline",
      createdAt: new Date().toISOString(),
    };
    await this.save(record);
    return tunnelView(record);
  }

  async info(token: string): Promise<TunnelInfoResult> {
    const record = await this.record();
    if (!record || record.deletedAt) return { status: "not-found" };
    if ((await hashToken(token)) !== record.tokenHash) return { status: "unauthorized" };
    return { status: "ok", tunnel: tunnelView(record) };
  }

  async certificate(token: string): Promise<CertificateResult> {
    const record = await this.record();
    if (!record || record.deletedAt) return { status: "not-found" };
    if ((await hashToken(token)) !== record.tokenHash) return { status: "unauthorized" };
    if (!record.certificate) return { status: "no-certificate" };
    return { status: "ok", certificate: certificateView(record.certificate) };
  }

  async updateCertificate(id: string, input: Certificate.State): Promise<boolean> {
    const record = await this.record();
    if (!record || record.deletedAt || String(record.certificateID) !== id) return false;
    const state = input.type === "issuing"
      ? new Certificate.StateIssuing(input)
      : input.type === "challenge"
        ? new Certificate.StateChallenge(input)
        : input.type === "ready"
          ? new Certificate.StateReady(input)
          : new Certificate.StateFailed(input);
    await this.save({
      ...record,
      certificate: new Certificate.Info({ id: Certificate.ID.makeUnsafe(id), state }),
    });
    return true;
  }

  async bindCertificate(token: string, csr: string): Promise<BindCertificateResult> {
    const record = await this.record();
    if (!record || record.deletedAt) return { status: "not-found" };
    if ((await hashToken(token)) !== record.tokenHash) return { status: "unauthorized" };
    let requestHostname: string;
    let identifiers: ReadonlyArray<string>;
    try {
      const certificateRequest = new Pkcs10CertificateRequest(csr);
      if (!(await certificateRequest.verify(crypto))) throw new Error("CSR signature is invalid");
      requestHostname = String(certificateRequest.subjectName.getField("CN"));
      const extension = certificateRequest.extensions.find(
        (candidate) => candidate.type === "2.5.29.17",
      );
      const subjectAlternativeName = extension
        ? extension instanceof SubjectAlternativeNameExtension
          ? extension
          : new SubjectAlternativeNameExtension(extension.rawData)
        : undefined;
      const names = subjectAlternativeName?.names.items
        .filter((name) => name.type === "dns")
        .map((name) => name.value) ?? [];
      identifiers = [...new Set(names.length > 0 ? names : [requestHostname])];
    } catch {
      return { status: "invalid-request", message: "Failed to parse CSR" };
    }
    if (requestHostname !== record.hostname) {
      return {
        status: "invalid-hostname",
        provided: requestHostname,
        expected: record.hostname,
      };
    }
    if (
      identifiers.some(
        (identifier) => identifier !== record.hostname && identifier !== `*.${record.hostname}`,
      )
    ) {
      return {
        status: "invalid-hostname",
        provided: identifiers.join(","),
        expected: `${record.hostname},*.${record.hostname}`,
      };
    }
    if (record.certificate && record.certificateCsr === csr) {
      await this.ensureCertificateWorkflow(record, csr, identifiers);
      return { status: "ok", certificate: certificateView(record.certificate) };
    }
    if (
      record.certificate &&
      record.certificate.state.type !== "ready" &&
      record.certificate.state.type !== "failed"
    ) {
      return { status: "in-progress" };
    }

    const certificateID = Certificate.ID.makeUnsafe(`cert_${crypto.randomUUID()}`);
    const certificate = new Certificate.Info({
      id: certificateID,
      state: new Certificate.StateIssuing({ type: "issuing" }),
    });
    const issuing = {
      ...record,
      certificateID,
      certificate,
      certificateCsr: csr,
      certificateIdentifiers: identifiers,
    };
    await this.save(issuing);
    try {
      await this.ensureCertificateWorkflow(issuing, csr, identifiers);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.save({
        ...issuing,
        certificate: new Certificate.Info({
          id: certificateID,
          state: new Certificate.StateFailed({ type: "failed", reason }),
        }),
      });
      return { status: "workflow-unavailable", message: reason };
    }
    return { status: "ok", certificate: certificateView(certificate) };
  }

  async remove(token: string): Promise<"ok" | "not-found" | "unauthorized"> {
    const record = await this.record();
    if (!record || record.deletedAt) return "not-found";
    if ((await hashToken(token)) !== record.tokenHash) return "unauthorized";
    for (const socket of this.ctx.getWebSockets("bridge")) socket.close(1000, "deleted");
    for (const channel of this.channels.values()) channel.finish(new Error("Tunnel deleted"));
    this.channels.clear();
    await this.save({ ...record, state: "offline", deletedAt: new Date().toISOString() });
    return "ok";
  }

  async fetch(request: Request): Promise<Response> {
    const record = await this.record();
    if (!record || record.deletedAt) return new Response("Tunnel not found", { status: 404 });
    return this.upgradeBridge(request, record);
  }

  private async upgradeBridge(request: Request, record: StoredTunnel): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const protocols = request.headers.get("sec-websocket-protocol")?.split(",").map((x) => x.trim());
    if (!protocols?.includes(BridgeProtocol.WEBSOCKET_SUBPROTOCOL)) {
      return new Response("Expected opentunnel WebSocket subprotocol", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.serializeAttachment({ kind: "bridge", attached: false } satisfies BridgeAttachment);
    this.ctx.acceptWebSocket(server, ["bridge"]);

    return new Response(null, {
      status: 101,
      headers: { "Sec-WebSocket-Protocol": BridgeProtocol.WEBSOCKET_SUBPROTOCOL },
      webSocket: client,
    });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = socket.deserializeAttachment() as BridgeAttachment | null;
    if (!attachment || attachment.kind !== "bridge") return socket.close(1008, "invalid session");

    if (typeof message !== "string") {
      if (!attachment.attached) return socket.close(1008, "attach required");
      const frame = BridgeProtocol.parseDataFrame(new Uint8Array(message));
      if (!frame) return;
      const channel = this.channels.get(frame.conn);
      if (channel?.bridge === socket) await channel.writer.write(frame.payload);
      return;
    }

    const control = parseControl(message);
    if (!control || typeof control.type !== "string") return socket.close(1008, "invalid control");

    if (!attachment.attached) {
      if (control.type !== "attach" || typeof control.token !== "string") {
        return socket.close(1008, "attach required");
      }
      const record = await this.record();
      if (!record || record.deletedAt || (await hashToken(control.token)) !== record.tokenHash) {
        socket.send(JSON.stringify({ type: "attach_error", code: "bad_token" }));
        return socket.close(1008, "bad token");
      }
      if (record.certificate?.state.type !== "ready") {
        socket.send(JSON.stringify({ type: "attach_error", code: "cert_not_ready" }));
        return socket.close(1008, "certificate not ready");
      }

      const requestedRoutes = Array.isArray(control.routes)
        ? [...new Set(control.routes.filter((route): route is string => typeof route === "string"))]
        : ["@"]; // Legacy clients attach the base hostname.
      if (requestedRoutes.length === 0 || requestedRoutes.some((route) => !validRoute(route))) {
        socket.send(JSON.stringify({ type: "attach_error", code: "invalid_route" }));
        return socket.close(1008, "invalid route");
      }
      const conflict = this.ctx.getWebSockets("bridge").some((candidate) => {
        if (candidate === socket || candidate.readyState !== WebSocket.OPEN) return false;
        const existing = candidate.deserializeAttachment() as BridgeAttachment | null;
        return existing?.attached && existing.routes?.some((route) => requestedRoutes.includes(route));
      });
      if (conflict) {
        socket.send(JSON.stringify({ type: "attach_error", code: "route_conflict" }));
        return socket.close(1008, "route conflict");
      }

      const session = `sess_${crypto.randomUUID()}`;
      socket.serializeAttachment({
        kind: "bridge",
        attached: true,
        session,
        routes: requestedRoutes,
      } satisfies BridgeAttachment);
      await this.save({ ...record, state: "online" });
      socket.send(
        JSON.stringify({
          type: "attached",
          session,
          routes: requestedRoutes,
          heartbeat_ms: BridgeProtocol.BridgeTiming.HEARTBEAT_MS,
          idle_timeout_ms: BridgeProtocol.BridgeTiming.IDLE_TIMEOUT_MS,
        }),
      );
      return;
    }

    if (control.type === "ping" && typeof control.time_sent === "number") {
      socket.send(JSON.stringify({ type: "pong", time_sent: control.time_sent }));
      return;
    }
    if ((control.type === "end" || control.type === "reset") && typeof control.conn === "number") {
      const channel = this.channels.get(control.conn);
      if (channel?.bridge === socket) {
        channel.finish(
          control.type === "reset" ? new Error(String(control.code ?? "reset")) : undefined,
        );
      }
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    const attachment = socket.deserializeAttachment() as BridgeAttachment | null;
    const record = await this.record();
    if (!attachment?.session) return;
    for (const channel of this.channels.values()) {
      if (channel.bridge === socket) channel.finish(new Error("Bridge disconnected"));
    }
    const hasAttachedBridge = this.ctx.getWebSockets("bridge").some((candidate) => {
      if (candidate === socket || candidate.readyState !== WebSocket.OPEN) return false;
      return (candidate.deserializeAttachment() as BridgeAttachment | null)?.attached === true;
    });
    if (record && !record.deletedAt && !hasAttachedBridge) {
      await this.save({ ...record, state: "offline" });
    }
  }

  webSocketError(socket: WebSocket, error: unknown): void {
    socket.close(1011, error instanceof Error ? error.message.slice(0, 120) : "bridge error");
  }

  async connect(socket: Socket): Promise<void> {
    const record = await this.record();
    const info = await socket.opened;
    const reader = socket.readable.getReader();
    const initial: Uint8Array[] = [];
    let initialLength = 0;
    let sni: string | undefined;
    let alpn = "";
    while (initialLength < 64 * 1024) {
      const item = await reader.read();
      if (item.done) break;
      initial.push(item.value);
      initialLength += item.value.byteLength;
      const parsed = parseClientHello(concatBytes(initial, initialLength));
      if (parsed.status === "invalid") break;
      if (parsed.status === "complete") {
        sni = parsed.value.serverName;
        alpn = parsed.value.alpn;
        break;
      }
    }
    const route = sni === record?.hostname
      ? "@"
      : sni?.endsWith(`.${record?.hostname}`)
        ? sni.slice(0, -String(record?.hostname).length - 1)
        : undefined;
    const bridge = this.ctx
      .getWebSockets("bridge")
      .find((candidate) => {
        const attached = candidate.deserializeAttachment() as BridgeAttachment | null;
        return attached?.attached && route !== undefined && attached.routes?.includes(route);
      });
    console.log("Routing TCP connection", {
      tunnel: record?.id,
      sni,
      route,
      certificate: record?.certificate?.state.type,
      bridges: this.ctx.getWebSockets("bridge").map((candidate) =>
        candidate.deserializeAttachment() as BridgeAttachment | null
      ),
      matched: bridge !== undefined,
    });
    if (
      !record ||
      record.deletedAt ||
      record.certificate?.state.type !== "ready" ||
      !route ||
      route.includes(".") ||
      !bridge
    ) {
      reader.releaseLock();
      await socket.close();
      return;
    }

    let conn = this.sequence++ >>> 0;
    while (conn === 0 || this.channels.has(conn)) conn = this.sequence++ >>> 0;

    const writer = socket.writable.getWriter();
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const done = new Promise<void>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    let finished = false;
    const channel: Channel = {
      bridge,
      writer,
      done,
      finish: (error) => {
        if (finished) return;
        finished = true;
        this.channels.delete(conn);
        if (error) {
          void writer.abort(error).catch(() => undefined);
          reject(error);
        } else {
          void writer.close().catch(() => undefined);
          resolve();
        }
      },
    };
    this.channels.set(conn, channel);

    bridge.send(
      JSON.stringify({
        type: "open",
        conn,
        peer: info.remoteAddress ?? "unknown",
        sni,
        alpn,
      }),
    );
    for (const chunk of initial) {
      bridge.send(BridgeProtocol.buildDataFrame(conn, chunk));
    }

    const upload = async () => {
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          if (bridge.bufferedAmount > 16 * 1024 * 1024) throw new Error("Bridge backpressure limit");
          bridge.send(BridgeProtocol.buildDataFrame(conn, item.value));
        }
        bridge.send(JSON.stringify({ type: "end", conn }));
      } catch (error) {
        bridge.send(JSON.stringify({ type: "reset", conn, code: "client_io_error" }));
        channel.finish(error);
      } finally {
        reader.releaseLock();
      }
    };

    await Promise.allSettled([upload(), done]);
    channel.finish();
  }

  private async ensureCertificateWorkflow(
    record: StoredTunnel,
    csr: string,
    identifiers: ReadonlyArray<string> = record.certificateIdentifiers ?? [record.hostname],
  ): Promise<void> {
    if (!record.certificateID) throw new Error("Certificate ID is missing");
    const create = () =>
      env.CERTIFICATES.create({
        id: String(record.certificateID),
        params: {
          tunnelID: String(record.id),
          certificateID: String(record.certificateID),
          hostname: String(record.hostname),
          identifiers: identifiers.map(String),
          csr,
        },
      });

    let instance: WorkflowInstance;
    try {
      instance = await env.CERTIFICATES.get(String(record.certificateID));
    } catch (error) {
      if (error instanceof Error && error.message.includes("instance.not_found")) {
        await create();
        return;
      }
      throw error;
    }

    const status = await instance.status();
    if (status.status === "unknown") {
      await create();
    } else if (status.status === "errored" || status.status === "terminated") {
      await instance.restart();
    }
  }
}
