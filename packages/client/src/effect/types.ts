import type { Effect, Scope, Stream } from "effect";
import type { OpenTunnelError } from "./errors.js";

export interface OpenTunnelProfileOptions {
  readonly profile?: string;
}

export type OpenTunnelProvisionStage =
  | "creating-tunnel"
  | "generating-key"
  | "generating-csr"
  | "resuming-certificate"
  | "requesting-certificate"
  | "waiting-certificate"
  | "saving-identity"
  | "ready";

/** Route name (`@` for the tunnel hostname, or a subdomain label) to `host:port`. */
export type OpenTunnelRoutes = Readonly<Record<string, string>>;

export interface OpenTunnelIdentity {
  readonly id: string;
  readonly hostname: string;
  readonly token: string;
  readonly privateKey: string;
  readonly certificate: string;
  readonly chain: string;
  readonly certificateExpiry: Date;
}

export interface OpenTunnelPendingIdentity {
  readonly id: string;
  readonly hostname: string;
  readonly token: string;
  readonly privateKey: string;
  readonly csr: string;
}

export interface OpenTunnelStoredTunnel {
  readonly profile: string;
  readonly tunnel: OpenTunnelIdentity;
}

export type OpenTunnelClientEvent =
  | { readonly type: "connecting"; readonly attempt: number }
  | { readonly type: "connected"; readonly session: string; readonly routes: ReadonlyArray<string> }
  | { readonly type: "disconnected"; readonly reason: string }
  | { readonly type: "reconnecting"; readonly attempt: number; readonly delayMs: number }
  | { readonly type: "connection-opened"; readonly conn: number; readonly route: string; readonly peer: string }
  | { readonly type: "connection-closed"; readonly conn: number; readonly route: string; readonly error?: string }
  | { readonly type: "certificate-renewed"; readonly expiry: string }
  | { readonly type: "stopped"; readonly error?: string };

export interface OpenTunnelStatus {
  readonly state: "waiting-routes" | "connecting" | "connected" | "reconnecting" | "stopped";
  readonly hostname: string;
  readonly routes: OpenTunnelRoutes;
  readonly session?: string;
  readonly connections: number;
  readonly lastError?: string;
  /** Unix milliseconds of the last successful attach. */
  readonly connectedAt?: number;
}

export interface OpenTunnelConnectOptions extends OpenTunnelProfileOptions {
  readonly routes: OpenTunnelRoutes;
}

export interface OpenTunnelConnection {
  readonly tunnel: OpenTunnelIdentity;
  readonly events: Stream.Stream<OpenTunnelClientEvent>;
  readonly status: Effect.Effect<OpenTunnelStatus>;
  readonly setRoutes: (routes: OpenTunnelRoutes) => Effect.Effect<void, OpenTunnelError>;
  /** Completes when the tunnel stops after a fatal error or is closed. */
  readonly closed: Effect.Effect<void, OpenTunnelError>;
  readonly close: Effect.Effect<void>;
}

export interface OpenTunnelEffectClient {
  readonly profile: {
    readonly list: () => Effect.Effect<ReadonlyArray<string>, OpenTunnelError>;
  };
  readonly tunnel: {
    readonly list: () => Effect.Effect<ReadonlyArray<OpenTunnelStoredTunnel>, OpenTunnelError>;
    readonly get: (
      options?: OpenTunnelProfileOptions,
    ) => Effect.Effect<OpenTunnelIdentity | undefined, OpenTunnelError>;
    readonly pending: (
      options?: OpenTunnelProfileOptions,
    ) => Effect.Effect<Pick<OpenTunnelPendingIdentity, "id" | "hostname"> | undefined, OpenTunnelError>;
    readonly resume: (
      options?: OpenTunnelProfileOptions & {
        readonly onProgress?: (stage: OpenTunnelProvisionStage) => void;
      },
    ) => Effect.Effect<OpenTunnelIdentity | undefined, OpenTunnelError>;
    readonly create: (
      options?: OpenTunnelProfileOptions & {
        readonly onProgress?: (stage: OpenTunnelProvisionStage) => void;
      },
    ) => Effect.Effect<OpenTunnelIdentity, OpenTunnelError>;
    readonly ensure: (
      options?: OpenTunnelProfileOptions,
    ) => Effect.Effect<OpenTunnelIdentity, OpenTunnelError>;
    readonly remove: (
      options?: OpenTunnelProfileOptions,
    ) => Effect.Effect<void, OpenTunnelError>;
    /**
     * Starts forwarding routes for the profile's tunnel, creating it if
     * needed. Succeeds once the bridge first attaches and keeps reconnecting
     * until the scope closes.
     */
    readonly connect: (
      options: OpenTunnelConnectOptions,
    ) => Effect.Effect<OpenTunnelConnection, OpenTunnelError, Scope.Scope>;
  };
}
