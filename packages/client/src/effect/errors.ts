import { Schema } from "effect";

export class OpenTunnelClientError extends Schema.TaggedErrorClass<OpenTunnelClientError>()(
  "OpenTunnelClientError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect) },
) {}

export class OpenTunnelStorageError extends Schema.TaggedErrorClass<OpenTunnelStorageError>()(
  "OpenTunnelStorageError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect) },
) {}

export type OpenTunnelError = OpenTunnelClientError | OpenTunnelStorageError;
