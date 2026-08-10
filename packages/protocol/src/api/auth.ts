import { ServiceMap } from "effect";
import { HttpApiMiddleware, HttpApiSecurity } from "effect/unstable/httpapi";
import { Tunnel } from "../tunnel.js";
import { UnauthorizedError } from "./errors.js";

export class OpenTunnelAuthorizationToken extends ServiceMap.Service<
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
