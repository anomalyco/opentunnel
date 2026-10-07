import "reflect-metadata";
import { describe, expect, test } from "bun:test";
import { Pkcs10CertificateRequest, SubjectAlternativeNameExtension } from "@peculiar/x509";
import { certificateRequest } from "../src/effect/csr.js";

const keys = () =>
  crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;

describe("certificate request", () => {
  // Long enough that the request, the info, and the SAN extension all need long-form DER lengths.
  for (const hostname of ["lwoyjcaeyxv6.opentunnel.xyz", `${"a".repeat(60)}.${"b".repeat(60)}.opentunnel.xyz`]) {
    test(`parses and verifies for ${hostname.length}-character hostnames`, async () => {
      // Many keys, so signatures with high bits and leading zeros in r and s are covered.
      for (let i = 0; i < 25; i++) {
        const pair = await keys();
        const pem = await certificateRequest(hostname, pair);
        const request = new Pkcs10CertificateRequest(pem);
        expect(await request.verify()).toBe(true);
        // Read the way the server's bindCertificate reads it.
        expect(String(request.subjectName.getField("CN"))).toBe(hostname);
        const extension = request.extensions.find((candidate) => candidate.type === "2.5.29.17");
        const names = new SubjectAlternativeNameExtension(extension!.rawData).names.items
          .filter((name) => name.type === "dns")
          .map((name) => name.value);
        expect(names).toEqual([hostname, `*.${hostname}`]);
        const expected = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
        expect(new Uint8Array(request.publicKey.rawData)).toEqual(expected);
      }
    });
  }

  test("is accepted by openssl", async () => {
    const pem = await certificateRequest("lwoyjcaeyxv6.opentunnel.xyz", await keys());
    const openssl = Bun.spawnSync(["openssl", "req", "-noout", "-verify", "-text"], { stdin: Buffer.from(pem) });
    if (openssl.exitCode === null) return;
    const output = `${openssl.stdout}${openssl.stderr}`;
    expect(openssl.exitCode).toBe(0);
    expect(output).toContain("DNS:lwoyjcaeyxv6.opentunnel.xyz, DNS:*.lwoyjcaeyxv6.opentunnel.xyz");
    expect(output).toContain("ecdsa-with-SHA256");
  });
});
