#!/usr/bin/env bun

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { OpenTunnelClient } from "@opentunnel/client/effect";
import { loadOpenTunnelConfig, saveOpenTunnelConfig } from "./config.js";
import {
  ensureService,
  reloadService,
  serve as runService,
  serviceStatus,
  stopService,
} from "./service.js";
import { formatStatus, type StatusRow } from "./status.js";

const root = Command.make("opentunnel").pipe(
  Command.withDescription("Create and manage blind TLS tunnels"),
  Command.withSharedFlags({
    profile: Flag.string("profile").pipe(
      Flag.withDefault("default"),
      Flag.withDescription("Profile name"),
    ),
  }),
);

const create = Command.make(
  "create",
  {
    name: Flag.string("name").pipe(
      Flag.optional,
      Flag.withDescription("Requested tunnel name"),
    ),
  },
  Effect.fn(function* ({ name }) {
    const { profile } = yield* root;
    yield* ensureService(profile);
    const client = yield* OpenTunnelClient;
    let waiting = false;
    const tunnel = yield* client.tunnel.create(
      {
        profile,
        ...(Option.isSome(name) ? { name: name.value } : {}),
        onProgress: (stage) => {
          if (stage === "waiting-certificate") {
            if (waiting) process.stdout.write(".");
            else {
              waiting = true;
              process.stdout.write("Waiting for certificate verification (this can take a few minutes)...");
            }
            return;
          }
          if (waiting) {
            waiting = false;
            process.stdout.write("\n");
          }
          const message = {
            "creating-tunnel": "Creating tunnel...",
            "generating-key": "Generating private key...",
            "generating-csr": "Generating certificate request...",
            "resuming-certificate": "Resuming pending certificate verification...",
            "requesting-certificate": "Requesting certificate...",
            "saving-identity": "Saving tunnel identity...",
            ready: "Tunnel is ready.",
          }[stage as Exclude<typeof stage, "waiting-certificate">];
          console.log(message);
        },
      },
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (waiting) process.stdout.write("\n");
        }),
      ),
    );
    yield* reloadService(profile);
    yield* Effect.log(`Created https://${tunnel.hostname}`);
  }),
).pipe(Command.withDescription("Create and provision a tunnel"));

const printRoutes = Effect.fn("OpenTunnelCli.route.print")(function* (profile: string) {
  const client = yield* OpenTunnelClient;
  const tunnel = yield* client.tunnel.get({ profile });
  const config = yield* loadOpenTunnelConfig(profile);
  const routes = Object.entries(config.routes).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );

  if (routes.length === 0) {
    yield* Console.log(`No routes configured for profile ${profile}.`);
    return;
  }

  const display = routes.map(([name, target]) => ({
    name: tunnel ? `${name}.${tunnel.hostname}` : name,
    target,
  }));
  const width = Math.max(...display.map((route) => route.name.length));
  for (const route of display) {
    yield* Console.log(`${route.name.padEnd(width)}  →  ${route.target}`);
  }
});

const info = Command.make(
  "info",
  {},
  Effect.fn(function* () {
    const { profile } = yield* root;
    yield* ensureService(profile);
    const client = yield* OpenTunnelClient;
    const tunnel = yield* client.tunnel.get({ profile });

    if (!tunnel) {
      const pending = yield* client.tunnel.pending({ profile });
      if (pending) {
        yield* Console.log(`Profile: ${profile}`);
        yield* Console.log(`Tunnel ID: ${pending.id}`);
        yield* Console.log(`Hostname: ${pending.hostname}`);
        yield* Console.log("Status: Waiting for certificate verification");
      } else {
        yield* Console.log(`No tunnel exists for profile ${profile}.`);
      }
      yield* Console.log("");
      yield* printRoutes(profile);
      return;
    }

    yield* Console.log(`Profile: ${profile}`);
    yield* Console.log(`Tunnel ID: ${tunnel.id}`);
    yield* Console.log(`Hostname: ${tunnel.hostname}`);
    yield* Console.log(`Certificate expiry: ${tunnel.certificateExpiry.toISOString()}`);
    yield* Console.log("");
    yield* printRoutes(profile);
  }),
).pipe(Command.withDescription("Show the current tunnel identity"));

const serve = Command.make(
  "serve",
  {},
  Effect.fn(function* () {
    const { profile } = yield* root;
    yield* Effect.scoped(runService(profile));
  }),
).pipe(Command.withDescription("Run the tunnel service in the foreground"));

const serviceStatusCommand = Command.make(
  "status",
  {},
  Effect.fn(function* () {
    const { profile } = yield* root;
    const running = yield* serviceStatus(profile);
    yield* Console.log(running ? `Service is running for profile ${profile}.` : `Service is stopped for profile ${profile}.`);
  }),
).pipe(Command.withDescription("Show background service status"));

