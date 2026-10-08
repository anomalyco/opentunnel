import { Effect } from "effect";
import * as EffectStorage from "../effect/storage.js";
import type { OpenTunnelStorage as EffectStorageType } from "../effect/storage.js";
import { OpenTunnelStorageError } from "../effect/errors.js";
import type {
  OpenTunnelIdentity,
  OpenTunnelPendingIdentity,
  OpenTunnelStoredTunnel,
} from "../effect/types.js";

const EffectStorageSymbol = Symbol.for("@opentunnel/client/EffectStorage");

export interface OpenTunnelStorage {
  readonly profiles: () => Promise<ReadonlyArray<string>>;
  readonly load: (profile: string) => Promise<OpenTunnelIdentity | undefined>;
  readonly save: (profile: string, tunnel: OpenTunnelIdentity) => Promise<void>;
  readonly loadPending: (profile: string) => Promise<OpenTunnelPendingIdentity | undefined>;
  readonly savePending: (profile: string, tunnel: OpenTunnelPendingIdentity) => Promise<void>;
  readonly remove: (profile: string) => Promise<void>;
  readonly list: () => Promise<ReadonlyArray<OpenTunnelStoredTunnel>>;
}

type WrappedStorage = OpenTunnelStorage & { readonly [EffectStorageSymbol]: EffectStorageType };

const wrap = (storage: EffectStorageType): WrappedStorage => ({
  [EffectStorageSymbol]: storage,
  profiles: () => Effect.runPromise(storage.profiles()),
  load: (profile) => Effect.runPromise(storage.load(profile)),
  save: (profile, tunnel) => Effect.runPromise(storage.save(profile, tunnel)),
  loadPending: (profile) => Effect.runPromise(storage.loadPending(profile)),
  savePending: (profile, tunnel) => Effect.runPromise(storage.savePending(profile, tunnel)),
  remove: (profile) => Effect.runPromise(storage.remove(profile)),
  list: () => Effect.runPromise(storage.list()),
});

export const OpenTunnelStorage = {
  memory: (): OpenTunnelStorage => wrap(EffectStorage.memory()),
  xdg: (options?: { readonly env?: NodeJS.ProcessEnv; readonly home?: string }): OpenTunnelStorage =>
    wrap(EffectStorage.xdg(options)),
};

const attempt = <A>(message: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new OpenTunnelStorageError({ message, cause }),
  });

export function toEffectStorage(storage: OpenTunnelStorage): EffectStorageType {
  if (EffectStorageSymbol in storage) return (storage as WrappedStorage)[EffectStorageSymbol];
  return {
    profiles: () => attempt("Failed to list profiles", () => storage.profiles()),
    load: (profile) =>
      attempt(`Failed to load tunnel identity for ${profile}`, () => storage.load(profile)),
    save: (profile, tunnel) =>
      attempt(`Failed to save tunnel identity for ${profile}`, () => storage.save(profile, tunnel)),
    loadPending: (profile) =>
      attempt(`Failed to load pending tunnel identity for ${profile}`, () =>
        storage.loadPending(profile)),
    savePending: (profile, tunnel) =>
      attempt(`Failed to save pending tunnel identity for ${profile}`, () =>
        storage.savePending(profile, tunnel)),
    remove: (profile) =>
      attempt(`Failed to remove tunnel identity for ${profile}`, () => storage.remove(profile)),
    list: () => attempt("Failed to list tunnels", () => storage.list()),
  };
}
