import {
  Scope,
  Schedule,
  Duration,
  Effect,
  HashMap,
  Layer,
  Option,
  Schema,
  ServiceMap,
} from "effect";
import { Database } from "./database.ts";
import { CSR } from "./csr.ts";
import { Acme } from "./acme.ts";
import { JsonWebKey } from "@peculiar/jose";
import { AppConfig } from "./config.ts";

export namespace Certificate {
  export const ID = Schema.String.pipe(Schema.brand("RequestID"));
  export type ID = Schema.Schema.Type<typeof ID>;

  export const Token = Schema.String.pipe(Schema.brand("ChallengeToken"));
  export type Token = Schema.Schema.Type<typeof Token>;

  export const StateNone = Schema.Struct({
    type: Schema.Literal("none"),
  });

  export const StateChallenge = Schema.Struct({
    type: Schema.Literal("challenge"),
    token: Schema.String,
    key: Schema.String,
  });

  export const StateIssuing = Schema.Struct({
    type: Schema.Literal("issuing"),
  });

  export const StateReady = Schema.Struct({
    type: Schema.Literal("ready"),
    certificate: Schema.String,
    chain: Schema.String,
    expiry: Schema.String,
  });

  export const StateFailed = Schema.Struct({
    type: Schema.Literal("failed"),
    reason: Schema.String,
  });

  export const StateExpired = Schema.Struct({
    type: Schema.Literal("expired"),
  });

  export const State = Schema.Union([
    StateNone,
    StateChallenge,
    StateIssuing,
    StateReady,
    StateFailed,
    StateExpired,
  ]);
  export type State = Schema.Schema.Type<typeof State>;

  export const Info = Schema.Struct({
    id: ID,
    state: State,
  });
  export type Info = Schema.Schema.Type<typeof Info>;

  export class Service extends ServiceMap.Service<
    Service,
    {
      issue: (csr: CSR.Info) => Effect.Effect<ID>;
      fromToken: (token: Token) => Effect.Effect<Option.Option<Info>>;
      get: (id: ID) => Effect.Effect<Option.Option<Info>>;
    }
  >()("Certificate") {}

  const toBase64Url = (base64: string): string =>
    base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const pemToBase64Url = (pem: string): string =>
    toBase64Url(
      pem
        .replace(/-----BEGIN [^-]+-----/, "")
        .replace(/-----END [^-]+-----/, "")
        .replace(/\s/g, ""),
    );

  const parseUpLink = (links: string[] | null): string | undefined => {
    const upLink = links?.find((o) => o.includes('up"'));
    if (!upLink) return undefined;
    return /<([^<>]+)>/.exec(upLink)?.[1];
  };

  /** Repeatedly run `self` while `predicate` holds, waiting `interval` between attempts. */
  const pollWhile = <A, E, R>(
    self: Effect.Effect<A, E, R>,
    options: { interval: Duration.Input; while: (a: A) => boolean; maxAttempts?: number },
  ) =>
    Effect.repeat(
      self,
      Schedule.identity<A>().pipe(
        Schedule.addDelay(() => Effect.succeed(options.interval)),
        Schedule.while(
          ({ input, attempt }) => options.while(input) && attempt < (options.maxAttempts ?? 30),
        ),
      ),
    );

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      const db = yield* Database.Service;
      const config = yield* AppConfig;
      const acmeFactory = yield* Acme.Factory;
      const email = `acme@${config.OPENTUNNEL_DOMAIN}`;

      let tokenMap = HashMap.empty<Token, ID>();

      const accountKey = yield* Effect.tryPromise({
        try: async () => {
          const key = await crypto.subtle.generateKey(
            { name: "ECDSA", namedCurve: "P-256" },
            true,
            ["sign", "verify"],
          );
          if (!("publicKey" in key)) throw new Error("Expected key pair");
          return key;
        },
        catch: (cause) => new Acme.Error({ message: "Generate account key", cause }),
      });
      const client = yield* acmeFactory.createClient(accountKey, config.ACME_URL);

      yield* client.newAccount({ contact: [`mailto:` + email], termsOfServiceAgreed: true });

      // Compute once; deterministic for a given key
      const keyThumbprint = yield* Effect.tryPromise({
        try: async () => {
          const jwk = await crypto.subtle.exportKey("jwk", accountKey.publicKey);
          const joseJwk = new JsonWebKey(crypto, jwk);
          const hex = await joseJwk.getThumbprint();
          const bytes = hex.match(/.{2}/g)!.map((b: string) => parseInt(b, 16));
          return toBase64Url(btoa(String.fromCharCode(...bytes)));
        },
        catch: (cause) => new Acme.Error({ message: "Compute thumbprint", cause }),
      });

