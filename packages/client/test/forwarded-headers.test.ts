import { describe, expect, test } from "bun:test";
import { ForwardedHeaders } from "../src/effect/forwarded-headers.js";

const PEER = "203.0.113.9";

/** Feeds `input` through the transform in slices of `chunkSize`, and returns what came out. */
const forward = async (input: Buffer, peer = PEER, chunkSize = input.length) => {
  const transform = new ForwardedHeaders(peer);
  const out: Buffer[] = [];
  transform.on("data", (chunk: Buffer) => out.push(chunk));
  const ended = new Promise<void>((resolve) => transform.on("end", () => resolve()));
  for (let offset = 0; offset < input.length; offset += chunkSize) {
    transform.write(input.subarray(offset, offset + chunkSize));
    await new Promise((resolve) => setImmediate(resolve));
  }
  transform.end();
  await ended;
  return Buffer.concat(out);
};

const headEnd = (output: Buffer) => output.indexOf("\r\n\r\n");
const headOf = (output: Buffer) => output.subarray(0, headEnd(output)).toString("latin1");
const restOf = (output: Buffer) => output.subarray(headEnd(output) + 4);
const requestLineOf = (head: string) => head.split("\r\n")[0];
const headerLines = (head: string) => head.split("\r\n").slice(1);
const headerName = (line: string) => line.slice(0, line.indexOf(":")).trim().toLowerCase();
const valuesOf = (head: string, name: string) =>
  headerLines(head)
    .filter((line) => headerName(line) === name)
    .map((line) => line.slice(line.indexOf(":") + 1).trim());

/** Connections the transform must not touch, byte for byte. */
const opaque = {
  "a nested TLS session": Buffer.concat([
    Buffer.from([0x16, 0x03, 0x01, 0x00, 0xf1]),
    Buffer.from(Array.from({ length: 300 }, (_, index) => (index * 7) % 256)),
  ]),
  "an SSH banner": Buffer.concat([
    Buffer.from("SSH-2.0-OpenSSH_9.0\r\n", "latin1"),
    Buffer.from([0, 0, 0, 12, 1, 2, 3]),
  ]),
  "the cleartext HTTP/2 preface": Buffer.concat([
    Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n", "latin1"),
    Buffer.from([0, 0, 18, 4, 0, 0, 0, 0, 0]),
  ]),
  "a request line naming another version": Buffer.from("GET / HTTP/2.0\r\nHost: h\r\n\r\n", "latin1"),
  "a request line holding a space": Buffer.from("GET /a b HTTP/1.1\r\nHost: h\r\n\r\n", "latin1"),
  "a prefix longer than any request line": Buffer.concat([Buffer.from("A"), Buffer.alloc(70 * 1024, 0x41)]),
};

