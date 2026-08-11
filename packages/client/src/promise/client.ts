import { Effect, Exit, ManagedRuntime, Scope, Stream } from "effect";
import {
  OpenTunnelClient,
  type OpenTunnelClientOptions as EffectClientOptions,
} from "../effect/client.js";
import type {
  OpenTunnelClientEvent,
  OpenTunnelIdentity,
  OpenTunnelPendingIdentity,
  OpenTunnelProfileOptions,
  OpenTunnelProvisionStage,
  OpenTunnelRoute,
  OpenTunnelStoredTunnel,
} from "../effect/types.js";
import { toEffectStorage, type OpenTunnelStorage } from "./storage.js";

export interface OpenTunnelClientOptions {
  readonly api?: URL | string;
  readonly store?: OpenTunnelStorage;
}

export interface OpenTunnelConnection {
  readonly tunnel: OpenTunnelIdentity;
  readonly routes: ReadonlyArray<OpenTunnelRoute>;
  readonly events: AsyncIterable<OpenTunnelClientEvent>;
  readonly closed: Promise<void>;
  readonly close: () => Promise<void>;
}

export interface OpenTunnelPromiseClient {
  readonly profile: {
    readonly list: () => Promise<ReadonlyArray<string>>;
  };
  readonly route: {
    readonly list: (options?: OpenTunnelProfileOptions) => Promise<ReadonlyArray<OpenTunnelRoute>>;
    readonly add: (
      options: OpenTunnelProfileOptions & { readonly name: string; readonly target: string },
    ) => Promise<OpenTunnelRoute>;
    readonly remove: (
      options: OpenTunnelProfileOptions & { readonly name: string },
    ) => Promise<void>;
  };
  readonly tunnel: {
    readonly list: () => Promise<ReadonlyArray<OpenTunnelStoredTunnel>>;
    readonly get: (options?: OpenTunnelProfileOptions) => Promise<OpenTunnelIdentity | undefined>;
    readonly pending: (
      options?: OpenTunnelProfileOptions,
    ) => Promise<Pick<OpenTunnelPendingIdentity, "id" | "hostname"> | undefined>;
    readonly resume: (
      options?: OpenTunnelProfileOptions & {
        readonly onProgress?: (stage: OpenTunnelProvisionStage) => void;
      },
    ) => Promise<OpenTunnelIdentity | undefined>;
    readonly create: (
      options?: OpenTunnelProfileOptions & {
        readonly name?: string;
        readonly onProgress?: (stage: OpenTunnelProvisionStage) => void;
      },
    ) => Promise<OpenTunnelIdentity>;
    readonly ensure: (
      options?: OpenTunnelProfileOptions & { readonly name?: string },
    ) => Promise<OpenTunnelIdentity>;
    readonly remove: (options?: OpenTunnelProfileOptions) => Promise<void>;
    readonly connect: (
      options?: OpenTunnelProfileOptions & { readonly signal?: AbortSignal },
    ) => Promise<OpenTunnelConnection>;
  };
  readonly dispose: () => Promise<void>;
}

export function create(options: OpenTunnelClientOptions = {}): OpenTunnelPromiseClient {
  const effectOptions: EffectClientOptions = {
    api: options.api,
    ...(options.store ? { storage: toEffectStorage(options.store) } : {}),
  };
  const runtime = ManagedRuntime.make(OpenTunnelClient.layer(effectOptions));
  const withClient = <A, E>(
    f: (client: OpenTunnelClient["Service"]) => Effect.Effect<A, E>,
  ) => runtime.runPromise(Effect.flatMap(OpenTunnelClient.asEffect(), f));

  return {
    profile: { list: () => withClient((client) => client.profile.list()) },
    route: {
      list: (input) => withClient((client) => client.route.list(input)),
      add: (input) => withClient((client) => client.route.add(input)),
      remove: (input) => withClient((client) => client.route.remove(input)),
    },
    tunnel: {
      list: () => withClient((client) => client.tunnel.list()),
      get: (input) => withClient((client) => client.tunnel.get(input)),
      pending: (input) => withClient((client) => client.tunnel.pending(input)),
      resume: (input) => withClient((client) => client.tunnel.resume(input)),
      create: (input) => withClient((client) => client.tunnel.create(input)),
      ensure: (input) => withClient((client) => client.tunnel.ensure(input)),
      remove: (input) => withClient((client) => client.tunnel.remove(input)),
      connect: async (input) => {
        const scope = await runtime.runPromise(Scope.make());
        const connection = await runtime.runPromise(
          Effect.flatMap(OpenTunnelClient.asEffect(), (client) => client.tunnel.connect(input)).pipe(
            Effect.provideService(Scope.Scope, scope),
          ),
        );
        const closeScope = () => runtime.runPromise(Scope.close(scope, Exit.succeed(undefined)));
        return {
          tunnel: connection.tunnel,
          routes: connection.routes,
          events: Stream.toAsyncIterable(connection.events),
          closed: runtime.runPromise(connection.closed).finally(closeScope),
          close: () => runtime.runPromise(connection.close).finally(closeScope),
        };
      },
    },
    dispose: () => runtime.dispose(),
  };
}
