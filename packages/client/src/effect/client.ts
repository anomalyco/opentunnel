import "reflect-metadata";
import { Effect, Layer, ServiceMap } from "effect";
import {
  Pkcs10CertificateRequestGenerator,
  SubjectAlternativeNameExtension,
} from "@peculiar/x509";
import { CSR } from "@opentunnel/protocol/csr";
import { Tunnel } from "@opentunnel/protocol/tunnel";
import { OpenTunnelApiClient } from "./api.js";
import { OpenTunnelClientError } from "./errors.js";
import { OpenTunnelStorage, type OpenTunnelStorage as Storage } from "./storage.js";
import type {
  OpenTunnelEffectClient,
  OpenTunnelIdentity,
  OpenTunnelProfileOptions,
  OpenTunnelRoute,
} from "./types.js";
import { connectBridge } from "./bridge.js";

const profileName = (options?: OpenTunnelProfileOptions) => options?.profile ?? "default";
const clientError = (message: string, cause: unknown) =>
  new OpenTunnelClientError({ message, cause });

const privateKeyPem = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const body = btoa(binary);
  return `-----BEGIN PRIVATE KEY-----\n${body.match(/.{1,64}/g)?.join("\n") ?? body}\n-----END PRIVATE KEY-----\n`;
};

export interface OpenTunnelClientOptions {
  readonly api?: URL | string;
  readonly storage?: Storage;
}

export class OpenTunnelClient extends ServiceMap.Service<
  OpenTunnelClient,
  OpenTunnelEffectClient
