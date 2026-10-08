export * as Analytics from "./analytics.js";

import { env, waitUntil } from "cloudflare:workers";

/** Envelope of the platform event stream (`platform_<stack>_event`). */
export type Event<T extends Type = Type> = {
  readonly source: "opentunnel";
  readonly type: T;
  /** RFC 3339, the stream's timestamp format. */
  readonly timestamp: string;
  readonly payload: Payloads[T] & { readonly schema_version: 1 };
};

/** The HTTP client that made a request, from the first product token of its user agent. */
export interface Client {
  /**
   * `cli` is the Rust CLI (`opentunnel/<version>`), `sdk` the TypeScript SDK (`opentunnel-sdk/<version>`, or
   * a bare `Bun/<version>` from SDK releases before it identified itself); `none` means no user agent was sent.
   */
  readonly client: "cli" | "sdk" | "other" | "none";
  readonly client_version?: string;
}

interface Geo {
  readonly country?: string;
  readonly colo?: string;
}

export type CertificateFailure =
  | "workflow_start"
  | "config"
  | "dns"
  | "acme_rate_limit"
  | "acme_authorization"
  | "acme_order"
  | "acme_http"
  | "persist"
  | "other";

export type ConnectionOutcome =
  | "closed"
  | "reset"
  | "bridge_disconnected"
  | "deleted"
  | "backpressure"
  | "client_error"
  | "no_bridge"
  | "unknown_route"
  | "certificate_not_ready";

export interface Payloads {
  readonly "tunnel.created": { readonly tunnel_id: string } & Client & Geo;
  readonly "tunnel.deleted": { readonly tunnel_id: string; readonly age_ms: number };
  readonly "bridge.connected": {
    readonly tunnel_id: string;
    readonly session_id: string;
    readonly route_count: number;
  } & Client & Geo;
  readonly "bridge.disconnected": {
    readonly tunnel_id: string;
    readonly session_id: string;
    readonly route_count: number;
    readonly duration_ms: number;
    readonly code: number;
    readonly clean: boolean;
  };
  readonly "tunnel.active": {
    readonly tunnel_id: string;
    readonly session_id: string;
    readonly route_count: number;
    readonly connected_ms: number;
    readonly open_connections: number;
  };
  readonly "certificate.issued": {
    readonly tunnel_id: string;
    readonly certificate_id: string;
    readonly duration_ms?: number;
  };
  readonly "certificate.renewed": {
    readonly tunnel_id: string;
    readonly certificate_id: string;
    readonly duration_ms: number;
  };
  readonly "certificate.failed": {
    readonly tunnel_id: string;
    readonly certificate_id: string;
    readonly renewal: boolean;
    readonly reason: CertificateFailure;
    readonly duration_ms?: number;
  };
  readonly "connection.closed": {
    readonly tunnel_id: string;
    readonly outcome: ConnectionOutcome;
    readonly duration_ms: number;
    /** Visitor to tunnel client, including the replayed ClientHello. */
    readonly bytes_in: number;
    /** Tunnel client to visitor. */
    readonly bytes_out: number;
  };
}

export type Type = keyof Payloads;

/** How often an attached bridge reports `tunnel.active`, piggybacking on its client's pings. */
export const ACTIVE_INTERVAL_MS = 5 * 60 * 1000;

export const event = <T extends Type>(type: T, payload: Payloads[T], now = new Date()): Event<T> => ({
  source: "opentunnel",
  type,
  timestamp: now.toISOString(),
  payload: { schema_version: 1, ...payload },
});

/**
 * Sends one event without blocking the caller. Analytics never affect tunnels: a missing binding or a
 * failed send is logged and dropped.
 */
export const publish = <T extends Type>(type: T, payload: Payloads[T]): void => {
  try {
    const record = event(type, payload);
    waitUntil(
      Promise.resolve()
        .then(() => env.EVENTS.send([record]))
        .catch((error) => console.error("Analytics event dropped", { type, error: String(error) })),
    );
  } catch (error) {
    console.error("Analytics event dropped", { type, error: String(error) });
  }
};

export const client = (userAgent: string | null | undefined): Client => {
  const token = /^([A-Za-z][\w.-]*)(?:\/([\w.+-]{1,32}))?/.exec(userAgent?.trim() ?? "");
  if (!token) return { client: "none" };
  const name = token[1]!.toLowerCase();
  const kind = name === "opentunnel" ? "cli" : name === "opentunnel-sdk" ? "sdk" : name === "bun" ? "sdk" : undefined;
  if (!kind) return { client: "other" };
  // A bare Bun user agent carries the runtime's version, not the SDK's.
  return token[2] && name !== "bun" ? { client: kind, client_version: token[2] } : { client: kind };
};

/** Coarse location of a request: Cloudflare's country code and data center, never the address. */
export const geo = (request: Request): Geo => {
  const cf = request.cf as IncomingRequestCfProperties | undefined;
  return {
    ...(cf?.country ? { country: cf.country } : {}),
    ...(cf?.colo ? { colo: cf.colo } : {}),
  };
};

/** Buckets a certificate failure message; the message itself can carry ACME response bodies. */
export const certificateFailure = (reason: string): CertificateFailure => {
  if (/required|not a P-256/.test(reason)) return "config";
  if (/HTTP 429|rateLimited/i.test(reason)) return "acme_rate_limit";
  if (/DNS/.test(reason)) return "dns";
  if (/authorization|dns-01/.test(reason)) return "acme_authorization";
  if (/ACME order|finalize/.test(reason)) return "acme_order";
  if (/persist certificate state/.test(reason)) return "persist";
  if (/HTTP \d{3}/.test(reason)) return "acme_http";
  return "other";
};
