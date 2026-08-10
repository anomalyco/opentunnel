export * as Certificate from "./certificate.js";

import { Schema } from "effect";
import { Newtype } from "./newtype.js";

export class ID extends Newtype<ID>()("CertificateID", Schema.String) {}

export const Token = Schema.String.pipe(Schema.brand("ChallengeToken"));
export type Token = Schema.Schema.Type<typeof Token>;

export class StateChallenge extends Schema.Class<StateChallenge>("Certificate/StateChallenge")({
  type: Schema.Literal("challenge"),
  token: Schema.String,
  key: Schema.String,
}) {}

export class StateIssuing extends Schema.Class<StateIssuing>("Certificate/StateIssuing")({
  type: Schema.Literal("issuing"),
}) {}

export class StateReady extends Schema.Class<StateReady>("Certificate/StateReady")({
  type: Schema.Literal("ready"),
  certificate: Schema.String,
  chain: Schema.String,
  expiry: Schema.String,
}) {}

export class StateFailed extends Schema.Class<StateFailed>("Certificate/StateFailed")({
  type: Schema.Literal("failed"),
  reason: Schema.String,
}) {}

export const State = Schema.Union([StateChallenge, StateIssuing, StateReady, StateFailed]);
export type State = Schema.Schema.Type<typeof State>;

export class Info extends Schema.Class<Info>("Certificate")({
  id: ID,
  state: State,
}) {}
