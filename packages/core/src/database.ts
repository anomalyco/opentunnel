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
    Effect.gen(function* () {
      let tokens = HashMap.empty<Tunnel.Token, Tunnel.ID>();
      let tunnels = HashMap.empty<Tunnel.ID, Tunnel.Info>();
      let certificates = HashMap.empty<Certificate.ID, Certificate.Info>();

      return Service.of({
        certificate: {
          update: Effect.fn(function* (info) {
            certificates = HashMap.set(certificates, info.id, info);
            return info;
          }),
          get: Effect.fn(function* (id) {
            return HashMap.get(certificates, id);
          }),
        },
        tunnel: {
          get: Effect.fn(function* (id) {
            return HashMap.get(tunnels, id);
          }),
          update: Effect.fn(function* (info) {
            tunnels = HashMap.set(tunnels, info.id, info);
            return info;
          }),
          setToken: Effect.fn(function* (token, tunnel) {
            tokens = HashMap.set(tokens, token, tunnel);
          }),
          fromToken: Effect.fn(function* (token) {
            return HashMap.get(tokens, token);
          }),
        },
      });
    }),
  );
}
