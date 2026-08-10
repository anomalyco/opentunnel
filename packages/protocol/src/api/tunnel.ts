import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import { Certificate } from "../certificate.js";
import { CSR } from "../csr.js";
import { Tunnel } from "../tunnel.js";
import {
  CertificateInProgressError,
  CertificateNotFoundError,
  HostnameUnavailableError,
  InvalidHostnameError,
  InvalidRequestError,
  ServiceUnavailableError,
  TunnelNotFoundError,
} from "./errors.js";
import { OpenTunnelAuthorization } from "./auth.js";

export const CreateTunnelRequest = Schema.Struct({
  name: Schema.String.pipe(Schema.optional),
});

export const CreateTunnelResponse = Schema.Struct({
  tunnel: Tunnel.Info,
  token: Tunnel.Token,
}).pipe(HttpApiSchema.status(201));

export const TunnelGroup = HttpApiGroup.make("tunnel")
  .add(
    HttpApiEndpoint.post("tunnel.create", "/api/tunnel", {
      payload: CreateTunnelRequest,
      success: CreateTunnelResponse,
      error: [InvalidRequestError, HostnameUnavailableError, ServiceUnavailableError],
    }),
  )
  .add(
    HttpApiEndpoint.get("tunnel.get", "/api/tunnel/:id", {
      params: Schema.Struct({ id: Tunnel.ID }),
      success: Tunnel.Info,
      error: [TunnelNotFoundError, ServiceUnavailableError],
    }).middleware(OpenTunnelAuthorization),
  )
  .add(
    HttpApiEndpoint.post("tunnel.bindCertificate", "/api/tunnel/:id/certificate", {
      params: Schema.Struct({ id: Tunnel.ID }),
      payload: Schema.Struct({ csr: CSR.Raw }),
      success: Certificate.Info.pipe(HttpApiSchema.status(202)),
      error: [
        InvalidRequestError,
        InvalidHostnameError,
        TunnelNotFoundError,
        CertificateInProgressError,
        ServiceUnavailableError,
      ],
    }).middleware(OpenTunnelAuthorization),
  )
  .add(
    HttpApiEndpoint.get("tunnel.getCertificate", "/api/tunnel/:id/certificate", {
      params: Schema.Struct({ id: Tunnel.ID }),
      success: Certificate.Info,
      error: [
        TunnelNotFoundError,
        CertificateNotFoundError,
        ServiceUnavailableError,
      ],
    }).middleware(OpenTunnelAuthorization),
  )
  .add(
    HttpApiEndpoint.delete("tunnel.remove", "/api/tunnel/:id", {
      params: Schema.Struct({ id: Tunnel.ID }),
      success: HttpApiSchema.NoContent,
      error: [TunnelNotFoundError, ServiceUnavailableError],
    }).middleware(OpenTunnelAuthorization),
  )
  .add(
    HttpApiEndpoint.get("tunnel.connect", "/api/tunnel/:id/connect", {
      params: Schema.Struct({ id: Tunnel.ID }),
      success: Schema.Boolean,
      error: [TunnelNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        summary: "Connect a bridge WebSocket",
        description: "This endpoint upgrades to the opentunnel WebSocket protocol.",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "tunnel" }));
