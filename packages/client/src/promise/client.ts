import { Effect, Exit, ManagedRuntime, Scope, Stream } from "effect";
import {
  OpenTunnelClient,
  type OpenTunnelClientOptions as EffectClientOptions,
} from "../effect/client.js";
import type {
  OpenTunnelClientEvent,
  OpenTunnelConnectOptions,
  OpenTunnelIdentity,
  OpenTunnelPendingIdentity,
  OpenTunnelProfileOptions,
  OpenTunnelProgressOptions,
  OpenTunnelProvisionStage,
  OpenTunnelRoutes,
  OpenTunnelStatus,
  OpenTunnelStoredTunnel,
  OpenTunnelUrls,
} from "../effect/types.js";
import { toEffectStorage, type OpenTunnelStorage } from "./storage.js";

export interface OpenTunnelClientOptions {
  /** The API to use; defaults to `OPENTUNNEL_API`, then `https://opentunnel.xyz`. */
  readonly api?: URL | string;
  readonly store?: OpenTunnelStorage;
  /**
   * An `http://` or `https://` proxy URL (credentials as userinfo) for the API
   * and the bridge, instead of the one `HTTPS_PROXY`, `HTTP_PROXY`,
   * `ALL_PROXY` and `NO_PROXY` select. On Node it needs the `undici` package.
   * `create` throws an `OpenTunnelClientError` when the proxy cannot be used.
   */
  readonly proxy?: string;
}

export interface OpenTunnelConnection {
  readonly tunnel: OpenTunnelIdentity;
  readonly events: AsyncIterable<OpenTunnelClientEvent>;
  readonly status: () => OpenTunnelStatus;
  /**
   * The public URL of each current route, such as
   * `{ api: "https://api.<hostname>", "@": "https://<hostname>" }`. Follows `setRoutes`.
   */
  readonly urls: OpenTunnelUrls;
  /**
   * Replaces the routes. Changing only targets applies immediately; adding or
   * removing names re-attaches the bridge.
   */
  readonly setRoutes: (routes: OpenTunnelRoutes) => Promise<void>;
  /** Settles when the tunnel stops after a fatal error or is closed. */
  readonly closed: Promise<void>;
  readonly close: () => Promise<void>;
}

export interface OpenTunnelPromiseClient {
  readonly profile: {
    readonly list: () => Promise<ReadonlyArray<string>>;
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
        readonly onProgress?: (stage: OpenTunnelProvisionStage) => void;
      },
    ) => Promise<OpenTunnelIdentity>;
    readonly ensure: (
      options?: OpenTunnelProfileOptions & OpenTunnelProgressOptions,
    ) => Promise<OpenTunnelIdentity>;
    readonly remove: (options?: OpenTunnelProfileOptions) => Promise<void>;
    /**
     * Starts forwarding routes for the profile's tunnel, creating it if
     * needed. Resolves once the bridge first attaches; reconnects until closed.
     * Aborting `signal` while it attaches rejects with the signal's reason and
     * stops the attach and any certificate work; aborting later closes the
     * connection.
     */
    readonly connect: (
      options: OpenTunnelConnectOptions & { readonly signal?: AbortSignal },
    ) => Promise<OpenTunnelConnection>;
  };
  readonly dispose: () => Promise<void>;
}

export function create(options: OpenTunnelClientOptions = {}): OpenTunnelPromiseClient {
  const effectOptions: EffectClientOptions = {
    api: options.api,
    ...(options.proxy === undefined ? {} : { proxy: options.proxy }),
    ...(options.store ? { storage: toEffectStorage(options.store) } : {}),
  };
  const runtime = ManagedRuntime.make(OpenTunnelClient.layer(effectOptions));
  const withClient = <A, E>(
    f: (client: OpenTunnelClient["Service"]) => Effect.Effect<A, E>,
  ) => runtime.runPromise(Effect.flatMap(OpenTunnelClient, f));

  return {
    profile: { list: () => withClient((client) => client.profile.list()) },
    tunnel: {
      list: () => withClient((client) => client.tunnel.list()),
      get: (input) => withClient((client) => client.tunnel.get(input)),
      pending: (input) => withClient((client) => client.tunnel.pending(input)),
      resume: (input) => withClient((client) => client.tunnel.resume(input)),
      create: (input) => withClient((client) => client.tunnel.create(input)),
      ensure: (input) => withClient((client) => client.tunnel.ensure(input)),
      remove: (input) => withClient((client) => client.tunnel.remove(input)),
      connect: async (input) => {
        const signal = input.signal;
        signal?.throwIfAborted();
        const scope = await runtime.runPromise(Scope.make());
        const closeScope = () => runtime.runPromise(Scope.close(scope, Exit.void));
        const connection = await runtime
          .runPromise(
            Effect.flatMap(OpenTunnelClient, (client) => client.tunnel.connect(input)).pipe(
              Effect.provideService(Scope.Scope, scope),
            ),
            signal ? { signal } : undefined,
          )
          .catch(async (error) => {
            await closeScope();
            if (signal?.aborted) throw signal.reason;
            throw error;
          });
        const close = () => runtime.runPromise(connection.close).finally(closeScope);
        if (signal?.aborted) {
          await close();
          throw signal.reason;
        }
        signal?.addEventListener("abort", () => void close(), { once: true });
        return {
          tunnel: connection.tunnel,
          events: Stream.toAsyncIterable(connection.events),
          status: () => runtime.runSync(connection.status),
          get urls() {
            return runtime.runSync(connection.urls);
          },
          setRoutes: (routes) => runtime.runPromise(connection.setRoutes(routes)),
          closed: runtime.runPromise(connection.closed).finally(closeScope),
          close,
        };
      },
    },
    dispose: () => runtime.dispose(),
  };
}
