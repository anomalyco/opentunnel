import { describe, expect, test } from "bun:test";
import { Option, Schema } from "effect";
import { BridgeProtocol } from "../src/bridge-protocol.js";
import { Names } from "../src/names.js";

const vector = (name: string) =>
  Bun.file(new URL(`../../../spec/vectors/${name}`, import.meta.url)).json();

const hex = (value: string) => Uint8Array.from(Buffer.from(value, "hex"));

describe("spec vectors", async () => {
  const control = await vector("control.json");
  const frames = await vector("frames.json");
  const routes = await vector("routes.json");
  const names = await vector("names.json");

  test("client control messages", () => {
    for (const message of control.client) {
      const decoded = Schema.decodeUnknownSync(BridgeProtocol.ClientControlMessage)(message);
      expect(Schema.encodeUnknownSync(BridgeProtocol.ClientControlMessage)(decoded)).toEqual(message);
    }
  });

  test("server control messages", () => {
    for (const message of control.server) {
      const decoded = BridgeProtocol.decodeServerMessage(JSON.stringify(message));
      expect(Option.isSome(decoded)).toBe(true);
      expect(Schema.encodeUnknownSync(BridgeProtocol.ServerControlMessage)(Option.getOrThrow(decoded))).toEqual(message);
    }
    for (const message of [...control.ignored, ...control.invalid]) {
      expect(Option.isNone(BridgeProtocol.decodeServerMessage(JSON.stringify(message)))).toBe(true);
    }
  });

  test("data frames", () => {
    for (const { conn, payload, frame } of frames) {
      expect(BridgeProtocol.buildDataFrame(conn, hex(payload))).toEqual(hex(frame));
      expect(BridgeProtocol.parseDataFrame(hex(frame))).toEqual({ conn, payload: hex(payload) });
    }
    expect(BridgeProtocol.parseDataFrame(new Uint8Array(3))).toBeNull();
  });

  test("routes", () => {
    for (const { sni, hostname, route } of routes) {
      expect(Names.routeForSni(sni, hostname) ?? null).toBe(route);
    }
  });

  test("names", () => {
    for (const { value, valid } of names.route) expect([value, Names.isValidRoute(value)]).toEqual([value, valid]);
    for (const { value, valid } of names.profile) expect([value, Names.isValidProfile(value)]).toEqual([value, valid]);
    for (const { value, valid } of names.target) {
      expect([value, Names.parseTarget(value) !== undefined]).toEqual([value, valid]);
    }
  });
});