>()("@opentunnel/client/OpenTunnelClient") {
  static layer(options: OpenTunnelClientOptions = {}) {
    const storage = options.storage ?? OpenTunnelStorage.xdg();
    return Layer.effect(
      OpenTunnelClient,
      Effect.gen(function* () {
        const api = yield* OpenTunnelApiClient;
        const routesByProfile = new Map<string, ReadonlyArray<OpenTunnelRoute>>();

        const get = Effect.fn("OpenTunnelClient.tunnel.get")(function* (
          input?: OpenTunnelProfileOptions,
        ) {
          return yield* storage.load(profileName(input));
        });

        const provision = Effect.fn("OpenTunnelClient.tunnel.provision")(function* (options: {
          readonly profile: string;
          readonly id: Tunnel.ID;
          readonly hostname: string;
          readonly token: Tunnel.Token;
        }) {
          const keys = yield* Effect.tryPromise({
            try: () =>
              crypto.subtle.generateKey(
                { name: "ECDSA", namedCurve: "P-256" },
                true,
                ["sign", "verify"],
              ) as Promise<CryptoKeyPair>,
            catch: (cause) => clientError("Failed to generate certificate key", cause),
          });
          const csr = yield* Effect.tryPromise({
            try: () =>
              Pkcs10CertificateRequestGenerator.create({
                name: `CN=${options.hostname}`,
                extensions: [
                  new SubjectAlternativeNameExtension([
                    { type: "dns", value: options.hostname },
                    { type: "dns", value: `*.${options.hostname}` },
                  ]),
                ],
                signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
                keys,
              }),
            catch: (cause) => clientError("Failed to generate certificate request", cause),
          });
          const authorized = yield* api.authorized(options.token);
          yield* authorized.tunnel["tunnel.bindCertificate"]({
            params: { id: options.id },
            payload: { csr: csr.toString() as CSR.Raw },
          }).pipe(
            Effect.mapError((cause) => clientError("Failed to start certificate issuance", cause)),
          );

          const certificate = yield* Effect.gen(function* () {
            while (true) {
              const value = yield* authorized.tunnel["tunnel.getCertificate"]({
                params: { id: options.id },
              }).pipe(
                Effect.mapError((cause) => clientError("Failed to read certificate", cause)),
              );
              if (value.state.type === "ready") return value.state;
              if (value.state.type === "failed") {
                return yield* new OpenTunnelClientError({
                  message: `Certificate issuance failed: ${value.state.reason}`,
                });
              }
              yield* Effect.sleep("2 seconds");
            }
          });
          const exported = yield* Effect.tryPromise({
            try: () => crypto.subtle.exportKey("pkcs8", keys.privateKey),
            catch: (cause) => clientError("Failed to export certificate key", cause),
          });
          const identity: OpenTunnelIdentity = {
            id: String(options.id),
            hostname: options.hostname,
            token: options.token,
            privateKey: privateKeyPem(exported),
            certificate: certificate.certificate,
            chain: certificate.chain,
            certificateExpiry: new Date(certificate.expiry),
          };
          yield* storage.save(options.profile, identity);
          return identity;
        });

        const create = Effect.fn("OpenTunnelClient.tunnel.create")(function* (
          input?: OpenTunnelProfileOptions & { readonly name?: string },
        ) {
          const profile = profileName(input);
          if (yield* storage.load(profile)) {
            return yield* new OpenTunnelClientError({
              message: `Profile '${profile}' already has a tunnel`,
            });
          }

          const created = yield* api.client.tunnel["tunnel.create"]({
            payload: { name: input?.name },
          }).pipe(Effect.mapError((cause) => clientError("Failed to create tunnel", cause)));
          return yield* provision({
            profile,
            id: created.tunnel.id,
            hostname: String(created.tunnel.hostname),
            token: created.token,
          });
        });

        const ensure = Effect.fn("OpenTunnelClient.tunnel.ensure")(function* (
          input?: OpenTunnelProfileOptions & { readonly name?: string },
        ) {
          const existing = yield* get(input);
          if (!existing) return yield* create(input);
          const authorized = yield* api.authorized(Tunnel.Token.makeUnsafe(existing.token));
          const certificate = yield* authorized.tunnel["tunnel.getCertificate"]({
            params: { id: Tunnel.ID.makeUnsafe(existing.id) },
          }).pipe(
            Effect.mapError((cause) => clientError("Failed to read certificate", cause)),
          );
          if (certificate.state.type !== "failed") return existing;
          return yield* provision({
            profile: profileName(input),
            id: Tunnel.ID.makeUnsafe(existing.id),
            hostname: existing.hostname,
            token: Tunnel.Token.makeUnsafe(existing.token),
          });
        });

        const listRoutes = Effect.fn("OpenTunnelClient.route.list")(function* (
          input?: OpenTunnelProfileOptions,
        ) {
          const profile = profileName(input);
          const identity = yield* storage.load(profile);
          const routes = routesByProfile.get(profile) ?? [];
          return routes.map((route) => ({
            ...route,
            hostname: identity ? `${route.name}.${identity.hostname}` : route.name,
          }));
        });

        const client: OpenTunnelEffectClient = {
          profile: { list: storage.profiles },
          route: {
            list: listRoutes,
            add: Effect.fn("OpenTunnelClient.route.add")(function* (input) {
              const profile = profileName(input);
              const identity = yield* ensure(input);
              const routes = routesByProfile.get(profile) ?? [];
              if (routes.some((route) => route.name === input.name)) {
                return yield* new OpenTunnelClientError({
                  message: `Route '${input.name}' already exists in profile '${profile}'`,
                });
              }
              if (input.target.includes("://")) {
                return yield* new OpenTunnelClientError({
                  message: "Route targets must use host:port",
                });
              }
              const target = new URL(`tcp://${input.target}`);
              if (!target.hostname || !target.port) {
                return yield* new OpenTunnelClientError({ message: "Route targets must use host:port" });
              }
              const route: OpenTunnelRoute = {
                name: input.name,
                hostname: `${input.name}.${identity.hostname}`,
                target: input.target,
              };
              routesByProfile.set(profile, [...routes, route]);
              return route;
            }),
            remove: Effect.fn("OpenTunnelClient.route.remove")(function* (input) {
              const profile = profileName(input);
              const routes = routesByProfile.get(profile) ?? [];
              routesByProfile.set(
                profile,
                routes.filter((route) => route.name !== input.name),
              );
            }),
          },
          tunnel: {
            list: storage.list,
            get,
            create,
            ensure,
            remove: Effect.fn("OpenTunnelClient.tunnel.remove")(function* (input) {
              const profile = profileName(input);
              const identity = yield* storage.load(profile);
              if (!identity) return;
              const authorized = yield* api.authorized(Tunnel.Token.makeUnsafe(identity.token));
              yield* authorized.tunnel["tunnel.remove"]({
                params: { id: Tunnel.ID.makeUnsafe(identity.id) },
              }).pipe(
                Effect.mapError((cause) => clientError("Failed to remove tunnel", cause)),
              );
              yield* storage.remove(profile);
            }),
            connect: (input) =>
              Effect.gen(function* () {
                const profile = profileName(input);
                const identity = yield* ensure(input);
                const configured = routesByProfile.get(profile) ?? [];
                return yield* connectBridge({
                  api: new URL(options.api ?? "https://opentunnel.xyz"),
                  identity,
                  routes: configured,
                });
              }),
          },
        };
        return client;
      }),
    ).pipe(
      Layer.provide(OpenTunnelApiClient.layer({ api: options.api ?? "https://opentunnel.xyz" })),
    );
  }
}
