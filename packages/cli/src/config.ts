import { Effect, Schema } from "effect";
import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";
import { parse, stringify } from "smol-toml";

export class OpenTunnelCliConfigError extends Schema.TaggedErrorClass<OpenTunnelCliConfigError>()(
  "OpenTunnelCliConfigError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect) },
) {}

export interface OpenTunnelCliConfig {
  readonly routes: Readonly<Record<string, string>>;
}

const profilePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function openTunnelConfigPath(profile: string): Effect.Effect<string, OpenTunnelCliConfigError> {
  if (!profilePattern.test(profile)) {
    return Effect.gen(function* () {
      return yield* new OpenTunnelCliConfigError({
        message: "Profile names must contain only lowercase letters, numbers, and hyphens",
      });
    });
  }
  return Effect.succeed(
    Path.join(
      process.env.XDG_CONFIG_HOME ?? Path.join(Os.homedir(), ".config"),
      "opentunnel",
      `${profile}.toml`,
    ),
  );
}

export const loadOpenTunnelConfig = Effect.fn("OpenTunnelCliConfig.load")(function* (
  profile: string,
) {
  const path = yield* openTunnelConfigPath(profile);
  const content = yield* Effect.tryPromise({
    try: () => Fs.readFile(path, "utf8"),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause: unknown) => Effect.gen(function* () {
      if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") {
        return undefined;
      }
      return yield* new OpenTunnelCliConfigError({ message: `Failed to read ${path}`, cause });
    })),
  );
  if (!content) return { routes: {} } satisfies OpenTunnelCliConfig;
  const document = yield* Effect.try({
    try: () => parse(content) as { routes?: Record<string, unknown> },
    catch: (cause) => new OpenTunnelCliConfigError({ message: `Failed to parse ${path}`, cause }),
  });
  const routes: Record<string, string> = {};
  for (const [name, target] of Object.entries(document.routes ?? {})) {
    if (typeof target === "string") routes[name] = target;
  }
  return { routes } satisfies OpenTunnelCliConfig;
});

export const saveOpenTunnelConfig = Effect.fn("OpenTunnelCliConfig.save")(function* (
  profile: string,
  config: OpenTunnelCliConfig,
) {
  const path = yield* openTunnelConfigPath(profile);
  yield* Effect.tryPromise({
    try: async () => {
      await Fs.mkdir(Path.dirname(path), { recursive: true });
      await Fs.writeFile(path, stringify({ routes: config.routes }), { mode: 0o644 });
    },
    catch: (cause) => new OpenTunnelCliConfigError({ message: `Failed to write ${path}`, cause }),
  });
});
