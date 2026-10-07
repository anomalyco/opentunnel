// A PKCS#10 certificate request for a tunnel: CN and SANs for the hostname and its wildcard, signed with the
// tunnel's P-256 key. Encoded here with WebCrypto rather than an X.509 library, so the SDK carries no ASN.1
// dependency whose schema registry can be split across duplicate installs in a consumer's tree.

const der = (tag: number, ...contents: Uint8Array[]) => {
  const body = concat(contents);
  const length =
    body.length < 0x80
      ? [body.length]
      : (() => {
          const bytes: number[] = [];
          for (let n = body.length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
          return [0x80 | bytes.length, ...bytes];
        })();
  return concat([new Uint8Array([tag, ...length]), body]);
};

const concat = (parts: readonly Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const sequence = (...contents: Uint8Array[]) => der(0x30, ...contents);
const set = (...contents: Uint8Array[]) => der(0x31, ...contents);
const utf8 = (value: string) => der(0x0c, new TextEncoder().encode(value));
const dnsName = (value: string) => der(0x82, new TextEncoder().encode(value));

const oid = (dotted: string) => {
  const [first, second, ...rest] = dotted.split(".").map(Number);
  const bytes = [first! * 40 + second!];
  for (const arc of rest) {
    const encoded = [arc & 0x7f];
    for (let n = arc >> 7; n > 0; n >>= 7) encoded.unshift((n & 0x7f) | 0x80);
    bytes.push(...encoded);
  }
  return der(0x06, new Uint8Array(bytes));
};

/** A DER INTEGER from unsigned big-endian bytes: leading zeros dropped, a zero prepended if the top bit is set. */
const integer = (bytes: Uint8Array) => {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const trimmed = bytes.subarray(start);
  return der(0x02, trimmed[0]! & 0x80 ? concat([new Uint8Array([0]), trimmed]) : trimmed);
};

const COMMON_NAME = "2.5.4.3";
const EXTENSION_REQUEST = "1.2.840.113549.1.9.14";
const SUBJECT_ALT_NAME = "2.5.29.17";
const ECDSA_WITH_SHA256 = "1.2.840.10045.4.3.2";

export async function certificateRequest(hostname: string, keys: CryptoKeyPair): Promise<string> {
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey));
  const info = sequence(
    der(0x02, new Uint8Array([0])),
    sequence(set(sequence(oid(COMMON_NAME), utf8(hostname)))),
    publicKey,
    der(
      0xa0,
      sequence(
        oid(EXTENSION_REQUEST),
        set(
          sequence(
            sequence(oid(SUBJECT_ALT_NAME), der(0x04, sequence(dnsName(hostname), dnsName(`*.${hostname}`)))),
          ),
        ),
      ),
    ),
  );
  // WebCrypto signs ECDSA as r‖s; X.509 wants SEQUENCE { r INTEGER, s INTEGER }.
  const raw = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, info),
  );
  const signature = sequence(integer(raw.subarray(0, 32)), integer(raw.subarray(32)));
  const request = sequence(info, sequence(oid(ECDSA_WITH_SHA256)), der(0x03, new Uint8Array([0]), signature));
  const base64 = Buffer.from(request)
    .toString("base64")
    .replace(/.{1,64}/g, "$&\n");
  return `-----BEGIN CERTIFICATE REQUEST-----\n${base64}-----END CERTIFICATE REQUEST-----`;
}
