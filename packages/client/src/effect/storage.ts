export * as OpenTunnelStorage from "./storage.js";

import { Effect } from "effect";
import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";
import type { OpenTunnelIdentity, OpenTunnelStoredTunnel } from "./types.js";
import { OpenTunnelStorageError } from "./errors.js";

export interface OpenTunnelStorage {
readonly profiles: () => Effect.Effect<ReadonlyArray<string>, OpenTunnelStorageError>;
readonly load: (
  profile: string,
) => Effect.Effect<OpenTunnelIdentity | undefined, OpenTunnelStorageError>;
readonly save: (
  profile: string,
  tunnel: OpenTunnelIdentity,
) => Effect.Effect<void, OpenTunnelStorageError>;
readonly remove: (profile: string) => Effect.Effect<void, OpenTunnelStorageError>;
readonly list: () => Effect.Effect<ReadonlyArray<OpenTunnelStoredTunnel>, OpenTunnelStorageError>;
}

export function memory(): OpenTunnelStorage {
  const identities = new Map<string, OpenTunnelIdentity>();
  return {
    profiles: () => Effect.sync(() => [...identities.keys()].sort()),
    load: (profile) => Effect.sync(() => identities.get(profile)),
    save: (profile, tunnel) => Effect.sync(() => void identities.set(profile, tunnel)),
    remove: (profile) => Effect.sync(() => void identities.delete(profile)),
    list: () =>
      Effect.sync(() =>
        [...identities].map(([profile, tunnel]) => ({ profile, tunnel })),
      ),
  };
}

export function xdg(options: { readonly env?: NodeJS.ProcessEnv; readonly home?: string } = {}): OpenTunnelStorage {
  const env = options.env ?? process.env;
  const home = options.home ?? Os.homedir();
  const dataHome = env.XDG_DATA_HOME ?? Path.join(home, ".local", "share");
  const dataRoot = Path.join(dataHome, "opentunnel");
  const profileData = (profile: string) => Path.join(dataRoot, profile);

  const readOptional = (path: string) =>
    Effect.tryPromise({
      try: () => Fs.readFile(path, "utf8"),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((cause: unknown) => Effect.gen(function* () {
        if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") {
          return undefined;
        }
        return yield* new OpenTunnelStorageError({ message: `Failed to read ${path}`, cause });
      })),
    );

  const profiles = Effect.fn("OpenTunnelStorage.profiles")(function* () {
    const entries = yield* Effect.tryPromise({
        try: () => Fs.readdir(dataRoot, { withFileTypes: true }),
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause: unknown) => Effect.gen(function* () {
          if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") {
            return [];
          }
          return yield* new OpenTunnelStorageError({
            message: `Failed to list ${dataRoot}`,
            cause,
          });
        })),
      );
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  });

  const load = Effect.fn("OpenTunnelStorage.load")(function* (profile: string) {
    const root = profileData(profile);
    const metadata = yield* readOptional(Path.join(root, "tunnel.json"));
    if (!metadata) return undefined;
    const [token, privateKey, certificate, chain] = yield* Effect.all([
      readOptional(Path.join(root, "token")),
      readOptional(Path.join(root, "private-key.pem")),
      readOptional(Path.join(root, "certificate.pem")),
      readOptional(Path.join(root, "chain.pem")),
    ]);
    if (!token || !privateKey || !certificate || chain === undefined) {
      return yield* new OpenTunnelStorageError({
        message: `Incomplete tunnel identity for ${profile}`,
      });
    }
    const value = JSON.parse(metadata) as {
      id: string;
      hostname: string;
      certificateExpiry: string;
    };
    return {
      id: value.id,
      hostname: value.hostname,
      token: token.trim(),
      privateKey,
      certificate,
      chain,
      certificateExpiry: new Date(value.certificateExpiry),
    } satisfies OpenTunnelIdentity;
  });

  return {
    profiles: () => profiles(),
    load: (profile) => load(profile),
    save: (profile, tunnel) =>
      Effect.tryPromise({
        try: async () => {
          const root = profileData(profile);
          await Fs.mkdir(root, { recursive: true, mode: 0o700 });
          await Promise.all([
            Fs.writeFile(
              Path.join(root, "tunnel.json"),
              JSON.stringify({
                id: tunnel.id,
                hostname: tunnel.hostname,
                certificateExpiry: tunnel.certificateExpiry.toISOString(),
              }, null, 2),
              { mode: 0o600 },
            ),
            Fs.writeFile(Path.join(root, "token"), `${tunnel.token}\n`, { mode: 0o600 }),
            Fs.writeFile(Path.join(root, "private-key.pem"), tunnel.privateKey, { mode: 0o600 }),
            Fs.writeFile(Path.join(root, "certificate.pem"), tunnel.certificate, { mode: 0o600 }),
            Fs.writeFile(Path.join(root, "chain.pem"), tunnel.chain, { mode: 0o600 }),
          ]);
        },
        catch: (cause) =>
          new OpenTunnelStorageError({
            message: `Failed to save tunnel identity for ${profile}`,
            cause,
          }),
      }),
    remove: (profile) =>
      Effect.tryPromise({
        try: () => Fs.rm(profileData(profile), { recursive: true, force: true }),
        catch: (cause) =>
          new OpenTunnelStorageError({
            message: `Failed to remove tunnel identity for ${profile}`,
            cause,
          }),
      }),
    list: () =>
      profiles().pipe(
        Effect.flatMap((names) =>
          Effect.forEach(names, (profile) =>
            load(profile).pipe(
              Effect.map((tunnel) => tunnel ? { profile, tunnel } : undefined),
            ),
          ),
        ),
        Effect.map((entries) => entries.filter((entry): entry is OpenTunnelStoredTunnel => entry !== undefined)),
      ),
  };
}
