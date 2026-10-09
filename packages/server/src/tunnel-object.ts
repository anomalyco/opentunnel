import { DurableObject, env } from "cloudflare:workers";
import { Pkcs10CertificateRequest, SubjectAlternativeNameExtension } from "@peculiar/x509";
import { BridgeProtocol } from "@opentunnel/protocol/bridge-protocol";
import { Certificate } from "@opentunnel/protocol/certificate";
import { CSR } from "@opentunnel/protocol/csr";
import { Tunnel } from "@opentunnel/protocol/tunnel";
import { concatBytes, parseClientHello } from "./tls-client-hello.js";
import type { StoredTunnel } from "./stored-tunnel.js";
import { hashToken } from "./crypto.js";
import { Analytics } from "./analytics.js";

interface BridgeAttachment {
  readonly kind: "bridge";
  readonly attached: boolean;
  readonly session?: string;
  readonly routes?: ReadonlyArray<string>;
  /** Server time this bridge last sent anything, recorded at most once per heartbeat. */
  readonly seenAt?: number;
  /** Analytics context, captured from the upgrade request and on attach. */
  readonly analytics?: Analytics.Client & {
    readonly country?: string;
    readonly colo?: string;
    readonly tunnel?: string;
    readonly attachedAt?: number;
    readonly activeAt?: number;
  };
}