describe("ForwardedHeaders", () => {
  test("adds the forwarding headers and leaves the request line alone", async () => {
    const head = headOf(
      await forward(
        Buffer.from(
          "GET /api/ping HTTP/1.1\r\nHost: fount.example\r\nUser-Agent: probe\r\nAccept: */*\r\n\r\n",
          "latin1",
        ),
      ),
    );
    expect(requestLineOf(head)).toBe("GET /api/ping HTTP/1.1");
    expect(valuesOf(head, "x-forwarded-for")).toEqual([PEER]);
    expect(valuesOf(head, "x-forwarded-proto")).toEqual(["https"]);
    expect(valuesOf(head, "x-forwarded-host")).toEqual(["fount.example"]);
    expect(valuesOf(head, "user-agent")).toEqual(["probe"]);
    expect(valuesOf(head, "accept")).toEqual(["*/*"]);
    expect(valuesOf(head, "host")).toEqual(["fount.example"]);
  });

  test("replaces the visitor's copies, whatever case they use", async () => {
    const head = headOf(
      await forward(
        Buffer.from(
          "GET / HTTP/1.1\r\nHost: a.example\r\nX-Forwarded-For: 6.6.6.6\r\nx-FORWARDED-for: 7.7.7.7\r\nX-Forwarded-Proto: http\r\nX-Forwarded-Host: evil.example\r\nAccept: */*\r\n\r\n",
          "latin1",
        ),
      ),
    );
    expect(valuesOf(head, "x-forwarded-for")).toEqual([PEER]);
    expect(valuesOf(head, "x-forwarded-proto")).toEqual(["https"]);
    expect(valuesOf(head, "x-forwarded-host")).toEqual(["a.example"]);
    expect(valuesOf(head, "accept")).toEqual(["*/*"]);
  });

  test("leaves the body and everything after the head untouched", async () => {
    const output = await forward(
      Buffer.from("POST /x HTTP/1.1\r\nHost: h\r\nContent-Length: 5\r\n\r\nabcde", "latin1"),
    );
    expect(valuesOf(headOf(output), "content-length")).toEqual(["5"]);
    expect(restOf(output).toString("latin1")).toBe("abcde");
  });

  test("rewrites an upgrade request without touching the frames behind it", async () => {
    const frames = [0x81, 0x85, 1, 2, 3, 4, 0xaa, 0xbb, 0xcc, 0xdd, 0xee];
    const output = await forward(
      Buffer.concat([
        Buffer.from("GET /ws HTTP/1.1\r\nHost: h\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n", "latin1"),
        Buffer.from(frames),
      ]),
    );
    expect(valuesOf(headOf(output), "x-forwarded-for")).toEqual([PEER]);
    expect([...restOf(output)]).toEqual(frames);
  });

  for (const [description, input] of Object.entries(opaque))
    test(`passes ${description} through byte for byte`, async () => {
      expect([...(await forward(input))]).toEqual([...input]);
    });

  test("rewrites across any chunk boundary", async () => {
    const input = Buffer.from("GET / HTTP/1.1\r\nHost: split.example\r\nAccept: */*\r\n\r\nBODY", "latin1");
    const output = await forward(input, PEER, 1);
    expect(valuesOf(headOf(output), "x-forwarded-host")).toEqual(["split.example"]);
    expect(valuesOf(headOf(output), "x-forwarded-for")).toEqual([PEER]);
    expect(restOf(output).toString("latin1")).toBe("BODY");
  });

  test("rewrites a head that arrives in many small chunks", async () => {
    const padding = "p".repeat(40 * 1024);
    const input = Buffer.from(`GET /big HTTP/1.1\r\nHost: big.example\r\nX-Pad: ${padding}\r\n\r\n`, "latin1");
    const output = await forward(input, PEER, 512);
    expect(valuesOf(headOf(output), "x-pad")).toEqual([padding]);
    expect(valuesOf(headOf(output), "x-forwarded-for")).toEqual([PEER]);
    expect(valuesOf(headOf(output), "x-forwarded-host")).toEqual(["big.example"]);
  });

  test("omits X-Forwarded-Host when the request has none", async () => {
    const head = headOf(await forward(Buffer.from("OPTIONS * HTTP/1.0\r\nAccept: */*\r\n\r\n", "latin1")));
    expect(requestLineOf(head)).toBe("OPTIONS * HTTP/1.0");
    expect(valuesOf(head, "x-forwarded-host")).toEqual([]);
    expect(valuesOf(head, "x-forwarded-for")).toEqual([PEER]);
  });

  test("keeps a peer address as it is", async () => {
    const head = headOf(await forward(Buffer.from("GET / HTTP/1.1\r\nHost: h\r\n\r\n", "latin1"), "2001:db8::1"));
    expect(valuesOf(head, "x-forwarded-for")).toEqual(["2001:db8::1"]);
  });

  test("cannot be made to add a header of its own", async () => {
    const head = headOf(
      await forward(Buffer.from("GET / HTTP/1.1\r\nHost: h\r\n\r\n", "latin1"), "1.2.3.4\r\nX-Evil: 1"),
    );
    expect(valuesOf(head, "x-evil")).toEqual([]);
    expect(headerLines(head).every((line) => line.includes(":"))).toBe(true);
  });

  test("keeps a header value that contains a colon", async () => {
    const head = headOf(
      await forward(Buffer.from("GET / HTTP/1.1\r\nHost: h\r\nReferer: https://x/y:8443/a\r\n\r\n", "latin1")),
    );
    expect(valuesOf(head, "referer")).toEqual(["https://x/y:8443/a"]);
  });
});