const serviceStart = Command.make(
  "start",
  {},
  Effect.fn(function* () {
    const { profile } = yield* root;
    const running = yield* serviceStatus(profile);
    yield* ensureService(profile);
    yield* Console.log(running ? `Service is already running for profile ${profile}.` : `Started service for profile ${profile}.`);
  }),
).pipe(Command.withDescription("Start the background service"));

const serviceStop = Command.make(
  "stop",
  {},
  Effect.fn(function* () {
    const { profile } = yield* root;
    const running = yield* serviceStatus(profile);
    yield* stopService(profile);
    yield* Console.log(running ? `Stopped service for profile ${profile}.` : `Service is already stopped for profile ${profile}.`);
  }),
).pipe(Command.withDescription("Stop the background service"));

const serviceRestart = Command.make(
  "restart",
  {},
  Effect.fn(function* () {
    const { profile } = yield* root;
    yield* stopService(profile);
    yield* ensureService(profile);
    yield* Console.log(`Restarted service for profile ${profile}.`);
  }),
).pipe(Command.withDescription("Restart the background service"));

const service = Command.make("service").pipe(
  Command.withDescription("Manage the background service"),
  Command.withSubcommands([serviceStatusCommand, serviceStart, serviceStop, serviceRestart]),
);

const status = Command.make(
  "status",
  {},
  Effect.fn(function* () {
    const client = yield* OpenTunnelClient;
    const profiles = yield* client.profile.list();
    const rows = yield* Effect.forEach(
      profiles,
      (profile) => Effect.gen(function* () {
        const tunnel = yield* client.tunnel.get({ profile });
        const pending = tunnel ? undefined : yield* client.tunnel.pending({ profile });
        const config = yield* loadOpenTunnelConfig(profile);
        const running = yield* serviceStatus(profile);
        const state = yield* client.tunnel.status({ profile }).pipe(
          Effect.catch(() => Effect.succeed("unreachable" as const)),
        );
        return {
          profile,
          hostname: tunnel?.hostname ?? pending?.hostname ?? "—",
          service: running ? "running" : "stopped",
          tunnel: state ?? "error",
          routes: Object.keys(config.routes).length,
        } satisfies StatusRow;
      }).pipe(
        Effect.catch(() => Effect.succeed({
          profile,
          hostname: "—",
          service: "stopped",
          tunnel: "error",
          routes: "—",
        } satisfies StatusRow)),
      ),
      { concurrency: 4 },
    );
    yield* Console.log(formatStatus(rows));
  }),
).pipe(Command.withDescription("Show all local tunnel profiles and their status"));

const routeAdd = Command.make(
  "add",
  {
    name: Argument.string("name"),
    target: Argument.string("target"),
  },
  Effect.fn(function* ({ name, target }) {
    const { profile } = yield* root;
    yield* ensureService(profile);
    const url = yield* Effect.try({
      try: () => {
        if (target.includes("://")) throw new Error("protocols are not allowed");
        return new URL(`tcp://${target}`);
      },
      catch: (cause) => new Error(`Invalid target URL: ${cause}`),
    });
    if (!url.hostname || !url.port) {
      return yield* Effect.fail(new Error("Route targets must use host:port"));
    }
    const config = yield* loadOpenTunnelConfig(profile);
    yield* saveOpenTunnelConfig(profile, {
      routes: { ...config.routes, [name]: target },
    });
    yield* reloadService(profile);
    const client = yield* OpenTunnelClient;
    const tunnel = yield* client.tunnel.get({ profile });
    yield* Effect.log(`Added route ${tunnel ? `${name}.${tunnel.hostname}` : name} -> ${target}`);
  }),
).pipe(Command.withDescription("Add or replace a subdomain route"));

const routeRemove = Command.make(
  "remove",
  { name: Argument.string("name") },
  Effect.fn(function* ({ name }) {
    const { profile } = yield* root;
    yield* ensureService(profile);
    const config = yield* loadOpenTunnelConfig(profile);
    const routes = { ...config.routes };
    delete routes[name];
    yield* saveOpenTunnelConfig(profile, { routes });
    yield* reloadService(profile);
    yield* Effect.log(`Removed route ${name}`);
  }),
).pipe(Command.withDescription("Remove a subdomain route"));

const routeList = Command.make(
  "list",
  {},
  Effect.fn(function* () {
    const { profile } = yield* root;
    yield* ensureService(profile);
    yield* printRoutes(profile);
  }),
).pipe(Command.withDescription("List configured subdomain routes"));

const route = Command.make("route").pipe(
  Command.withDescription("Manage subdomain routes"),
  Command.withSubcommands([routeAdd, routeRemove, routeList]),
);

export const cli = root.pipe(Command.withSubcommands([create, serve, service, status, info, route]));

Command.run(cli, { version: "0.0.0" }).pipe(
  Effect.provide(OpenTunnelClient.layer()),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
