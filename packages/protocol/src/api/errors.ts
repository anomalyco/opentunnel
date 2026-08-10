import { Schema } from "effect";

export class InvalidRequestError extends Schema.TaggedErrorClass<InvalidRequestError>()(
  "InvalidRequestError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class UnauthorizedError extends Schema.TaggedErrorClass<UnauthorizedError>()(
  "UnauthorizedError",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

export class TunnelNotFoundError extends Schema.TaggedErrorClass<TunnelNotFoundError>()(
  "TunnelNotFoundError",
  { tunnelID: Schema.String, message: Schema.String },
  { httpApiStatus: 404 },
) {}

export class CertificateNotFoundError extends Schema.TaggedErrorClass<CertificateNotFoundError>()(
  "CertificateNotFoundError",
  { tunnelID: Schema.String, message: Schema.String },
  { httpApiStatus: 404 },
) {}

export class InvalidHostnameError extends Schema.TaggedErrorClass<InvalidHostnameError>()(
  "InvalidHostnameError",
  { provided: Schema.String, expected: Schema.String, message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class HostnameUnavailableError extends Schema.TaggedErrorClass<HostnameUnavailableError>()(
  "HostnameUnavailableError",
  { name: Schema.String, message: Schema.String },
  { httpApiStatus: 409 },
) {}

export class CertificateInProgressError extends Schema.TaggedErrorClass<CertificateInProgressError>()(
  "CertificateInProgressError",
  { tunnelID: Schema.String, message: Schema.String },
  { httpApiStatus: 409 },
) {}

export class ServiceUnavailableError extends Schema.TaggedErrorClass<ServiceUnavailableError>()(
  "ServiceUnavailableError",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}
