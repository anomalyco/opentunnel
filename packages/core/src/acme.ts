import { Effect, Schema, ServiceMap } from "effect";
import { ApiClient } from "@peculiar/acme-client";

export namespace Acme {
  export class Error extends Schema.TaggedErrorClass<Error>()("AcmeError", {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  }) {}

  const call = <T>(fn: () => Promise<T>, message: string) =>
    Effect.tryPromise({
      try: fn,
      catch: (cause) => new Error({ message, cause }),
    });

  export interface Client {
    newAccount(params: {
      contact: string[];
      termsOfServiceAgreed: boolean;
    }): Effect.Effect<unknown, Error>;
    newOrder(params: { identifiers: Array<{ type: string; value: string }> }): Effect.Effect<
      {
        content: { authorizations: string[]; finalize?: string; status: string };
        headers: { location: string | null };
      },
      Error
    >;
    getAuthorization(url: string): Effect.Effect<
      {
        content: {
          status: string;
          challenges?: Array<{ type: string; token: string; url: string }>;
        };
      },
      Error
    >;
    getChallenge(
      url: string,
      method: string,
    ): Effect.Effect<
      {
        content: { status: string };
        headers: { link: string[] | null };
      },
      Error
    >;
    finalize(
      url: string,
      params: { csr: string },
    ): Effect.Effect<{ content: { status: string } }, Error>;
    getOrder(
      url: string,
    ): Effect.Effect<{ content: { status: string; certificate?: string } }, Error>;
    getCertificate(url: string): Effect.Effect<{ content: ArrayBuffer[] }, Error>;
  }

  export interface Factory {
    createClient(
      key: { publicKey: CryptoKey; privateKey: CryptoKey },
      url: string,
    ): Effect.Effect<Client, Error>;
  }

  const wrapClient = (raw: ApiClient): Client => ({
    newAccount: (params) => call(() => raw.newAccount(params), "Create ACME account"),
    newOrder: (params) => call(() => raw.newOrder(params), "Create order"),
    getAuthorization: (url) => call(() => raw.getAuthorization(url), "Get authorization"),
    getChallenge: (url, method) => call(() => raw.getChallenge(url, method), "Trigger challenge"),
    finalize: (url, params) => call(() => raw.finalize(url, params), "Finalize order"),
    getOrder: (url) => call(() => raw.getOrder(url), "Get order"),
    getCertificate: (url) => call(() => raw.getCertificate(url), "Download certificate"),
  });

  export const Factory = ServiceMap.Reference<Factory>("AcmeFactory", {
    defaultValue: (): Factory => ({
      createClient: (key, url) =>
        call(() => ApiClient.create(key, url, { fetch, crypto }), "Create ACME client").pipe(
          Effect.map(wrapClient),
        ),
    }),
  });
}
