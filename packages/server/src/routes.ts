import { Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Api } from "@opentunnel/protocol/api/api";
import { TunnelHandlers } from "./handlers/tunnel.js";
import { Authorization } from "./auth.js";

export function makeApiHandler() {
  const routes = HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide(TunnelHandlers),
    Layer.provide(Authorization.layer),
    Layer.provide(HttpServer.layerServices),
  );
  return HttpRouter.toWebHandler(routes, { disableLogger: true }).handler;
}
