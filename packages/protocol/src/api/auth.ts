import { Context } from "effect";
import { HttpApiMiddleware, HttpApiSecurity } from "effect/http-api";
import { Tunnel } from "../tunnel.js";
import { UnauthorizedError } from "./errors.js";

export class OpenTunnelAuthorizationToken extends Context.Service<
  OpenTunnelAuthorizationToken,
  Tunnel.Token
>()("@opentunnel/protocol/OpenTunnelAuthorizationToken") {}

export class OpenTunnelAuthorization extends HttpApiMiddleware.Service<
  OpenTunnelAuthorization,
  { provides: OpenTunnelAuthorizationToken }
>()("@opentunnel/protocol/OpenTunnelAuthorization", {
  security: { bearer: HttpApiSecurity.bearer },
  error: UnauthorizedError,
}) {}