      const acme = Effect.fn("Certificate.acme")(
        function* (id: ID, csr: CSR.Info) {
          yield* Effect.log("Starting ACME flow...");

          // 1. Create order
          const order = yield* client.newOrder({
            identifiers: [{ type: "dns", value: csr.hostname }],
          });
          yield* Effect.log("Created order", order.content);

          // 2. Get authorization and find HTTP-01 challenge
          const auth = yield* client.getAuthorization(order.content.authorizations[0]);

          const httpChallenge = auth.content.challenges?.find((c) => c.type === "http-01");
          if (!httpChallenge)
            return yield* new Acme.Error({ message: "No HTTP-01 challenge found" });

          const keyAuth = `${httpChallenge.token}.${keyThumbprint}`;

          // 3. Store challenge and trigger validation
          yield* db.certificate.update({
            id,
            state: {
              type: "challenge",
              token: httpChallenge.token,
              key: keyAuth,
            },
          });

          tokenMap = HashMap.set(tokenMap, Token.makeUnsafe(httpChallenge.token), id);
          yield* Effect.log({ token: httpChallenge.token });

          const challengeResp = yield* client.getChallenge(httpChallenge.url, "POST");

          yield* Effect.log("Challenge triggered, waiting for authorization...");

          const upUrl = parseUpLink(challengeResp.headers.link);
          if (!upUrl) {
            return yield* new Acme.Error({
              message: "Cannot parse authorization URL from challenge response",
            });
          }

          // 4. Wait for authorization to be valid
          const validAuth = yield* pollWhile(client.getAuthorization(upUrl), {
            interval: "5 seconds",
            while: (resp) => resp.content.status === "pending",
          });
          yield* Effect.log("Authorization status:", validAuth);

          if (validAuth.content.status !== "valid") {
            return yield* new Acme.Error({
              message: `Authorization status is ${validAuth.content.status}, expected valid`,
            });
          }

          yield* Effect.log("Authorization valid, finalizing order...");

          // 5. Finalize order with CSR
          if (!order.content.finalize) {
            return yield* new Acme.Error({ message: "Order has no finalize URL" });
          }
          yield* client.finalize(order.content.finalize, { csr: pemToBase64Url(csr.raw) });

          yield* Effect.log("Finalized, waiting for certificate...");

          const orderUrl = order.headers.location;
          if (!orderUrl) {
            return yield* new Acme.Error({
              message: "Cannot get order URL from newOrder response",
            });
          }

          // 6. Wait for certificate to be issued
          const validOrder = yield* pollWhile(client.getOrder(orderUrl), {
            interval: "3 seconds",
            while: (resp) => resp.content.status === "processing",
          });
          yield* Effect.log("Order status:", validOrder);

          if (validOrder.content.status !== "valid") {
            return yield* new Acme.Error({
              message: `Order status is ${validOrder.content.status}, expected valid`,
            });
          }

          if (!validOrder.content.certificate) {
            return yield* new Acme.Error({
              message: "Order is valid but no certificate URL found",
            });
          }

          // 7. Download certificate
          const certResponse = yield* client.getCertificate(validOrder.content.certificate);

          yield* Effect.log("Certificate downloaded");

          const certChain = certResponse.content
            .map((buf: ArrayBuffer) => {
              const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
              return `-----BEGIN CERTIFICATE-----\n${base64.match(/.{1,64}/g)?.join("\n")}\n-----END CERTIFICATE-----`;
            })
            .join("\n");

          tokenMap = HashMap.remove(tokenMap, Token.makeUnsafe(httpChallenge.token));

          // TODO: Parse certificate for expiry date
          yield* db.certificate.update({
            id,
            state: {
              type: "ready",
              certificate: certChain,
              chain: certChain,
              expiry: "TODO",
            },
          });

          return certChain;
        },
        (effect, id) =>
          Effect.catch(
            effect,
            Effect.fn(function* (err) {
              yield* Effect.logError("ACME flow failed:", err);
              yield* db.certificate.update({
                id,
                state: {
                  type: "failed",
                  reason: err.message,
                },
              });
            }),
          ),
      );

      return Service.of({
        issue: Effect.fn(function* (csr) {
          const id = ID.makeUnsafe(crypto.randomUUID());

          yield* db.certificate.update({
            id,
            state: { type: "issuing" },
          });
          yield* acme(id, csr).pipe(Effect.forkIn(scope));
          return id;
        }),
        fromToken: Effect.fn(function* (token) {
          const id = HashMap.get(tokenMap, token);
          if (Option.isNone(id)) {
            return Option.none();
          }
          return yield* db.certificate.get(id.value);
        }),
        get: Effect.fn(function* (id) {
          return yield* db.certificate.get(id);
        }),
      });
    }),
  );
}
