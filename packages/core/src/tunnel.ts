import { Effect, Layer, Option, Schema, ServiceMap } from "effect";
import { Database } from "./database.ts";
import { AppConfig } from "./config.ts";
import { CSR } from "./csr.ts";
import { Certificate } from "./certificate.ts";
import { Newtype } from "./newtype.ts";

export namespace Tunnel {
  export class ID extends Newtype<ID>()("Tunnel.ID", Schema.String) {
    static random() {
      return this.makeUnsafe(crypto.randomUUID());
    }
  }

  export class Token extends Newtype<Token>()("Tunnel.Token", Schema.String) {
    static random() {
      return this.makeUnsafe(crypto.randomUUID());
    }
  }

  export class NotFoundError extends Schema.TaggedErrorClass()("NotFound", {
    tunnelID: ID,
  }) {}

  export class NoCertificateError extends Schema.TaggedErrorClass()("NoCertificate", {
    tunnelID: ID,
  }) {}

  export class InvalidHostnameError extends Schema.TaggedErrorClass()("InvalidHostname", {
    provided: CSR.Hostname,
    expected: CSR.Hostname,
  }) {}

  export const State = Schema.Literals(["offline", "online"]);
  export type State = Schema.Schema.Type<typeof State>;

  export class Info extends Schema.Class<Info>("Tunnel/Info")({
    id: ID,
    hostname: CSR.Hostname,
    state: State,
    certificateID: Certificate.ID.pipe(Schema.optional),
  }) {}

  export class Service extends ServiceMap.Service<
    Service,
    {
      create: () => Effect.Effect<{
        tunnel: Tunnel.Info;
        token: Token;
      }>;
      fromID: (id: Tunnel.ID) => Effect.Effect<Tunnel.Info, NotFoundError>;
      certificate: (
        id: Tunnel.ID,
      ) => Effect.Effect<Certificate.Info, NotFoundError | NoCertificateError>;
      auth: (tunnel: Tunnel.ID, token: Token) => Effect.Effect<boolean>;
      bind: (
        tunnel: Tunnel.ID,
        csr: CSR.Info,
      ) => Effect.Effect<void, InvalidHostnameError | NotFoundError>;
    }
  >()("Tunnel") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = yield* Database.Service;
      const config = yield* AppConfig;
      const certificate = yield* Certificate.Service;

      const fromID = Effect.fn(function* (id: ID) {
        const match = yield* db.tunnel.get(id);
        if (Option.isNone(match)) {
          return yield* new NotFoundError({ tunnelID: id });
        }
        return match.value;
      });

      return Service.of({
        fromID,
        certificate: Effect.fn(function* (id: ID) {
          const info = yield* fromID(id);
          if (!info.certificateID) {
            return yield* new NoCertificateError({ tunnelID: id });
          }
          const cert = yield* certificate.get(info.certificateID);
          if (Option.isNone(cert)) {
            return yield* new NoCertificateError({ tunnelID: id });
          }
          return cert.value;
        }),
        create: Effect.fn(function* () {
          const id = ID.random();
          const info: Tunnel.Info = {
            id,
            hostname: CSR.Hostname.makeUnsafe(
              // `${id}.${config.OPENTUNNEL_DOMAIN}`,
              config.OPENTUNNEL_DOMAIN,
            ),
            state: "offline",
          };
          yield* db.tunnel.update(info);
          return { tunnel: info, token: Token.random() };
        }),
        auth: Effect.fn(function* (tunnel, token) {
          const id = yield* db.tunnel.fromToken(token);
          return Option.exists(id, (val) => val === tunnel);
        }),
        bind: Effect.fn(function* (tunnelID, csr) {
          const info = yield* fromID(tunnelID);

          if (csr.hostname !== info.hostname)
            return yield* new InvalidHostnameError({
              provided: csr.hostname,
              expected: info.hostname,
            });

          const id = yield* certificate.issue(csr);

          yield* db.tunnel.update({
            ...info,
            certificateID: id,
          });
        }),
      });
    }),
  );
}
