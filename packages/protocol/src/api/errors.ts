import { Schema } from "effect";

export class InvalidRequestError extends Schema.TaggedError<InvalidRequestError>()(
  "InvalidRequestError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class UnauthorizedError extends Schema.TaggedError<UnauthorizedError>()(
  "UnauthorizedError",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

export class TunnelNotFoundError extends Schema.TaggedError<TunnelNotFoundError>()(
  "TunnelNotFoundError",
  { tunnelID: Schema.String, message: Schema.String },
  { httpApiStatus: 404 },
) {}

export class CertificateNotFoundError extends Schema.TaggedError<CertificateNotFoundError>()(
  "CertificateNotFoundError",
  { tunnelID: Schema.String, message: Schema.String },
  { httpApiStatus: 404 },
) {}

export class InvalidHostnameError extends Schema.TaggedError<InvalidHostnameError>()(
  "InvalidHostnameError",
  { provided: Schema.String, expected: Schema.String, message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class HostnameUnavailableError extends Schema.TaggedError<HostnameUnavailableError>()(
  "HostnameUnavailableError",
  { name: Schema.String, message: Schema.String },
  { httpApiStatus: 409 },
) {}

export class CertificateInProgressError extends Schema.TaggedError<CertificateInProgressError>()(
  "CertificateInProgressError",
  { tunnelID: Schema.String, message: Schema.String },
  { httpApiStatus: 409 },
) {}

export class ServiceUnavailableError extends Schema.TaggedError<ServiceUnavailableError>()(
  "ServiceUnavailableError",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}
