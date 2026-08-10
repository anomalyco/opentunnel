import { Effect, Schema } from "effect";
import { env } from "cloudflare:workers";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Certificate } from "@opentunnel/protocol/certificate";
import { Tunnel } from "@opentunnel/protocol/tunnel";
import { Api } from "@opentunnel/protocol/api/api";
import { OpenTunnelAuthorizationToken } from "@opentunnel/protocol/api/auth";
import {
  CertificateInProgressError,
  CertificateNotFoundError,
  HostnameUnavailableError,
  InvalidHostnameError,
  InvalidRequestError,
  ServiceUnavailableError,
  TunnelNotFoundError,
  UnauthorizedError,
} from "@opentunnel/protocol/api/errors";
import { hashToken, randomToken } from "../crypto.js";
import { Random } from "../random.js";

export const TunnelHandlers = HttpApiBuilder.group(Api, "tunnel", (handlers) =>
  handlers
    .handle("tunnel.create", ({ payload }) => {
      const id = payload.name?.toLowerCase() ?? Random.slug();
      if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(id)) {
        return Effect.gen(function* () {
          return yield* new InvalidRequestError({
            message: "Tunnel names must be 3-63 lowercase letters, numbers, or hyphens",
          });
        });
      }
      const token = Tunnel.Token.makeUnsafe(randomToken());
      return Effect.tryPromise({
        try: async () =>
          env.TUNNELS.getByName(id).initialize({
            id,
            hostname: `${id}.${env.OPENTUNNEL_DOMAIN}`,
            tokenHash: await hashToken(token),
          }),
        catch: (cause) => new ServiceUnavailableError({ message: String(cause) }),
      }).pipe(
        Effect.flatMap((tunnel) => Effect.gen(function* () {
          if (tunnel) return { tunnel: new Tunnel.Info(tunnel), token };
          return yield* new HostnameUnavailableError({
            name: id,
            message: "Hostname is unavailable",
          });
        })),
      );
    })
    .handle("tunnel.get", ({ params }) =>
      OpenTunnelAuthorizationToken.asEffect().pipe(
        Effect.flatMap((token) =>
          Effect.tryPromise({
            try: async () => await env.TUNNELS.getByName(String(params.id)).info(token),
            catch: (cause) => new ServiceUnavailableError({ message: String(cause) }),
          }),
        ),
        Effect.flatMap((result) => Effect.gen(function* () {
          if (result.status === "ok") return new Tunnel.Info(result.tunnel!);
          if (result.status === "unauthorized") {
            return yield* new UnauthorizedError({ message: "Invalid bearer token" });
          }
          return yield* new TunnelNotFoundError({
            tunnelID: String(params.id),
            message: "Tunnel not found",
          });
        })),
      ),
    )
    .handle("tunnel.bindCertificate", ({ params, payload }) =>
      OpenTunnelAuthorizationToken.asEffect().pipe(
        Effect.flatMap((token) =>
          Effect.tryPromise({
            try: async () =>
              await env.TUNNELS.getByName(String(params.id)).bindCertificate(token, payload.csr),
            catch: (cause) => new ServiceUnavailableError({ message: String(cause) }),
          }),
        ),
        Effect.flatMap((result) => Effect.gen(function* () {
          if (result.status === "ok") {
            const certificate = result.certificate!;
            const state = certificate.state.type === "issuing"
              ? new Certificate.StateIssuing(certificate.state)
              : certificate.state.type === "challenge"
                ? new Certificate.StateChallenge(certificate.state)
                : certificate.state.type === "ready"
                  ? new Certificate.StateReady(certificate.state)
                  : new Certificate.StateFailed(certificate.state);
            const info = new Certificate.Info({ id: certificate.id, state });
            yield* Effect.tryPromise({
              try: () => Schema.encodeUnknownPromise(Certificate.Info)(info),
              catch: (cause) => new ServiceUnavailableError({ message: String(cause) }),
            });
            return info;
          }
          if (result.status === "unauthorized") {
            return yield* new UnauthorizedError({ message: "Invalid bearer token" });
          }
          if (result.status === "not-found") {
            return yield* new TunnelNotFoundError({
              tunnelID: String(params.id),
              message: "Tunnel not found",
            });
          }
          if (result.status === "invalid-request") {
            return yield* new InvalidRequestError({ message: result.message! });
          }
          if (result.status === "invalid-hostname") {
            return yield* new InvalidHostnameError({
              provided: result.provided!,
              expected: result.expected!,
              message: "CSR hostname does not match tunnel hostname",
            });
          }
          if (result.status === "in-progress") {
            return yield* new CertificateInProgressError({
              tunnelID: String(params.id),
              message: "Certificate issuance is already in progress",
            });
          }
          return yield* new ServiceUnavailableError({ message: result.message! });
        })),
      ),
    )
    .handle("tunnel.getCertificate", ({ params }) =>
      OpenTunnelAuthorizationToken.asEffect().pipe(
        Effect.flatMap((token) =>
          Effect.tryPromise({
            try: async () => await env.TUNNELS.getByName(String(params.id)).certificate(token),
            catch: (cause) => new ServiceUnavailableError({ message: String(cause) }),
          }),
        ),
        Effect.flatMap((result) => Effect.gen(function* () {
          if (result.status === "ok") {
            const certificate = result.certificate!;
            const state = certificate.state.type === "issuing"
              ? new Certificate.StateIssuing(certificate.state)
              : certificate.state.type === "challenge"
                ? new Certificate.StateChallenge(certificate.state)
                : certificate.state.type === "ready"
                  ? new Certificate.StateReady(certificate.state)
                  : new Certificate.StateFailed(certificate.state);
            const info = new Certificate.Info({ id: certificate.id, state });
            yield* Effect.tryPromise({
              try: () => Schema.encodeUnknownPromise(Certificate.Info)(info),
              catch: (cause) => new ServiceUnavailableError({ message: String(cause) }),
            });
            return info;
          }
          if (result.status === "unauthorized") {
            return yield* new UnauthorizedError({ message: "Invalid bearer token" });
          }
          if (result.status === "no-certificate") {
            return yield* new CertificateNotFoundError({
              tunnelID: String(params.id),
              message: "Certificate not found",
            });
          }
          return yield* new TunnelNotFoundError({
            tunnelID: String(params.id),
            message: "Tunnel not found",
          });
        })),
      ),
    )
    .handle("tunnel.remove", ({ params }) =>
      OpenTunnelAuthorizationToken.asEffect().pipe(
        Effect.flatMap((token) =>
          Effect.tryPromise({
            try: async () => await env.TUNNELS.getByName(String(params.id)).remove(token),
            catch: (cause) => new ServiceUnavailableError({ message: String(cause) }),
          }),
        ),
        Effect.flatMap((result) => Effect.gen(function* () {
          if (result === "ok") return;
          if (result === "unauthorized") {
            return yield* new UnauthorizedError({ message: "Invalid bearer token" });
          }
          return yield* new TunnelNotFoundError({
            tunnelID: String(params.id),
            message: "Tunnel not found",
          });
        })),
      ),
    )
    .handle("tunnel.connect", () => Effect.succeed(true)),
);
