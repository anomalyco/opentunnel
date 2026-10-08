import { HttpApi, OpenApi } from "effect/http-api";
import { TunnelGroup } from "./tunnel.js";

export const Api = HttpApi.make("opentunnel")
  .add(TunnelGroup)
  .annotateMerge(
    OpenApi.annotations({
      title: "OpenTunnel API",
      version: "0.1.0",
      description: "Create and manage blind TLS tunnels.",
    }),
  );
