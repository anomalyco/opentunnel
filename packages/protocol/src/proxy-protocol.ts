export * as ProxyProtocol from "./proxy-protocol.js";

/**
 * The PROXY protocol preamble a route can send to its target. See
 * `docs/protocol.md` and https://www.haproxy.org/download/2.9/doc/proxy-protocol.txt.
 */

export type Version = "v1" | "v2";

export const VERSIONS: ReadonlyArray<Version> = ["v1", "v2"];

export const isVersion = (value: unknown): value is Version => value === "v1" || value === "v2";

/** The public port every visitor connected to. */
export const PUBLIC_PORT = 443;

/** The 12-byte signature that starts every v2 header. */
export const V2_SIGNATURE = Uint8Array.of(0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a);

const V2_PROXY = 0x21;
const V2_LOCAL = 0x20;
const V2_TCP4 = 0x11;
const V2_TCP6 = 0x21;
const V2_UNSPEC = 0x00;
const PP2_TYPE_AUTHORITY = 0x02;

export type Address =
  | { readonly family: 4; readonly bytes: Uint8Array; readonly port: number }
  | { readonly family: 6; readonly bytes: Uint8Array; readonly port: number };

const parseIpv4 = (value: string): Uint8Array | undefined => {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  const bytes = new Uint8Array(4);
  for (const [index, part] of parts.entries()) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    bytes[index] = octet;
  }
  return bytes;
};

const parseGroups = (value: string, allowIpv4: boolean): number[] | undefined => {
  if (value === "") return [];
  const groups: number[] = [];
  const parts = value.split(":");
  for (const [index, part] of parts.entries()) {
    if (allowIpv4 && index === parts.length - 1 && part.includes(".")) {
      const ipv4 = parseIpv4(part);
      if (!ipv4) return undefined;
      groups.push((ipv4[0]! << 8) | ipv4[1]!, (ipv4[2]! << 8) | ipv4[3]!);
      continue;
    }
    if (!/^[0-9A-Fa-f]{1,4}$/.test(part)) return undefined;
    groups.push(Number.parseInt(part, 16));
  }
  return groups;
};

const parseIpv6 = (value: string): Uint8Array | undefined => {
  const gap = value.indexOf("::");
  let groups: number[] | undefined;
  if (gap === -1) {
    groups = parseGroups(value, true);
    if (groups?.length !== 8) return undefined;
  } else {
    if (value.indexOf("::", gap + 1) !== -1) return undefined;
    const head = parseGroups(value.slice(0, gap), false);
    const tail = parseGroups(value.slice(gap + 2), true);
    // `::` stands for at least one zero group.
    if (!head || !tail || head.length + tail.length > 7) return undefined;
    groups = [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
  }
  const bytes = new Uint8Array(16);
  for (const [index, group] of groups.entries()) {
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  }
  return bytes;
};

const parsePort = (value: string): number | undefined => {
  if (!/^[0-9]{1,5}$/.test(value)) return undefined;
  const port = Number(value);
  return port <= 65535 ? port : undefined;
};

const isIpv4Mapped = (bytes: Uint8Array) =>
  bytes.subarray(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;

const address = (bytes: Uint8Array, port: number): Address =>
  bytes.length === 16 && isIpv4Mapped(bytes)
    ? { family: 4, bytes: bytes.slice(12), port }
    : bytes.length === 4
      ? { family: 4, bytes, port }
      : { family: 6, bytes, port };

/**
 * Parses the `peer` of an `open` frame: `ipv4:port`, `[ipv6]:port`, or a bare
 * address (port 0). IPv4-mapped IPv6 addresses become IPv4.
 */
export const parsePeer = (peer: string): Address | undefined => {
  const bare = parseIpv4(peer) ?? parseIpv6(peer);
  if (bare) return address(bare, 0);
  if (peer.startsWith("[")) {
    const close = peer.indexOf("]:");
    if (close === -1) return undefined;
    const bytes = parseIpv6(peer.slice(1, close));
    const port = parsePort(peer.slice(close + 2));
    return bytes && port !== undefined ? address(bytes, port) : undefined;
  }
  const separator = peer.lastIndexOf(":");
  if (separator === -1) return undefined;
  const bytes = parseIpv4(peer.slice(0, separator));
  const port = parsePort(peer.slice(separator + 1));
  return bytes && port !== undefined ? address(bytes, port) : undefined;
};

/** Formats an address in the text form PROXY v1 uses (RFC 5952 for IPv6). */
export const formatAddress = (value: Address): string => {
  if (value.family === 4) return [...value.bytes].join(".");
  const groups = Array.from({ length: 8 }, (_, index) => (value.bytes[index * 2]! << 8) | value.bytes[index * 2 + 1]!);
  // Compress the first longest run of two or more zero groups.
  let bestStart = -1;
  let bestLength = 1;
  for (let start = 0; start < 8; ) {
    if (groups[start] !== 0) {
      start++;
      continue;
    }
    let end = start;
    while (end < 8 && groups[end] === 0) end++;
    if (end - start > bestLength) {
      bestStart = start;
      bestLength = end - start;
    }
    start = end;
  }
  const hex = (list: number[]) => list.map((group) => group.toString(16)).join(":");
  if (bestStart === -1) return hex(groups);
  return `${hex(groups.slice(0, bestStart))}::${hex(groups.slice(bestStart + bestLength))}`;
};

const encoder = new TextEncoder();

/**
 * The header to write to a route target before any payload. The source is the
 * visitor (`peer`); the destination is the unspecified address of the same
 * family on port 443. v2 carries `sni` in a `PP2_TYPE_AUTHORITY` TLV.
 */
export const header = (version: Version, peer: string, sni: string): Uint8Array => {
  const source = parsePeer(peer);
  return version === "v1" ? v1(source) : v2(source, sni);
};

const v1 = (source: Address | undefined): Uint8Array => {
  if (!source) return encoder.encode("PROXY UNKNOWN\r\n");
  const [protocol, destination] = source.family === 4 ? ["TCP4", "0.0.0.0"] : ["TCP6", "::"];
  return encoder.encode(`PROXY ${protocol} ${formatAddress(source)} ${destination} ${source.port} ${PUBLIC_PORT}\r\n`);
};

const v2 = (source: Address | undefined, sni: string): Uint8Array => {
  const authority = encoder.encode(sni);
  // A TLS server name is at most 255 bytes; anything longer is not one.
  const tlv = authority.length > 0 && authority.length <= 255 ? 3 + authority.length : 0;
  const addresses = source === undefined ? 0 : source.family === 4 ? 12 : 36;
  const length = addresses + tlv;
  const out = new Uint8Array(16 + length);
  const view = new DataView(out.buffer);
  out.set(V2_SIGNATURE, 0);
  out[12] = source ? V2_PROXY : V2_LOCAL;
  out[13] = source === undefined ? V2_UNSPEC : source.family === 4 ? V2_TCP4 : V2_TCP6;
  view.setUint16(14, length);
  let offset = 16;
  if (source) {
    const size = source.bytes.length;
    out.set(source.bytes, offset);
    // The destination is the unspecified address: already zero.
    offset += size * 2;
    view.setUint16(offset, source.port);
    view.setUint16(offset + 2, PUBLIC_PORT);
    offset += 4;
  }
  if (tlv > 0) {
    out[offset] = PP2_TYPE_AUTHORITY;
    view.setUint16(offset + 1, authority.length);
    out.set(authority, offset + 3);
  }
  return out;
};
