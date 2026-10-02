import { expect, test, spyOn } from "bun:test";
import { Effect, Layer, Stream } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenTunnelClient } from "@opentunnel/client/effect";
import { OpenTunnelClientError } from "../../client/src/effect/errors.ts";
import { BridgeProtocol } from "@opentunnel/protocol/bridge-protocol";
import { saveOpenTunnelConfig } from "../src/config.ts";
import { reloadService, serve, stopService } from "../src/service.ts";

async function waitFor(predicate) {
  const deadline = performance.now() + 2000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("Service condition timed out");
    await Bun.sleep(2);
  }
}

async function withService({ connect, add }, check) {
  const directory = mkdtempSync(join(tmpdir(), "opentunnel-service-test-"));
  const env = { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.XDG_RUNTIME_DIR = directory;
  process.env.XDG_CONFIG_HOME = directory;
  const timing = { ...BridgeProtocol.BridgeTiming };
  BridgeProtocol.BridgeTiming.RECONNECT_BACKOFF_MIN_MS = 20;
  BridgeProtocol.BridgeTiming.RECONNECT_BACKOFF_MAX_MS = 160;
  const random = spyOn(Math, "random").mockReturnValue(0.5);
  const routes = new Map();
  const state = { attempts: [], resources: 0, additions: 0 };
  const client = {
    route: {
      add: ({ name, target }) => Effect.gen(function* () {
        state.additions++;
        if (add) yield* add(state, name);
        if (routes.has(name)) return yield* new OpenTunnelClientError({ message: "Duplicate route" });
        const route = { name, target, hostname: `${name}.diagnostic.example` };
        routes.set(name, route);
        return route;
      }),
      remove: ({ name }) => Effect.sync(() => routes.delete(name)),
    },
    tunnel: {
      get: () => Effect.succeed({ id: "diagnostic" }),
      connect: () => Effect.gen(function* () {
        state.attempts.push(performance.now());
        yield* Effect.acquireRelease(
          Effect.sync(() => state.resources++),
          () => Effect.sync(() => state.resources--),
        );
        if (connect) yield* connect(state);
        return { routes: [...routes.values()], events: Stream.empty, closed: Effect.never };
      }),
    },
  };
  const controller = new AbortController();
  let daemon;
  try {
    await Effect.runPromise(saveOpenTunnelConfig("test", { routes: { app: "127.0.0.1:1", api: "127.0.0.1:2" } }));
    daemon = Effect.runPromise(Effect.scoped(serve("test")).pipe(Effect.provide(Layer.succeed(OpenTunnelClient, client))), { signal: controller.signal });
    daemon.catch(() => {});
    await check(state, routes);
    await Effect.runPromise(stopService("test"));
    await daemon;
    expect(state.resources).toBe(0);
  } finally {
    controller.abort();
    await daemon?.catch(() => {});
    random.mockRestore();
    Object.assign(BridgeProtocol.BridgeTiming, timing);
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

test("failed attempts release resources, back off, deduplicate logs, and stop promptly", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    await withService({ connect: () => Effect.fail(new OpenTunnelClientError({ message: "Offline" })) }, async (state) => {
      await waitFor(() => state.attempts.length >= 4 && state.resources === 0);
      const intervals = state.attempts.slice(1, 4).map((time, i) => time - state.attempts[i]);
      expect(intervals[0]).toBeGreaterThanOrEqual(15);
      expect(intervals[1]).toBeGreaterThanOrEqual(35);
      expect(intervals[2]).toBeGreaterThanOrEqual(75);
      expect(errors.mock.calls.length).toBe(1);
      const started = performance.now();
      await Effect.runPromise(stopService("test"));
      expect(performance.now() - started).toBeLessThan(100);
    });
  } finally { errors.mockRestore(); }
});

test("a partial route-registration failure can retry without duplicate routes", async () => {
  await withService({ add: state => state.additions === 2
    ? Effect.fail(new OpenTunnelClientError({ message: "Transient route error" })) : Effect.void }, async (state, routes) => {
    await waitFor(() => state.attempts.length === 1);
    expect([...routes.keys()]).toEqual(["app", "api"]);
    expect(state.additions).toBe(4);
  });
});

test("reload and stop interrupt an in-flight attachment", async () => {
  let interrupted = 0;
  await withService({ connect: () => Effect.tryPromise({
    try: signal => new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
      interrupted++;
      reject(signal.reason);
    }, { once: true })),
    catch: cause => new OpenTunnelClientError({ message: "Interrupted", cause }),
  }) }, async (state) => {
    await waitFor(() => state.attempts.length === 1);
    await Effect.runPromise(reloadService("test"));
    await waitFor(() => state.attempts.length === 2);
    expect(interrupted).toBe(1);
    expect(state.resources).toBe(1);
    const started = performance.now();
    await Effect.runPromise(stopService("test"));
    expect(performance.now() - started).toBeLessThan(100);
    expect(interrupted).toBe(2);
  });
});

test("reload cannot inherit a retry triggered by the canceled attachment finalizer", async () => {
  await withService({ connect: state => state.attempts.length === 1
    ? Effect.gen(function* () {
      let fail;
      const pending = new Promise((_resolve, reject) => fail = reject);
      yield* Effect.acquireRelease(Effect.void, () => Effect.promise(async () => {
        fail(new Error("Socket closed during cleanup"));
        await Bun.sleep(25);
      }));
      yield* Effect.tryPromise({ try: () => pending, catch: cause => new OpenTunnelClientError({ message: "Attach failed", cause }) });
    }) : Effect.void }, async (state) => {
    await waitFor(() => state.attempts.length === 1);
    await Effect.runPromise(reloadService("test"));
    await waitFor(() => state.attempts.length === 2);
    await Bun.sleep(200);
    expect(state.attempts.length).toBe(2);
    expect(state.resources).toBe(1);
  });
});

test("unexpected worker defects are reported and retried instead of leaving the daemon offline", async () => {
  await withService({ connect: state => state.attempts.length === 1
    ? Effect.die(new Error("Unexpected connection defect")) : Effect.void }, async (state) => {
    await waitFor(() => state.attempts.length === 2);
    expect(state.resources).toBe(1);
  });
});
