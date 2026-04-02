import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Api } from "../definition/index.ts";
import { Effect, Layer } from "effect";
import { Tunnel } from "@opentunnel/core/tunnel";
import { CSR } from "@opentunnel/core/csr";
import { TunnelAuth } from "../definition/tunnel.ts";

// Server-side middleware implementation - temporarily bypassing auth
export const TunnelAuthLive = Layer.effect(
  TunnelAuth,
  Effect.sync(() => {
    return TunnelAuth.of({
      bearer: Effect.fn(function* (httpEffect) {
        // Auth temporarily disabled - always allow
        return yield* httpEffect;
      }),
    });
  }),
);

// API handlers
export const TunnelApi = HttpApiBuilder.group(Api, "tunnel", (handlers) =>
  Effect.gen(function* () {
    const tunnel = yield* Tunnel.Service;

    return handlers
      .handle(
        "create",
        Effect.fn(function* (_req) {
          const created = yield* tunnel.create();
          return created;
        }),
      )
      .handle(
        "certificate",
        Effect.fn(function* (req) {
          const cert = yield* tunnel.certificate(req.params.id as Tunnel.ID);
          return cert;
        }),
      )
      .handle(
        "bind",
        Effect.fn(function* (req) {
          const parsed = yield* CSR.parse(req.payload.csr);
          yield* tunnel.bind(req.params.id as Tunnel.ID, parsed);
        }),
      )
      .handle(
        "delete",
        Effect.fn(function* (_req) {
          // TODO: implement delete
        }),
      )
      .handle(
        "get",
        Effect.fn(function* (req) {
          const info = yield* tunnel.fromID(req.params.id as Tunnel.ID);
          return info;
        }),
      );
  }),
);
