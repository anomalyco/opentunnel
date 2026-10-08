import { Schema } from "effect";

export class OpenTunnelClientError extends Schema.TaggedError<OpenTunnelClientError>()(
  "OpenTunnelClientError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export class OpenTunnelStorageError extends Schema.TaggedError<OpenTunnelStorageError>()(
  "OpenTunnelStorageError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export type OpenTunnelError = OpenTunnelClientError | OpenTunnelStorageError;
