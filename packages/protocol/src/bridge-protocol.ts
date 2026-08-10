export * as BridgeProtocol from "./bridge-protocol.js";

import { Schema } from "effect";

/**
 * Bridge protocol types and schemas for the WebSocket binding.
 * Based on the bridge protocol specification from specs.md
 */

// Connection ID - unsigned 32-bit integer assigned by relay
export const ConnID = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0xffffffff }));
export type ConnID = Schema.Schema.Type<typeof ConnID>;

// Client information
export class ClientInfo extends Schema.Class<ClientInfo>("BridgeProtocol/ClientInfo")({
  version: Schema.String,
  max_conns: Schema.Number,
}) {}

// Attach request - first message after session setup
export class AttachMessage extends Schema.Class<AttachMessage>("BridgeProtocol/AttachMessage")({
  type: Schema.Literal("attach"),
  token: Schema.String,
  transport: Schema.Literal("ws"),
  client: ClientInfo,
  routes: Schema.Array(Schema.String).pipe(Schema.optional),
}) {}

// Attach success response
export class AttachedMessage extends Schema.Class<AttachedMessage>(
  "BridgeProtocol/AttachedMessage",
)({
  type: Schema.Literal("attached"),
  session: Schema.String,
  routes: Schema.Array(Schema.String),
  heartbeat_ms: Schema.Number,
  idle_timeout_ms: Schema.Number,
}) {}

// Attach failure response
export class AttachErrorMessage extends Schema.Class<AttachErrorMessage>(
  "BridgeProtocol/AttachErrorMessage",
)({
  type: Schema.Literal("attach_error"),
  code: Schema.String,
}) {}

// Ping message
export class PingMessage extends Schema.Class<PingMessage>("BridgeProtocol/PingMessage")({
  type: Schema.Literal("ping"),
  time_sent: Schema.Number,
}) {}

// Pong message
export class PongMessage extends Schema.Class<PongMessage>("BridgeProtocol/PongMessage")({
  type: Schema.Literal("pong"),
  time_sent: Schema.Number,
}) {}

// Drain message - graceful shutdown
export class DrainMessage extends Schema.Class<DrainMessage>("BridgeProtocol/DrainMessage")({
  type: Schema.Literal("drain"),
  reason: Schema.String,
}) {}

// Open channel metadata - relay opens a new public connection
export class OpenMessage extends Schema.Class<OpenMessage>("BridgeProtocol/OpenMessage")({
  type: Schema.Literal("open"),
  conn: ConnID,
  peer: Schema.String,
  sni: Schema.String,
  alpn: Schema.String,
}) {}

// End message - half-close
export class EndMessage extends Schema.Class<EndMessage>("BridgeProtocol/EndMessage")({
  type: Schema.Literal("end"),
  conn: ConnID,
}) {}

// Reset message - abortive close
export class ResetMessage extends Schema.Class<ResetMessage>("BridgeProtocol/ResetMessage")({
  type: Schema.Literal("reset"),
  conn: ConnID,
  code: Schema.String,
}) {}

// Union of all control message types sent by client
export const ClientControlMessage = Schema.Union([
  AttachMessage,
  PingMessage,
  PongMessage,
  DrainMessage,
  EndMessage,
  ResetMessage,
]);
export type ClientControlMessage = Schema.Schema.Type<typeof ClientControlMessage>;

// Union of all control message types sent by server
export const ServerControlMessage = Schema.Union([
  AttachedMessage,
  AttachErrorMessage,
  PingMessage,
  PongMessage,
  DrainMessage,
  OpenMessage,
  EndMessage,
  ResetMessage,
]);
export type ServerControlMessage = Schema.Schema.Type<typeof ServerControlMessage>;

// Union of all control message types
export const ControlMessage = Schema.Union([
  AttachMessage,
  AttachedMessage,
  AttachErrorMessage,
  PingMessage,
  PongMessage,
  DrainMessage,
  OpenMessage,
  EndMessage,
  ResetMessage,
]);
export type ControlMessage = Schema.Schema.Type<typeof ControlMessage>;

// WebSocket subprotocol name
export const WEBSOCKET_SUBPROTOCOL = "opentunnel";

// Error codes from specs.md
export const BridgeErrorCode = {
  BAD_ATTACH: "bad_attach",
  BAD_TOKEN: "bad_token",
  TUNNEL_NOT_BOUND: "tunnel_not_bound",
  CERT_NOT_READY: "cert_not_ready",
  REPLACED: "replaced",
  UPSTREAM_CONNECT_FAILED: "upstream_connect_failed",
  UPSTREAM_IO_ERROR: "upstream_io_error",
  CLIENT_IO_ERROR: "client_io_error",
  IDLE_TIMEOUT: "idle_timeout",
  ROUTE_CONFLICT: "route_conflict",
  INVALID_ROUTE: "invalid_route",
} as const;

// Default timing constants from specs.md
export const BridgeTiming = {
  HEARTBEAT_MS: 15000,
  IDLE_TIMEOUT_MS: 45000,
  CONNECT_TIMEOUT_MS: 10000,
  RECONNECT_BACKOFF_MIN_MS: 250,
  RECONNECT_BACKOFF_MAX_MS: 30000,
} as const;

// Data frame layout constants for WebSocket binary frames
// Format: u32_be conn + payload bytes
export const DataFrame = {
  CONN_ID_SIZE: 4, // bytes
  MAX_PAYLOAD_SIZE: 32768, // 32 KiB recommended max per frame
} as const;

// Parse a binary data frame to extract connection ID and payload
export function parseDataFrame(data: Uint8Array): { conn: number; payload: Uint8Array } | null {
  if (data.length < DataFrame.CONN_ID_SIZE) {
    return null;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const conn = view.getUint32(0, false); // big-endian
  const payload = data.slice(DataFrame.CONN_ID_SIZE);
  return { conn, payload };
}

// Build a binary data frame from connection ID and payload
export function buildDataFrame(conn: number, payload: Uint8Array): Uint8Array {
  const result = new Uint8Array(DataFrame.CONN_ID_SIZE + payload.length);
  const view = new DataView(result.buffer);
  view.setUint32(0, conn, false); // big-endian
  result.set(payload, DataFrame.CONN_ID_SIZE);
  return result;
}
