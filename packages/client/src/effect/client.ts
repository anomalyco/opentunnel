import { Cause, Effect, Layer, Queue, Context, Stream } from "effect";
import { HttpClientError } from "effect/http";
import { ApiRetry } from "@opentunnel/protocol/api-retry";
import { CSR } from "@opentunnel/protocol/csr";
import { Tunnel } from "@opentunnel/protocol/tunnel";
import { OpenTunnelApiClient } from "./api.js";
import { certificateRequest } from "./csr.js";
import { OpenTunnelClientError } from "./errors.js";
import * as OpenTunnelStorage from "./storage.js";
import type { OpenTunnelStorage as Storage } from "./storage.js";
import type {
  OpenTunnelClientEvent,
  OpenTunnelConnection,
  OpenTunnelEffectClient,
  OpenTunnelIdentity,
  OpenTunnelPendingIdentity,
  OpenTunnelProfileOptions,
  OpenTunnelProgressOptions,
  OpenTunnelProvisionStage,
} from "./types.js";
import { makeTransport } from "./proxy.js";
import { OpenTunnelAttachError, Tunnel as RunningTunnel, validateRoutes } from "./tunnel.js";

const profileName = (options?: OpenTunnelProfileOptions) => options?.profile ?? "default";
/** What went wrong with an API call: the HTTP status (and what Cloudflare means by it), the API's error, or the network failure. */
export const describeApiError = (cause: unknown): string | undefined => {
  if (HttpClientError.isHttpClientError(cause)) {
    const response = cause.response;
    if (!response) return cause.message;
    const message = ApiRetry.statusMessage(response.status, "");
    return message.startsWith("HTTP ") ? message : `${message} (HTTP ${response.status})`;
  }
  if (typeof cause === "object" && cause !== null) {
    const { _tag, message } = cause as { _tag?: unknown; message?: unknown };
    if (typeof _tag === "string" && typeof message === "string") return `${_tag}: ${message}`;
  }
  return cause instanceof Error ? cause.message : undefined;
};

const clientError = (message: string, cause: unknown) => {
  const detail = describeApiError(cause);
  return new OpenTunnelClientError({ message: detail ? `${message}: ${detail}` : message, cause });
};

/** A failure of the running tunnel, carrying the bridge's attach error code when there is one. */
const tunnelError = (message: string, cause: unknown) => {
  const detail = describeApiError(cause);
  return new OpenTunnelClientError({
    message: detail ? `${message}: ${detail}` : message,
    ...(cause instanceof OpenTunnelAttachError ? { code: cause.code } : {}),
    cause,
  });
};

/** A failure that may pass on its own: the API unreachable, rate limited, or failing on the server side. */
const isTransient = (cause: unknown) =>
  HttpClientError.isHttpClientError(cause) &&
  (cause.reason._tag === "TransportError" ||
    (cause.response !== undefined && ApiRetry.retryableStatus(cause.response.status, "idempotent")));

const privateKeyPem = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const body = btoa(binary);
  return `-----BEGIN PRIVATE KEY-----\n${body.match(/.{1,64}/g)?.join("\n") ?? body}\n-----END PRIVATE KEY-----\n`;
};

export interface OpenTunnelClientOptions {
  /** The API to use; defaults to `OPENTUNNEL_API`, then `https://opentunnel.xyz`. */
  readonly api?: URL | string;
  readonly storage?: Storage;
  /**
   * An `http://` or `https://` proxy URL (credentials as userinfo) for the API
   * and the bridge, instead of the one `HTTPS_PROXY`, `HTTP_PROXY`,
   * `ALL_PROXY` and `NO_PROXY` select. On Node it needs the `undici` package.
   * `layer` throws an `OpenTunnelClientError` when the proxy cannot be used.
   */
  readonly proxy?: string;
}

const transportFor = (proxy: string | undefined) => {
  try {
    return makeTransport(proxy);
  } catch (cause) {
    throw new OpenTunnelClientError({ message: cause instanceof Error ? cause.message : String(cause), cause });
  }
};

export class OpenTunnelClient extends Context.Service<
  OpenTunnelClient,
  OpenTunnelEffectClient
