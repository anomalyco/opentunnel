import { Effect } from "effect";
import {
  OpenTunnelStorage as EffectStorage,
  type OpenTunnelStorage as EffectStorageType,
} from "../effect/storage.js";
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

export function toEffectStorage(storage: OpenTunnelStorage): EffectStorageType {
  if (EffectStorageSymbol in storage) return (storage as WrappedStorage)[EffectStorageSymbol];
  return {
    profiles: () => Effect.tryPromise(() => storage.profiles()),
    load: (profile) => Effect.tryPromise(() => storage.load(profile)),
    save: (profile, tunnel) => Effect.tryPromise(() => storage.save(profile, tunnel)),
    loadPending: (profile) => Effect.tryPromise(() => storage.loadPending(profile)),
    savePending: (profile, tunnel) => Effect.tryPromise(() => storage.savePending(profile, tunnel)),
    remove: (profile) => Effect.tryPromise(() => storage.remove(profile)),
    list: () => Effect.tryPromise(() => storage.list()),
  };
}
