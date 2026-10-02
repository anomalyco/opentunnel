import { Cause, Console, Effect, Exit, Fiber, Queue, Schema, Scope, Stream } from "effect";
import { spawn } from "node:child_process";
import * as Fs from "node:fs/promises";
import { closeSync, openSync } from "node:fs";
import * as Net from "node:net";
import * as Os from "node:os";
import * as Path from "node:path";
import { OpenTunnelClient } from "@opentunnel/client/effect";
import { BridgeProtocol } from "@opentunnel/protocol/bridge-protocol";
import { loadOpenTunnelConfig } from "./config.js";

export class OpenTunnelServiceError extends Schema.TaggedErrorClass<OpenTunnelServiceError>()(
  "OpenTunnelServiceError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect) },
) {}

const profilePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const paths = (profile: string) => {
  if (!profilePattern.test(profile)) {
    throw new Error("Profile names must contain only lowercase letters, numbers, and hyphens");
  }
  const runtimeRoot = Path.join(
    process.env.XDG_RUNTIME_DIR ?? Path.join(Os.tmpdir(), `opentunnel-${process.getuid?.() ?? "user"}`),
    "opentunnel",
  );
  const stateRoot = Path.join(
    process.env.XDG_STATE_HOME ?? Path.join(Os.homedir(), ".local", "state"),
    "opentunnel",
    profile,
  );
  return {
    runtimeRoot,
    socket: Path.join(runtimeRoot, `${profile}.sock`),
    lock: Path.join(runtimeRoot, `${profile}.lock`),
    stateRoot,
    log: Path.join(stateRoot, "daemon.log"),
  };
};

