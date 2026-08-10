import type { Effect, Scope, Stream } from "effect";
import type { OpenTunnelError } from "./errors.js";

export interface OpenTunnelProfileOptions {
  readonly profile?: string;
}

export interface OpenTunnelRoute {
  readonly name: string;
  readonly hostname: string;
  readonly target: string;
}

export interface OpenTunnelIdentity {
  readonly id: string;
  readonly hostname: string;
  readonly token: string;
  readonly privateKey: string;
  readonly certificate: string;
  readonly chain: string;
  readonly certificateExpiry: Date;
}

export interface OpenTunnelStoredTunnel {
  readonly profile: string;
  readonly tunnel: OpenTunnelIdentity;
}

export type OpenTunnelClientEvent =
  | { readonly type: "connected" }
  | { readonly type: "disconnected"; readonly reason?: string }
  | { readonly type: "route-open"; readonly route: string; readonly connection: number }
  | { readonly type: "route-close"; readonly route: string; readonly connection: number };

export interface OpenTunnelConnection {
  readonly tunnel: OpenTunnelIdentity;
  readonly routes: ReadonlyArray<OpenTunnelRoute>;
  readonly events: Stream.Stream<OpenTunnelClientEvent>;
  readonly closed: Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
}

export interface OpenTunnelEffectClient {
  readonly profile: {
    readonly list: () => Effect.Effect<ReadonlyArray<string>, OpenTunnelError>;
  };
  readonly route: {
    readonly list: (
      options?: OpenTunnelProfileOptions,
    ) => Effect.Effect<ReadonlyArray<OpenTunnelRoute>, OpenTunnelError>;
    readonly add: (
      options: OpenTunnelProfileOptions & { readonly name: string; readonly target: string },
    ) => Effect.Effect<OpenTunnelRoute, OpenTunnelError>;
    readonly remove: (
      options: OpenTunnelProfileOptions & { readonly name: string },
    ) => Effect.Effect<void, OpenTunnelError>;
  };
  readonly tunnel: {
    readonly list: () => Effect.Effect<ReadonlyArray<OpenTunnelStoredTunnel>, OpenTunnelError>;
    readonly get: (
      options?: OpenTunnelProfileOptions,
    ) => Effect.Effect<OpenTunnelIdentity | undefined, OpenTunnelError>;
    readonly create: (
      options?: OpenTunnelProfileOptions & { readonly name?: string },
    ) => Effect.Effect<OpenTunnelIdentity, OpenTunnelError>;
    readonly ensure: (
      options?: OpenTunnelProfileOptions & { readonly name?: string },
    ) => Effect.Effect<OpenTunnelIdentity, OpenTunnelError>;
    readonly remove: (
      options?: OpenTunnelProfileOptions,
    ) => Effect.Effect<void, OpenTunnelError>;
    readonly connect: (
      options?: OpenTunnelProfileOptions & { readonly signal?: AbortSignal },
    ) => Effect.Effect<OpenTunnelConnection, OpenTunnelError, Scope.Scope>;
  };
}
