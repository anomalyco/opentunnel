import { expect, test } from "bun:test";
import { BridgeProtocol } from "../src/bridge-protocol.ts";

test("frames round-trip with offsets and expose a zero-copy payload view", () => {
  const payload = new Uint8Array([1, 2, 3, 4]);
  const frame = BridgeProtocol.buildDataFrame(0xdeadbeef, payload);
  const padded = new Uint8Array(frame.length + 12);
  padded.set(frame, 7);
  const input = padded.subarray(7, 7 + frame.length);
  const parsed = BridgeProtocol.parseDataFrame(input);
  expect(parsed.conn).toBe(0xdeadbeef);
  expect(parsed.payload).toEqual(payload);
  input[4] = 9;
  expect(parsed.payload[0]).toBe(9);
});

test("truncated frames are rejected and an empty payload is valid", () => {
  expect(BridgeProtocol.parseDataFrame(new Uint8Array(3))).toBeNull();
  expect(BridgeProtocol.parseDataFrame(BridgeProtocol.buildDataFrame(1, new Uint8Array()))).toEqual({ conn: 1, payload: new Uint8Array() });
});
