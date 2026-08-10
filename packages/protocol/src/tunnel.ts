export * as Tunnel from "./tunnel.js";

import { Schema } from "effect";
import { CSR } from "./csr.js";
import { Certificate } from "./certificate.js";
import { Newtype } from "./newtype.js";

export class ID extends Newtype<ID>()("TunnelID", Schema.String) {}

export const Token = Schema.String.pipe(Schema.brand("TunnelToken"));
export type Token = Schema.Schema.Type<typeof Token>;

export class NotFoundError extends Schema.TaggedErrorClass()("NotFound", {
  tunnelID: ID,
}) {}

export class NoCertificateError extends Schema.TaggedErrorClass()("NoCertificate", {
  tunnelID: ID,
}) {}

export class CertificateNotReadyError extends Schema.TaggedErrorClass()(
  "CertificateNotReady",
  { tunnelID: ID, currentState: Schema.String },
) {}

export class InvalidHostnameError extends Schema.TaggedErrorClass()(
  "InvalidHostname",
  { provided: CSR.Hostname, expected: CSR.Hostname },
) {}

export const State = Schema.Literals(["offline", "online"]);
export type State = Schema.Schema.Type<typeof State>;

export class Info extends Schema.Class<Info>("Tunnel/Info")({
  id: ID,
  hostname: CSR.Hostname,
  state: State,
  certificateID: Certificate.ID.pipe(Schema.optional),
}) {}