>()("@opentunnel/client/OpenTunnelClient") {
  static layer(options: OpenTunnelClientOptions = {}) {
    const storage = options.storage ?? OpenTunnelStorage.xdg();
    const transport = transportFor(options.proxy);
    const apiOption = options.api ?? (process.env.OPENTUNNEL_API || "https://opentunnel.xyz");
    return Layer.effect(
      OpenTunnelClient,
      Effect.gen(function* () {
        const api = yield* OpenTunnelApiClient;
        const apiUrl = new URL(apiOption);

        const get = Effect.fn("OpenTunnelClient.tunnel.get")(function* (
          input?: OpenTunnelProfileOptions,
        ) {
          return yield* storage.load(profileName(input));
        });

        const completePending = Effect.fn("OpenTunnelClient.tunnel.completePending")(function* (options: {
          readonly profile: string;
          readonly pending: OpenTunnelPendingIdentity;
          readonly onProgress?: (stage: OpenTunnelProvisionStage) => void;
        }) {
          const authorized = yield* api.authorized(Tunnel.Token.make(options.pending.token));
          yield* Effect.sync(() => options.onProgress?.("requesting-certificate"));
          yield* authorized.tunnel["tunnel.bindCertificate"]({
            params: { id: Tunnel.ID.make(options.pending.id) },
            payload: { csr: options.pending.csr as CSR.Raw },
          }).pipe(
            // A resumed provision may already have an issuance in flight.
            Effect.catchTag("CertificateInProgressError", () => Effect.void),
            Effect.mapError((cause) => clientError("Failed to start certificate issuance", cause)),
          );

          const certificate = yield* Effect.gen(function* () {
            while (true) {
              yield* Effect.sync(() => options.onProgress?.("waiting-certificate"));
              const value = yield* authorized.tunnel["tunnel.getCertificate"]({
                params: { id: Tunnel.ID.make(options.pending.id) },
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
          const identity: OpenTunnelIdentity = {
            id: options.pending.id,
            hostname: options.pending.hostname,
            token: options.pending.token,
            privateKey: options.pending.privateKey,
            certificate: certificate.certificate,
            chain: certificate.chain,
            certificateExpiry: new Date(certificate.expiry),
          };
          yield* Effect.sync(() => options.onProgress?.("saving-identity"));
          yield* storage.save(options.profile, identity);
          yield* Effect.sync(() => options.onProgress?.("ready"));
          return identity;
        });

        const provision = Effect.fn("OpenTunnelClient.tunnel.provision")(function* (options: {
          readonly profile: string;
          readonly id: Tunnel.ID;
          readonly hostname: string;
          readonly token: Tunnel.Token;
          readonly onProgress?: (stage: OpenTunnelProvisionStage) => void;
        }) {
          yield* Effect.sync(() => options.onProgress?.("generating-key"));
          const keys = yield* Effect.tryPromise({
            try: () =>
              crypto.subtle.generateKey(
                { name: "ECDSA", namedCurve: "P-256" },
                true,
                ["sign", "verify"],
              ) as Promise<CryptoKeyPair>,
            catch: (cause) => clientError("Failed to generate certificate key", cause),
          });
          yield* Effect.sync(() => options.onProgress?.("generating-csr"));
          const csr = yield* Effect.tryPromise({
            try: () => certificateRequest(options.hostname, keys),
            catch: (cause) => clientError("Failed to generate certificate request", cause),
          });
          const exported = yield* Effect.tryPromise({
            try: () => crypto.subtle.exportKey("pkcs8", keys.privateKey),
            catch: (cause) => clientError("Failed to export certificate key", cause),
          });
          const pending: OpenTunnelPendingIdentity = {
            id: String(options.id),
            hostname: options.hostname,
            token: options.token,
            privateKey: privateKeyPem(exported),
            csr,
          };
          yield* storage.savePending(options.profile, pending);
          return yield* completePending({
            profile: options.profile,
            pending,
            onProgress: options.onProgress,
          });
        });

        const create = Effect.fn("OpenTunnelClient.tunnel.create")(function* (
          input?: OpenTunnelProfileOptions & {
            readonly onProgress?: (stage: OpenTunnelProvisionStage) => void;
          },
        ) {
          const profile = profileName(input);
          if (yield* storage.load(profile)) {
            return yield* new OpenTunnelClientError({
              message: `Profile '${profile}' already has a tunnel`,
            });
          }

          const pending = yield* storage.loadPending(profile);
          if (pending) {
            yield* Effect.sync(() => input?.onProgress?.("resuming-certificate"));
            return yield* completePending({ profile, pending, onProgress: input?.onProgress });
          }

          yield* Effect.sync(() => input?.onProgress?.("creating-tunnel"));
          const created = yield* api.client.tunnel["tunnel.create"]({
            payload: {},
          }).pipe(Effect.mapError((cause) => clientError("Failed to create tunnel", cause)));
          return yield* provision({
            profile,
            id: created.tunnel.id,
            hostname: String(created.tunnel.hostname),
            token: created.token,
            onProgress: input?.onProgress,
          });
        });

        const ensure = Effect.fn("OpenTunnelClient.tunnel.ensure")(function* (
          input?: OpenTunnelProfileOptions & OpenTunnelProgressOptions,
        ) {
          const existing = yield* get(input);
          if (!existing) return yield* create(input);
          const progress = (stage: OpenTunnelProvisionStage) => Effect.sync(() => input?.onProgress?.(stage));
          yield* progress("checking-certificate");
          const authorized = yield* api.authorized(Tunnel.Token.make(existing.token));
          const certificate = yield* authorized.tunnel["tunnel.getCertificate"]({
            params: { id: Tunnel.ID.make(existing.id) },
          }).pipe(
            // The API is unreachable even after retries: a certificate that has not expired still serves, and a
            // running tunnel checks for a renewed one itself.
            Effect.catchIf(
              (cause) => isTransient(cause) && existing.certificateExpiry.getTime() > Date.now(),
              () => Effect.succeed(undefined),
            ),
            Effect.mapError((cause) => clientError("Failed to read certificate", cause)),
          );
          if (!certificate) {
            yield* progress("ready");
            return existing;
          }
          const state = certificate.state;
          // The server renewed the certificate while this machine was offline.
          if (state.type === "ready" && state.certificate !== existing.certificate) {
            const renewed: OpenTunnelIdentity = {
              ...existing,
              certificate: state.certificate,
              chain: state.chain,
              certificateExpiry: new Date(state.expiry),
            };
            yield* progress("saving-identity");
            yield* storage.save(profileName(input), renewed);
            yield* progress("ready");
            return renewed;
          }
          if (state.type !== "failed") {
            yield* progress("ready");
            return existing;
          }
          return yield* provision({
            profile: profileName(input),
            id: Tunnel.ID.make(existing.id),
            hostname: existing.hostname,
            token: Tunnel.Token.make(existing.token),
            onProgress: input?.onProgress,
          });
        });

        const pending = Effect.fn("OpenTunnelClient.tunnel.pending")(function* (
          input?: OpenTunnelProfileOptions,
        ) {
          const value = yield* storage.loadPending(profileName(input));
          return value ? { id: value.id, hostname: value.hostname } : undefined;
        });

        const resume = Effect.fn("OpenTunnelClient.tunnel.resume")(function* (
          input?: OpenTunnelProfileOptions & {
            readonly onProgress?: (stage: OpenTunnelProvisionStage) => void;
          },
        ) {
          const profile = profileName(input);
          const value = yield* storage.loadPending(profile);
          if (!value) return undefined;
          yield* Effect.sync(() => input?.onProgress?.("resuming-certificate"));
          return yield* completePending({ profile, pending: value, onProgress: input?.onProgress });
        });

        const client: OpenTunnelEffectClient = {
          profile: { list: storage.profiles },
          tunnel: {
            list: storage.list,
            get,
            pending,
            resume,
            create,
            ensure,
            remove: Effect.fn("OpenTunnelClient.tunnel.remove")(function* (input) {
              const profile = profileName(input);
              const identity = yield* storage.load(profile);
              if (!identity) return;
              const authorized = yield* api.authorized(Tunnel.Token.make(identity.token));
              yield* authorized.tunnel["tunnel.remove"]({
                params: { id: Tunnel.ID.make(identity.id) },
              }).pipe(
                Effect.mapError((cause) => clientError("Failed to remove tunnel", cause)),
              );
              yield* storage.remove(profile);
            }),
            connect: Effect.fn("OpenTunnelClient.tunnel.connect")(function* (input) {
              yield* Effect.try({
                try: () => validateRoutes(input.routes),
                catch: (cause) => clientError(cause instanceof Error ? cause.message : "Invalid routes", cause),
              });
              const identity = yield* ensure({ profile: input.profile });
              const events = yield* Queue.unbounded<OpenTunnelClientEvent, Cause.Done>();
              const tunnel = yield* Effect.acquireRelease(
                Effect.sync(() =>
                  new RunningTunnel({
                    api: apiUrl,
                    identity,
                    routes: input.routes,
                    onRouteConflict: input.onRouteConflict,
                    transport,
                    onEvent: (event) => {
                      input.onEvent?.(event);
                      Queue.offerUnsafe(events, event);
                      if (event.type === "stopped") Queue.endUnsafe(events);
                    },
                    onRenewed: (renewed) => {
                      Effect.runFork(storage.save(profileName(input), renewed).pipe(Effect.ignore));
                    },
                  })
                ),
                (tunnel) =>
                  Effect.promise(() => tunnel.close()).pipe(Effect.andThen(Queue.end(events))),
              );
              yield* Effect.tryPromise({
                try: () => tunnel.ready,
                catch: (cause) => tunnelError("Failed to connect tunnel", cause),
              }).pipe(
                // Stop attaching now rather than when the caller's scope closes.
                Effect.onInterrupt(() => Effect.promise(() => tunnel.close())),
              );
              return {
                tunnel: identity,
                events: Stream.fromQueue(events),
                status: Effect.sync(() => tunnel.getStatus()),
                urls: Effect.sync(() => tunnel.getUrls()),
                setRoutes: (routes) =>
                  Effect.try({
                    try: () => tunnel.setRoutes(routes),
                    catch: (cause) =>
                      clientError(cause instanceof Error ? cause.message : "Invalid routes", cause),
                  }),
                closed: Effect.tryPromise({
                  try: () => tunnel.closed,
                  catch: (cause) => tunnelError("Tunnel stopped", cause),
                }),
                close: Effect.promise(() => tunnel.close()),
              } satisfies OpenTunnelConnection;
            }),
          },
        };
        return client;
      }),
    ).pipe(
      Layer.provide(
        OpenTunnelApiClient.layer({
          api: apiOption,
          ...(transport.fetch ? { fetch: transport.fetch } : {}),
        }),
      ),
    );
  }
}