const request = async (
  profile: string,
  command: "status" | "reload" | "stop",
): Promise<void> => {
  const location = paths(profile).socket;
  await new Promise<void>((resolve, reject) => {
    const socket = Net.createConnection(location);
    const timeout = setTimeout(() => socket.destroy(new Error("Service request timed out")), 1_000);
    let response = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${command}\n`));
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("end", () => {
      clearTimeout(timeout);
      response.trim() === "ok" ? resolve() : reject(new Error(response.trim() || "Invalid response"));
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
};

export const serviceStatus = Effect.fn("OpenTunnelService.status")(function* (profile: string) {
  return yield* Effect.tryPromise({
    try: () => request(profile, "status").then(() => true, () => false),
    catch: () => new OpenTunnelServiceError({ message: "Failed to check background service" }),
  });
});

export const ensureService = Effect.fn("OpenTunnelService.ensure")(function* (profile: string) {
  const running = yield* serviceStatus(profile);
  if (running) return;

  const location = yield* Effect.try({
    try: () => paths(profile),
    catch: (cause) => new OpenTunnelServiceError({ message: String(cause), cause }),
  });
  yield* Effect.tryPromise({
    try: async () => {
      await Fs.mkdir(location.stateRoot, { recursive: true, mode: 0o700 });
      const output = openSync(location.log, "a", 0o600);
      try {
        const child = spawn(
          process.execPath,
          [process.argv[1]!, "--profile", profile, "serve"],
          {
            detached: true,
            stdio: ["ignore", output, output],
            env: { ...process.env, OPENTUNNEL_DAEMON: "1" },
          },
        );
        child.unref();
      } finally {
        closeSync(output);
      }

      for (let attempt = 0; attempt < 50; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (await request(profile, "status").then(() => true, () => false)) return;
      }
      throw new Error(`Background service did not start; see ${location.log}`);
    },
    catch: (cause) => new OpenTunnelServiceError({
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    }),
  });
});

export const stopService = Effect.fn("OpenTunnelService.stop")(function* (profile: string) {
  if (!(yield* serviceStatus(profile))) return;
  yield* Effect.tryPromise({
    try: async () => {
      await request(profile, "stop");
      for (let attempt = 0; attempt < 150; attempt++) {
        if (!(await request(profile, "status").then(() => true, () => false))) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Background service did not stop");
    },
    catch: (cause) => new OpenTunnelServiceError({
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    }),
  });
});

export const reloadService = Effect.fn("OpenTunnelService.reload")(function* (profile: string) {
  yield* ensureService(profile);
  yield* Effect.tryPromise({
    try: () => request(profile, "reload"),
    catch: (cause) => new OpenTunnelServiceError({
      message: "Failed to reload background service",
      cause,
    }),
  });
});

export const serve = Effect.fn("OpenTunnelService.serve")(function* (profile: string) {
  const client = yield* OpenTunnelClient;
  const location = yield* Effect.try({
    try: () => paths(profile),
    catch: (cause) => new OpenTunnelServiceError({ message: String(cause), cause }),
  });
  const commands = yield* Queue.unbounded<"reload" | "stop" | "provisioned" | { readonly retry: number }>();
  const parent = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void));

  yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        await Fs.mkdir(location.runtimeRoot, { recursive: true, mode: 0o700 });
        let lock: Fs.FileHandle;
        try {
          lock = await Fs.open(location.lock, "wx", 0o600);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const pid = Number(await Fs.readFile(location.lock, "utf8").catch(() => "0"));
          if (Number.isInteger(pid) && pid > 0) {
            try {
              process.kill(pid, 0);
              throw new Error(`Background service is already running for profile ${profile}`);
            } catch (cause) {
              if (cause instanceof Error && cause.message.startsWith("Background service")) throw cause;
            }
          }
          await Fs.rm(location.lock, { force: true });
          lock = await Fs.open(location.lock, "wx", 0o600);
        }
        await lock.writeFile(String(process.pid));
        await Fs.rm(location.socket, { force: true });

        const server = Net.createServer((socket) => {
          socket.setEncoding("utf8");
          let command = "";
          socket.on("data", (chunk) => {
            command += chunk;
            if (command.length > 32) socket.destroy();
            if (!command.includes("\n")) return;
            const value = command.trim();
            if (value === "reload" || value === "stop") Queue.offerUnsafe(commands, value);
            socket.end(
              value === "status" || value === "reload" || value === "stop"
                ? "ok\n"
                : "unknown command\n",
            );
          });
        });
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(location.socket, () => {
            server.off("error", reject);
            resolve();
          });
        });
        return { server, lock };
      },
      catch: (cause) => new OpenTunnelServiceError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
    }),
    ({ server, lock }) => Effect.promise(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await lock.close();
      await Promise.all([
        Fs.rm(location.socket, { force: true }),
        Fs.rm(location.lock, { force: true }),
      ]);
    }),
  );

  if (process.env.OPENTUNNEL_DAEMON !== "1") {
    yield* Console.log(`Serving profile ${profile}.`);
  }

  let connectionScope: Scope.Closeable | undefined;
  let connectionFiber: Fiber.Fiber<void> | undefined;
  let provisioningScope: Scope.Closeable | undefined;
  let retryScope: Scope.Closeable | undefined;
  let generation = 0;
  let retryDelay: number = BridgeProtocol.BridgeTiming.RECONNECT_BACKOFF_MIN_MS;
  let lastError: string | undefined;
  let routeNames: string[] = [];
  const retry = Effect.fn(function* (attempt: number) {
    if (attempt !== generation) return;
    const delay = Math.min(
      BridgeProtocol.BridgeTiming.RECONNECT_BACKOFF_MAX_MS,
      Math.round(retryDelay * (0.8 + Math.random() * 0.4)),
    );
    retryDelay = Math.min(retryDelay * 2, BridgeProtocol.BridgeTiming.RECONNECT_BACKOFF_MAX_MS);
    const scope = yield* Scope.fork(parent, "sequential");
    retryScope = scope;
    yield* Effect.gen(function* () {
      yield* Effect.sleep(delay);
      if (attempt === generation) Queue.offerUnsafe(commands, { retry: attempt });
    }).pipe(Effect.forkIn(scope));
  });
  yield* Effect.addFinalizer(() => Effect.gen(function* () {
    generation++;
    if (connectionFiber) yield* Fiber.interrupt(connectionFiber);
    if (connectionScope) yield* Scope.close(connectionScope, Exit.void);
    if (provisioningScope) yield* Scope.close(provisioningScope, Exit.void);
    if (retryScope) yield* Scope.close(retryScope, Exit.void);
    yield* Queue.shutdown(commands);
  }));
  yield* Queue.offer(commands, "reload");

  while (true) {
    const command = yield* Queue.take(commands);
    if (command === "stop") return;
    if (typeof command === "object" && command.retry !== generation) continue;
    const attempt = ++generation;
    if (retryScope) {
      yield* Scope.close(retryScope, Exit.void);
      retryScope = undefined;
    }
    if (command === "reload") {
      retryDelay = BridgeProtocol.BridgeTiming.RECONNECT_BACKOFF_MIN_MS;
      lastError = undefined;
    }
    if (command === "provisioned" && provisioningScope) {
      yield* Scope.close(provisioningScope, Exit.void);
      provisioningScope = undefined;
    }
    if (connectionScope) {
      if (connectionFiber) yield* Fiber.interrupt(connectionFiber);
      connectionFiber = undefined;
      yield* Scope.close(connectionScope, Exit.void);
      connectionScope = undefined;
    }
    for (const name of routeNames) yield* client.route.remove({ profile, name });
    routeNames = [];

    const scope = yield* Scope.fork(parent, "sequential");
    connectionScope = scope;
    connectionFiber = yield* Effect.gen(function* () {
      const tunnel = yield* client.tunnel.get({ profile });
      const config = yield* loadOpenTunnelConfig(profile);
      if (!tunnel) {
        const pending = yield* client.tunnel.pending({ profile });
        if (pending && !provisioningScope) {
          yield* Console.log(`Profile ${profile} is waiting for certificate verification.`);
          const scope = yield* Scope.fork(parent, "sequential");
          provisioningScope = scope;
          yield* client.tunnel.resume({ profile }).pipe(
            Effect.catch((error) => Console.error(`Profile ${profile} provisioning failed:`, error)),
            Effect.ensuring(Effect.sync(() => Queue.offerUnsafe(commands, "provisioned"))),
            Effect.forkIn(scope),
          );
        } else if (!pending) {
          yield* Console.log(`Profile ${profile} is waiting for a tunnel.`);
          yield* retry(attempt);
        }
        return;
      }
      if (Object.keys(config.routes).length === 0) {
        yield* Console.log(`Profile ${profile} is waiting for routes.`);
        return;
      }

      for (const [name, target] of Object.entries(config.routes)) {
        yield* client.route.add({ profile, name, target });
        routeNames.push(name);
      }
      const bridgeScope = yield* Scope.fork(scope, "sequential");
      const connection = yield* client.tunnel.connect({ profile }).pipe(
        Scope.provide(bridgeScope),
        Effect.onExit((exit) => Exit.isFailure(exit) ? Scope.close(bridgeScope, exit) : Effect.void),
      );
      const connectedAt = Date.now();
      const routes = [...connection.routes].sort((left, right) => left.hostname.localeCompare(right.hostname));
      const width = Math.max(...routes.map((route) => route.hostname.length));
      yield* Console.log(`Forwarding profile ${profile}:`);
      for (const route of routes) yield* Console.log(`${route.hostname.padEnd(width)}  ->  ${route.target}`);
      yield* Stream.runForEach(connection.events, (event) =>
        Console.log(JSON.stringify({ time: new Date().toISOString(), profile, ...event }))).pipe(Effect.forkIn(bridgeScope));
      yield* Effect.gen(function* () {
        yield* connection.closed;
        if (Date.now() - connectedAt >= BridgeProtocol.BridgeTiming.IDLE_TIMEOUT_MS) {
          retryDelay = BridgeProtocol.BridgeTiming.RECONNECT_BACKOFF_MIN_MS;
          lastError = undefined;
        }
        yield* retry(attempt);
      }).pipe(Effect.forkIn(bridgeScope));
    }).pipe(
      Effect.catchCause((cause) => Effect.gen(function* () {
        if (attempt !== generation || Cause.hasInterruptsOnly(cause)) return;
        const error = Cause.squash(cause);
        const message = error instanceof Error
          ? `${error.message}${error.cause instanceof Error ? `: ${error.cause.message}` : ""}`
          : String(error);
        if (message !== lastError) {
          yield* Console.error(JSON.stringify({
            time: new Date().toISOString(), profile, type: "connect-error", message,
          }));
          lastError = message;
        }
        yield* retry(attempt);
      })),
      Effect.forkIn(scope),
    );
  }
});
