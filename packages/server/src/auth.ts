export * as Authorization from "./auth.js";

import { Effect, Layer, Redacted } from "effect";
import { OpenTunnelAuthorization, OpenTunnelAuthorizationToken } from "@opentunnel/protocol/api/auth";
import { Tunnel } from "@opentunnel/protocol/tunnel";

export const layer = Layer.succeed(
  OpenTunnelAuthorization,
  OpenTunnelAuthorization.of({
    bearer: (httpEffect, { credential }) =>
      httpEffect.pipe(
        Effect.provideService(
          OpenTunnelAuthorizationToken,
          Tunnel.Token.makeUnsafe(Redacted.value(credential)),
        ),
      ),
  }),
);
