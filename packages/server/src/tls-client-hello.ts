export interface ClientHello {
  readonly serverName: string;
  readonly alpn: string;
}

export type ClientHelloResult =
  | { readonly status: "incomplete" }
  | { readonly status: "invalid"; readonly reason: string }
  | { readonly status: "complete"; readonly value: ClientHello };

const uint16 = (data: Uint8Array, offset: number): number =>
  (data[offset]! << 8) | data[offset + 1]!;

const text = new TextDecoder();

export function parseClientHello(data: Uint8Array): ClientHelloResult {
  const handshake: number[] = [];
  let recordOffset = 0;
  let handshakeLength: number | undefined;

  while (recordOffset < data.length) {
    if (data.length - recordOffset < 5) return { status: "incomplete" };
    if (data[recordOffset] !== 0x16) {
      return { status: "invalid", reason: "expected TLS handshake record" };
    }

    const recordLength = uint16(data, recordOffset + 3);
    if (data.length - recordOffset - 5 < recordLength) {
      return { status: "incomplete" };
    }

    const start = recordOffset + 5;
    for (let index = 0; index < recordLength; index++) {
      handshake.push(data[start + index]!);
    }
    recordOffset = start + recordLength;

    if (handshake.length >= 4) {
      if (handshake[0] !== 0x01) {
        return { status: "invalid", reason: "expected TLS ClientHello" };
      }
      handshakeLength ??=
        (handshake[1]! << 16) | (handshake[2]! << 8) | handshake[3]!;
      if (handshake.length >= handshakeLength + 4) break;
    }
  }

  if (handshakeLength === undefined || handshake.length < handshakeLength + 4) {
    return { status: "incomplete" };
  }

  const hello = Uint8Array.from(handshake.slice(4, handshakeLength + 4));
  let offset = 0;

  if (hello.length < 35) return { status: "invalid", reason: "truncated ClientHello" };
  offset += 2 + 32;

  const sessionLength = hello[offset]!;
  offset += 1 + sessionLength;
  if (offset + 2 > hello.length) return { status: "invalid", reason: "invalid session" };

  const cipherLength = uint16(hello, offset);
  offset += 2 + cipherLength;
  if (offset >= hello.length) return { status: "invalid", reason: "invalid cipher suites" };

  const compressionLength = hello[offset]!;
  offset += 1 + compressionLength;
  if (offset === hello.length) return { status: "invalid", reason: "ClientHello has no SNI" };
  if (offset + 2 > hello.length) return { status: "invalid", reason: "invalid extensions" };

  const extensionsLength = uint16(hello, offset);
  offset += 2;
  const extensionsEnd = offset + extensionsLength;
  if (extensionsEnd > hello.length) return { status: "invalid", reason: "truncated extensions" };

  let serverName = "";
  let alpn = "";

  while (offset + 4 <= extensionsEnd) {
    const type = uint16(hello, offset);
    const length = uint16(hello, offset + 2);
    offset += 4;
    const end = offset + length;
    if (end > extensionsEnd) return { status: "invalid", reason: "truncated extension" };

    if (type === 0 && length >= 5) {
      const listEnd = Math.min(end, offset + 2 + uint16(hello, offset));
      let nameOffset = offset + 2;
      while (nameOffset + 3 <= listEnd) {
        const nameType = hello[nameOffset]!;
        const nameLength = uint16(hello, nameOffset + 1);
        nameOffset += 3;
        if (nameOffset + nameLength > listEnd) break;
        if (nameType === 0) {
          serverName = text.decode(hello.subarray(nameOffset, nameOffset + nameLength));
          break;
        }
        nameOffset += nameLength;
      }
    } else if (type === 16 && length >= 3) {
      const listEnd = Math.min(end, offset + 2 + uint16(hello, offset));
      const protocolLength = hello[offset + 2]!;
      if (offset + 3 + protocolLength <= listEnd) {
        alpn = text.decode(hello.subarray(offset + 3, offset + 3 + protocolLength));
      }
    }

    offset = end;
  }

  if (!serverName) return { status: "invalid", reason: "ClientHello has no SNI" };
  return { status: "complete", value: { serverName: serverName.toLowerCase(), alpn } };
}

export function concatBytes(chunks: ReadonlyArray<Uint8Array>, length?: number): Uint8Array {
  const size = length ?? chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
