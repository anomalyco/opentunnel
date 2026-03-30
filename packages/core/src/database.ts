import { Effect, Layer, ServiceMap, Option, HashMap } from "effect";
import type { Tunnel } from "./tunnel.ts";
import type { Certificate } from "./certificate.ts";

export namespace Database {
  export class Service extends ServiceMap.Service<
    Service,
    {
      tunnel: {
        update: (info: Tunnel.Info) => Effect.Effect<Tunnel.Info>;
        get: (id: Tunnel.ID) => Effect.Effect<Option.Option<Tunnel.Info>>;
        setToken: (token: Tunnel.Token, tunnel: Tunnel.ID) => Effect.Effect<void>;
        fromToken: (token: Tunnel.Token) => Effect.Effect<Option.Option<Tunnel.ID>>;
      };
      certificate: {
        update: (info: Certificate.Info) => Effect.Effect<Certificate.Info>;
        get: (id: Certificate.ID) => Effect.Effect<Option.Option<Certificate.Info>>;
      };
    }
  >()("Database") {}

  export const Memory = Layer.effect(
    Service,
    Effect.sync(() => {
      let tokens = HashMap.empty<Tunnel.Token, Tunnel.ID>();
      let tunnels = HashMap.empty<Tunnel.ID, Tunnel.Info>();
      let certificates = HashMap.empty<Certificate.ID, Certificate.Info>();

      return Service.of({
        certificate: {
          update: (info) =>
            Effect.sync(() => {
              certificates = HashMap.set(certificates, info.id, info);
              return info;
            }),
          get: (id) => Effect.sync(() => HashMap.get(certificates, id)),
        },
        tunnel: {
          get: (id) => Effect.sync(() => HashMap.get(tunnels, id)),
          update: (info) =>
            Effect.sync(() => {
              tunnels = HashMap.set(tunnels, info.id, info);
              return info;
            }),
          setToken: (token, tunnel) =>
            Effect.sync(() => {
              tokens = HashMap.set(tokens, token, tunnel);
            }),
          fromToken: (token) => Effect.sync(() => HashMap.get(tokens, token)),
        },
      });
    }),
  );
}
