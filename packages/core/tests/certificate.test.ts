import "reflect-metadata";
import { Effect, Layer, Option } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";
import { it } from "./effect-test.ts";
import { Certificate } from "../src/certificate.ts";
import { Database } from "../src/database.ts";
import { Acme } from "../src/acme.ts";
import { CSR } from "../src/csr.ts";

const testCSR: CSR.Info = {
  hostname: CSR.Hostname.makeUnsafe("test.example.com"),
  raw: CSR.Raw.makeUnsafe(
    "-----BEGIN CERTIFICATE REQUEST-----\ntest\n-----END CERTIFICATE REQUEST-----",
  ),
  certificate: {} as any,
};

const fakeCert = new Uint8Array([0x30, 0x82, 0x01, 0x00, 0xde, 0xad]).buffer;

const createFakeClient = (overrides?: Partial<Acme.Client>): Acme.Client => {
  const defaults: Acme.Client = {
    newAccount: () => Effect.succeed({}),
    newOrder: () =>
      Effect.succeed({
        content: {
          authorizations: ["https://acme.test/authz/1"],
          finalize: "https://acme.test/finalize/1",
          status: "pending",
        },
        headers: { location: "https://acme.test/order/1" },
      }),
    getAuthorization: () =>
      Effect.succeed({
        content: {
          status: "valid",
          challenges: [
            { type: "http-01", token: "test-token-123", url: "https://acme.test/chall/1" },
          ],
        },
      }),
    getChallenge: () =>
      Effect.succeed({
        content: { status: "processing" },
        headers: { link: ['<https://acme.test/authz/1>;rel="up"'] },
      }),
    finalize: () => Effect.succeed({ content: { status: "valid" } }),
    getOrder: () =>
      Effect.succeed({
        content: { status: "valid", certificate: "https://acme.test/cert/1" },
      }),
    getCertificate: () => Effect.succeed({ content: [fakeCert] }),
  };
  return { ...defaults, ...overrides };
};

const createTestLayer = (clientOverrides?: Partial<Acme.Client>) =>
  Layer.provide(
    Certificate.layer,
    Layer.mergeAll(
      Database.Memory,
      Layer.succeed(Acme.Factory, {
        createClient: () => Effect.succeed(createFakeClient(clientOverrides)),
      }),
    ),
  );

describe("Certificate", () => {
  it.effect("issue starts the ACME flow and returns an ID", () =>
    Effect.gen(function* () {
      const cert = yield* Certificate.Service;
      const id = yield* cert.issue(testCSR);
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("issue stores issuing state in database", () =>
    Effect.gen(function* () {
      const cert = yield* Certificate.Service;
      const id = yield* cert.issue(testCSR);
      const info = yield* cert.get(id);
      expect(Option.isSome(info)).toBe(true);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fromToken returns none for unknown token", () =>
    Effect.gen(function* () {
      const cert = yield* Certificate.Service;
      const result = yield* cert.fromToken(Certificate.Token.makeUnsafe("nonexistent"));
      expect(Option.isNone(result)).toBe(true);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("completes full ACME flow with happy path", () =>
    Effect.gen(function* () {
      const cert = yield* Certificate.Service;
      const id = yield* cert.issue(testCSR);

      yield* TestClock.setTime(Number.POSITIVE_INFINITY);

      const info = yield* cert.get(id);
      expect(Option.isSome(info) && info.value.state.type).toBe("ready");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("issue fails gracefully when no HTTP-01 challenge", () =>
    Effect.gen(function* () {
      const cert = yield* Certificate.Service;
      const id = yield* cert.issue(testCSR);

      yield* TestClock.setTime(Number.POSITIVE_INFINITY);

      const info = yield* cert.get(id);
      expect(Option.isSome(info) && info.value.state.type).toBe("failed");
    }).pipe(
      Effect.provide(
        createTestLayer({
          getAuthorization: () =>
            Effect.succeed({
              content: { status: "pending", challenges: [] },
            }),
        }),
      ),
    ),
  );
});