interface Channel {
  readonly bridge: WebSocket;
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly done: Promise<void>;
  bytesOut: number;
  finish(outcome: Analytics.ConnectionOutcome, error?: unknown): void;
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

const DAY_MS = 24 * 60 * 60 * 1000;
/** Renew this long before the current certificate expires. */
const RENEW_BEFORE_MS = 30 * DAY_MS;
/** Tunnels with no connection in this window are not renewed and expire. */
const ACTIVE_WINDOW_MS = 90 * DAY_MS;
const RENEWAL_RETRY_MS = 60 * 60 * 1000;
/** A renewal still running after this long is treated as lost and restarted. */
const RENEWAL_STALE_MS = DAY_MS;

const BACKPRESSURE = "Bridge backpressure limit";

/**
 * A bridge silent for this long is gone. Its client pings every heartbeat and gives up after the idle timeout
 * itself; one heartbeat more covers `seenAt` being recorded at most once per heartbeat.
 */
const STALE_BRIDGE_MS = BridgeProtocol.BridgeTiming.IDLE_TIMEOUT_MS + BridgeProtocol.BridgeTiming.HEARTBEAT_MS;

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
      id: Tunnel.ID.make(input.id),
      hostname: CSR.Hostname.make(input.hostname),
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
    if (!record || record.deletedAt) return false;
    if (record.renewal && String(record.renewal.certificateID) === id) {
      const duration_ms = Date.now() - Date.parse(record.renewal.startedAt);
      if (input.type === "ready") {
        const renewed: StoredTunnel = {
          ...record,
          certificateID: record.renewal.certificateID,
          certificate: new Certificate.Info({
            id: record.renewal.certificateID,
            state: new Certificate.StateReady(input),
          }),
          renewal: undefined,
        };
        await this.save(renewed);
        await this.scheduleRenewal(renewed);
        Analytics.publish("certificate.renewed", { tunnel_id: String(record.id), certificate_id: id, duration_ms });
      } else if (input.type === "failed") {
        console.error("Certificate renewal failed", { tunnel: record.id, reason: input.reason });
        Analytics.publish("certificate.failed", {
          tunnel_id: String(record.id),
          certificate_id: id,
          renewal: true,
          reason: Analytics.certificateFailure(input.reason),
          duration_ms,
        });
        await this.save({ ...record, renewal: undefined });
        await this.ctx.storage.setAlarm(Date.now() + RENEWAL_RETRY_MS);
      }
      return true;
    }
    if (String(record.certificateID) !== id) return false;
    const state = input.type === "issuing"
      ? new Certificate.StateIssuing(input)
      : input.type === "challenge"
        ? new Certificate.StateChallenge(input)
        : input.type === "ready"
          ? new Certificate.StateReady(input)
          : new Certificate.StateFailed(input);
    const updated: StoredTunnel = {
      ...record,
      certificate: new Certificate.Info({ id: Certificate.ID.make(id), state }),
    };
    await this.save(updated);
    await this.scheduleRenewal(updated);
    const previous = record.certificate?.state.type;
    const duration = record.certificateStartedAt
      ? { duration_ms: Date.now() - Date.parse(record.certificateStartedAt) }
      : {};
    if (input.type === "ready" && previous !== "ready") {
      Analytics.publish("certificate.issued", { tunnel_id: String(record.id), certificate_id: id, ...duration });
    } else if (input.type === "failed" && previous !== "failed") {
      Analytics.publish("certificate.failed", {
        tunnel_id: String(record.id),
        certificate_id: id,
        renewal: false,
        reason: Analytics.certificateFailure(input.reason),
        ...duration,
      });
    }
    return true;
  }

  /** Renews the certificate of active tunnels shortly before it expires. */
  async alarm(): Promise<void> {
    const record = await this.record();
    if (!record || record.deletedAt || record.certificate?.state.type !== "ready") return;
    if (record.renewal && Date.now() - Date.parse(record.renewal.startedAt) < RENEWAL_STALE_MS) return;
    if (Date.parse(record.certificate.state.expiry) - RENEW_BEFORE_MS > Date.now()) {
      await this.scheduleRenewal(record);
      return;
    }
    if (!this.isActive(record)) return;
    await this.startRenewal(record);
  }

  private async scheduleRenewal(record: StoredTunnel): Promise<void> {
    const state = record.certificate?.state;
    if (record.deletedAt || state?.type !== "ready") return;
    const renewAt = Date.parse(state.expiry) - RENEW_BEFORE_MS;
    await this.ctx.storage.setAlarm(Math.max(renewAt, Date.now() + 60_000));
  }

  private isActive(record: StoredTunnel): boolean {
    if (this.attachedBridges().length > 0) return true;
    return record.lastConnectedAt !== undefined &&
      Date.now() - Date.parse(record.lastConnectedAt) < ACTIVE_WINDOW_MS;
  }

  /** Records that an attached bridge is alive, at most once per heartbeat rather than once per frame. */
  private touch(socket: WebSocket, attachment: BridgeAttachment): BridgeAttachment {
    const now = Date.now();
    if (attachment.seenAt !== undefined && now - attachment.seenAt < BridgeProtocol.BridgeTiming.HEARTBEAT_MS) {
      return attachment;
    }
    const touched = { ...attachment, seenAt: now } satisfies BridgeAttachment;
    socket.serializeAttachment(touched);
    return touched;
  }

  /**
   * Retires attached bridges whose client is gone. A client that vanishes without a close (sleep, a network
   * change) leaves its socket open here until Cloudflare notices, which can take over an hour. Until then the
   * bridge would keep its routes, so the client's reconnects get `route_conflict`, and it would swallow every
   * public connection routed to it. The bridge is detached before closing because the close handshake may never
   * complete.
   */
  private async retireStaleBridges(): Promise<void> {
    const now = Date.now();
    let retired = false;
    for (const socket of this.ctx.getWebSockets("bridge")) {
      const attachment = socket.deserializeAttachment() as BridgeAttachment | null;
      if (attachment?.kind !== "bridge" || !attachment.attached) continue;
      if (socket.readyState === WebSocket.OPEN) {
        // Bridges attached before `seenAt` existed get one idle period from now.
        if (attachment.seenAt === undefined) {
          socket.serializeAttachment({ ...attachment, seenAt: now } satisfies BridgeAttachment);
          continue;
        }
        if (now - attachment.seenAt <= STALE_BRIDGE_MS) continue;
      }
      socket.serializeAttachment({ ...attachment, attached: false } satisfies BridgeAttachment);
      for (const channel of this.channels.values()) {
        if (channel.bridge === socket) channel.finish("bridge_disconnected", new Error("Bridge idle timeout"));
      }
      try {
        socket.close(1001, "idle timeout");
      } catch {
        // Already closing.
      }
      this.publishDisconnected(attachment, 1001, false);
      retired = true;
    }
    if (!retired || this.attachedBridges().length > 0) return;
    const record = await this.record();
    if (record && !record.deletedAt) await this.save({ ...record, state: "offline" });
  }

  private publishDisconnected(attachment: BridgeAttachment, code: number, clean: boolean): void {
    const analytics = attachment.analytics;
    if (!attachment.session || !analytics?.tunnel || analytics.attachedAt === undefined) return;
    Analytics.publish("bridge.disconnected", {
      tunnel_id: analytics.tunnel,
      session_id: attachment.session,
      route_count: attachment.routes?.length ?? 0,
      duration_ms: Date.now() - analytics.attachedAt,
      code,
      clean,
    });
  }

  private attachedBridges(): WebSocket[] {
    return this.ctx.getWebSockets("bridge").filter((socket) =>
      (socket.deserializeAttachment() as BridgeAttachment | null)?.attached === true
    );
  }

  /** Issues a new certificate from the stored CSR; the current one serves until it is ready. */
  private async startRenewal(record: StoredTunnel): Promise<void> {
    if (!record.certificateCsr) return;
    const certificateID = Certificate.ID.make(`cert_${crypto.randomUUID()}`);
    await this.save({ ...record, renewal: { certificateID, startedAt: new Date().toISOString() } });
    try {
      await env.CERTIFICATES.create({
        id: String(certificateID),
        params: {
          tunnelID: String(record.id),
          certificateID: String(certificateID),
          hostname: String(record.hostname),
          identifiers: (record.certificateIdentifiers ?? [record.hostname]).map(String),
          csr: record.certificateCsr,
        },
      });
    } catch (error) {
      console.error("Failed to start certificate renewal", { tunnel: record.id, error: String(error) });
      Analytics.publish("certificate.failed", {
        tunnel_id: String(record.id),
        certificate_id: String(certificateID),
        renewal: true,
        reason: "workflow_start",
      });
      await this.save({ ...record, renewal: undefined });
      await this.ctx.storage.setAlarm(Date.now() + RENEWAL_RETRY_MS);
    }
  }

  /**
   * Renews on connect when the certificate is close to or past expiry, which
   * covers tunnels that went idle and come back, and schedules the renewal
   * alarm for tunnels created before renewals existed.
   */
  private async onAttached(record: StoredTunnel): Promise<void> {
    const state = record.certificate?.state;
    if (state?.type !== "ready") return;
    const staleRenewal = record.renewal &&
      Date.now() - Date.parse(record.renewal.startedAt) >= RENEWAL_STALE_MS;
    if ((!record.renewal || staleRenewal) && Date.parse(state.expiry) - RENEW_BEFORE_MS <= Date.now()) {
      await this.startRenewal(record);
    } else if ((await this.ctx.storage.getAlarm()) === null) {
      await this.scheduleRenewal(record);
    }
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

    const certificateID = Certificate.ID.make(`cert_${crypto.randomUUID()}`);
    const certificate = new Certificate.Info({
      id: certificateID,
      state: new Certificate.StateIssuing({ type: "issuing" }),
    });
    const issuing: StoredTunnel = {
      ...record,
      certificateID,
      certificate,
      certificateCsr: csr,
      certificateIdentifiers: identifiers,
      certificateStartedAt: new Date().toISOString(),
      renewal: undefined,
    };
    await this.save(issuing);
    try {
      await this.ensureCertificateWorkflow(issuing, csr, identifiers);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      Analytics.publish("certificate.failed", {
        tunnel_id: String(record.id),
        certificate_id: String(certificateID),
        renewal: false,
        reason: "workflow_start",
      });
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
    for (const channel of this.channels.values()) channel.finish("deleted", new Error("Tunnel deleted"));
    this.channels.clear();
    await this.save({ ...record, state: "offline", deletedAt: new Date().toISOString() });
    Analytics.publish("tunnel.deleted", {
      tunnel_id: String(record.id),
      age_ms: Date.now() - Date.parse(record.createdAt),
    });
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
    server.serializeAttachment({
      kind: "bridge",
      attached: false,
      analytics: {
        ...Analytics.client(request.headers.get("user-agent")),
        ...Analytics.geo(request),
      },
    } satisfies BridgeAttachment);
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
      this.touch(socket, attachment);
      const frame = BridgeProtocol.parseDataFrame(new Uint8Array(message));
      if (!frame) return;
      const channel = this.channels.get(frame.conn);
      if (channel?.bridge === socket) {
        channel.bytesOut += frame.payload.byteLength;
        await channel.writer.write(frame.payload);
      }
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
      await this.retireStaleBridges();
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
      const now = Date.now();
      const analytics = {
        client: "none" as const,
        ...attachment.analytics,
        tunnel: String(record.id),
        attachedAt: now,
        activeAt: now,
      };
      socket.serializeAttachment({
        kind: "bridge",
        attached: true,
        session,
        routes: requestedRoutes,
        seenAt: now,
        analytics,
      } satisfies BridgeAttachment);
      const connected: StoredTunnel = {
        ...record,
        state: "online",
        lastConnectedAt: new Date().toISOString(),
      };
      await this.save(connected);
      socket.send(
        JSON.stringify({
          type: "attached",
          session,
          routes: requestedRoutes,
          heartbeat_ms: BridgeProtocol.BridgeTiming.HEARTBEAT_MS,
          idle_timeout_ms: BridgeProtocol.BridgeTiming.IDLE_TIMEOUT_MS,
        }),
      );
      await this.onAttached(connected);
      const { client, client_version, country, colo } = analytics;
      const context = { tunnel_id: String(record.id), session_id: session, route_count: requestedRoutes.length };
      Analytics.publish("bridge.connected", {
        ...context,
        client,
        ...(client_version ? { client_version } : {}),
        ...(country ? { country } : {}),
        ...(colo ? { colo } : {}),
      });
      Analytics.publish("tunnel.active", { ...context, connected_ms: 0, open_connections: 0 });
      return;
    }

    const current = this.touch(socket, attachment);
    if (control.type === "ping" && typeof control.time_sent === "number") {
      socket.send(JSON.stringify({ type: "pong", time_sent: control.time_sent }));
      this.reportActive(socket, current);
      return;
    }
    if ((control.type === "end" || control.type === "reset") && typeof control.conn === "number") {
      const channel = this.channels.get(control.conn);
      if (channel?.bridge === socket) {
        if (control.type === "reset") channel.finish("reset", new Error(String(control.code ?? "reset")));
        else channel.finish("closed");
      }
    }
  }

  /**
   * Reports `tunnel.active` at most once per interval per bridge. Clients ping every few seconds while
   * attached, so this needs no alarm (which belongs to certificate renewal) and stops with the bridge.
   */
  private reportActive(socket: WebSocket, attachment: BridgeAttachment): void {
    const analytics = attachment.analytics;
    if (!analytics?.tunnel || !attachment.session || analytics.attachedAt === undefined) return;
    const now = Date.now();
    if (now - (analytics.activeAt ?? 0) < Analytics.ACTIVE_INTERVAL_MS) return;
    socket.serializeAttachment({ ...attachment, analytics: { ...analytics, activeAt: now } } satisfies BridgeAttachment);
    let open = 0;
    for (const channel of this.channels.values()) if (channel.bridge === socket) open++;
    Analytics.publish("tunnel.active", {
      tunnel_id: analytics.tunnel,
      session_id: attachment.session,
      route_count: attachment.routes?.length ?? 0,
      connected_ms: now - analytics.attachedAt,
      open_connections: open,
    });
  }

  async webSocketClose(socket: WebSocket, code: number, _reason: string, wasClean: boolean): Promise<void> {
    const attachment = socket.deserializeAttachment() as BridgeAttachment | null;
    const record = await this.record();
    // Bridges that never attached have nothing to clean up; retired ones were cleaned up when retired.
    if (!attachment?.session || !attachment.attached) return;
    for (const channel of this.channels.values()) {
      if (channel.bridge === socket) channel.finish("bridge_disconnected", new Error("Bridge disconnected"));
    }
    this.publishDisconnected(attachment, code, wasClean);
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
    const startedAt = Date.now();
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
    await this.retireStaleBridges();
    const bridge = this.ctx
      .getWebSockets("bridge")
      .find((candidate) => {
        if (candidate.readyState !== WebSocket.OPEN) return false;
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
      if (record && !record.deletedAt) {
        Analytics.publish("connection.closed", {
          tunnel_id: String(record.id),
          outcome: record.certificate?.state.type !== "ready"
            ? "certificate_not_ready"
            : !route || route.includes(".")
              ? "unknown_route"
              : "no_bridge",
          duration_ms: Date.now() - startedAt,
          bytes_in: initialLength,
          bytes_out: 0,
        });
      }
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
    let outcome: Analytics.ConnectionOutcome = "closed";
    let bytesIn = initialLength;
    const channel: Channel = {
      bridge,
      writer,
      done,
      bytesOut: 0,
      finish: (reason, error) => {
        if (finished) return;
        finished = true;
        outcome = reason;
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
          if (bridge.bufferedAmount > 16 * 1024 * 1024) throw new Error(BACKPRESSURE);
          bytesIn += item.value.byteLength;
          bridge.send(BridgeProtocol.buildDataFrame(conn, item.value));
        }
        bridge.send(JSON.stringify({ type: "end", conn }));
      } catch (error) {
        bridge.send(JSON.stringify({ type: "reset", conn, code: "client_io_error" }));
        channel.finish(
          error instanceof Error && error.message === BACKPRESSURE ? "backpressure" : "client_error",
          error,
        );
      } finally {
        reader.releaseLock();
      }
    };

    await Promise.allSettled([upload(), done]);
    channel.finish("closed");
    Analytics.publish("connection.closed", {
      tunnel_id: String(record.id),
      outcome,
      duration_ms: Date.now() - startedAt,
      bytes_in: bytesIn,
      bytes_out: channel.bytesOut,
    });
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
