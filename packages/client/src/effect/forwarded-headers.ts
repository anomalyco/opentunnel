import { Transform, type TransformCallback } from "node:stream";

/**
 * Headers the tunnel owns once forwarding is on. A value the visitor sent is
 * dropped rather than appended to, so an application can trust what it reads
 * without having to know how many proxies to skip.
 */
const MANAGED_HEADERS = ["x-forwarded-for", "x-forwarded-proto", "x-forwarded-host"];

/** A request line is `METHOD target HTTP/1.x`; no other opening is rewritten. */
const REQUEST_LINE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+ \S+ HTTP\/1\.[01]\r\n$/;

/** HTTP methods are uppercase; a first byte outside `A-Z` cannot begin a request. */
const METHOD_START = /[A-Z]/;

/** No server accepts a request line anywhere near this long. */
const MAX_REQUEST_LINE_BYTES = 8 * 1024;

/** Past this the head is not worth parsing, and is forwarded untouched. */
const MAX_HEAD_BYTES = 64 * 1024;

const CRLF = Buffer.from("\r\n");
const HEAD_END = Buffer.from("\r\n\r\n");

/** A value we inline must not be able to add a header of its own. */
const sanitizeValue = (value: string) => value.replaceAll(/[\r\n]/g, "").trim();

/** `peer` is a remote address; keep address characters and drop anything else. */
const sanitizePeer = (peer: string) => {
  const address = sanitizeValue(peer).replaceAll(/[^0-9A-Za-z:.\[\]-]/g, "");
  return address === "" ? "unknown" : address;
};

/**
 * Rewrites the head of one public request, replacing the managed headers with
 * the values the tunnel observed.
 *
 * Returns `undefined` when the bytes are not a complete HTTP/1.x request head,
 * so the caller forwards them byte-for-byte instead.
 *
 * @param head The request head, from the first byte through the last header,
 *   without the blank line that terminates it.
 * @param peer The address the relay observed for this connection.
 */
export const rewriteHead = (head: Buffer, peer: string): Buffer | undefined => {
  const text = head.toString("latin1");
  const requestLineEnd = text.indexOf("\r\n");
  if (requestLineEnd === -1) return undefined;
  if (!REQUEST_LINE.test(`${text.slice(0, requestLineEnd)}\r\n`)) return undefined;

  const kept: string[] = [];
  let host: string | undefined;
  for (const line of text.slice(requestLineEnd + 2).split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) {
      kept.push(line);
      continue;
    }
    const name = line.slice(0, separator).trim().toLowerCase();
    if (MANAGED_HEADERS.includes(name)) continue;
    if (name === "host" && host === undefined) host = sanitizeValue(line.slice(separator + 1));
    kept.push(line);
  }

  const forwarded = [
    `x-forwarded-for: ${sanitizePeer(peer)}`,
    "x-forwarded-proto: https",
    ...(host ? [`x-forwarded-host: ${host}`] : []),
  ];
  const headLines = [text.slice(0, requestLineEnd), ...kept, ...forwarded];
  return Buffer.from(`${headLines.join("\r\n")}\r\n\r\n`, "latin1");
};

/**
 * Adds the forwarding headers to the start of the public-to-local direction of
 * a connection, then passes every later byte through untouched.
 *
 * Anything it cannot recognize as an HTTP/1.x request is forwarded byte-for-byte
 * from the byte that ruled it out — a nested TLS session, an SSH banner, or a
 * cleartext HTTP/2 preface is not held back waiting for a head that never comes.
 */
export class ForwardedHeaders extends Transform {
  private readonly peer: string;
  /** The head so far; grown by doubling, of which `bufferedLength` bytes are used. */
  private buffered = Buffer.alloc(0);
  private bufferedLength = 0;
  private settled = false;
  /** `"request-line"` until the opening line is recognized, then `"head"`. */
  private stage: "request-line" | "head" = "request-line";

  constructor(peer: string) {
    super();
    this.peer = peer;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (this.settled) {
      this.push(chunk);
      callback();
      return;
    }
    const buffered = this.append(chunk);

    if (this.stage === "request-line") {
      if (buffered.length > 0 && !METHOD_START.test(String.fromCharCode(buffered[0]))) {
        this.settle([buffered]);
        callback();
        return;
      }
      const lineEnd = buffered.indexOf(CRLF);
      if (lineEnd === -1) {
        if (buffered.length > MAX_REQUEST_LINE_BYTES) this.settle([buffered]);
        callback();
        return;
      }
      if (!REQUEST_LINE.test(buffered.subarray(0, lineEnd + 2).toString("latin1"))) {
        this.settle([buffered]);
        callback();
        return;
      }
      this.stage = "head";
    }

    const headEnd = buffered.indexOf(HEAD_END);
    if (headEnd === -1) {
      if (buffered.length > MAX_HEAD_BYTES) this.settle([buffered]);
      callback();
      return;
    }
    const rewritten = rewriteHead(buffered.subarray(0, headEnd), this.peer);
    // The request line matched, so this only fails on a head we cannot rebuild.
    if (rewritten === undefined) this.settle([buffered]);
    else this.settle([rewritten, buffered.subarray(headEnd + HEAD_END.length)]);
    callback();
  }

  override _flush(callback: TransformCallback): void {
    if (!this.settled && this.bufferedLength > 0) this.push(this.buffered.subarray(0, this.bufferedLength));
    callback();
  }

  /**
   * Appends a chunk to the head and returns the head so far.
   *
   * The buffer doubles rather than being rebuilt per chunk, so a head that
   * arrives in many small chunks is not copied once per chunk.
   *
   * @param chunk The bytes that arrived.
   * @returns The head so far, as a view of the growing buffer.
   */
  private append(chunk: Buffer): Buffer {
    const needed = this.bufferedLength + chunk.length;
    if (needed > this.buffered.length) {
      const grown = Buffer.allocUnsafe(Math.max(needed, this.buffered.length * 2));
      this.buffered.copy(grown, 0, 0, this.bufferedLength);
      this.buffered = grown;
    }
    chunk.copy(this.buffered, this.bufferedLength);
    this.bufferedLength = needed;
    return this.buffered.subarray(0, this.bufferedLength);
  }

  /**
   * Stops buffering and writes `chunks` out in order.
   *
   * @param chunks The bytes to forward, in the order they must be written.
   */
  private settle(chunks: ReadonlyArray<Uint8Array>): void {
    this.settled = true;
    this.bufferedLength = 0;
    for (const chunk of chunks) this.push(chunk);
  }
}
