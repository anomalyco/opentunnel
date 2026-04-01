import "reflect-metadata";
import { Effect, Schema } from "effect";
import { describe, expect } from "vite-plus/test";
import { it } from "./effect-test.ts";
import { CSR } from "../src/csr.ts";

// Valid CSR PEM generated with OpenSSL:
// openssl req -new -newkey rsa:2048 -nodes -keyout test.key -out test.csr -subj "/CN=test.example.com"
const validCSR = `-----BEGIN CERTIFICATE REQUEST-----
MIICYDCCAUgCAQAwGzEZMBcGA1UEAwwQdGVzdC5leGFtcGxlLmNvbTCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBAKMYU27v3aIQV4dXN0Ax4wPyizkRS0Tw
zCGAb0OrKS/rfG7d59loFwQYn8k7TCR80vPrZ73DvF7w182bfDn8hT1+O05PQzbe
f9A+bLBPRQsguz3/0XVxHzkPKSUugFplF0gmtqJ5O7HR04U0RpzUQD4krKbexw3m
fnqOZqfuiIHVcdRV0wwmEogCDE7Aa9NqtyXsVe/58X8AYzZYxqxiDEpPLiZ5l9Y1
RR1vTX36WqHJiwm8RIeniyR9Iv8UlLSbAncjHKHCwgRiigOtTSTXzkn7znN5FMf5
OGaHZgp4GY+ZEHdYNW1ag7rJJvG6WYfmtLYIDQIMZ5AfQzaNXhtZX+8CAwEAAaAA
MA0GCSqGSIb3DQEBCwUAA4IBAQCFBvLmr0YnSUguzPi85Ljh5bK+LhETXUOGH8uM
HSuHeNM2+h6YrHOhe1LWPUyXWQFkjzIz8Qu4eHEeI+GkErUFl4NR9FICDGd13G1j
H819Wi8RncsrTP1mcaM2BViTSRyui2GIvGJ7/M4rN9/DdlNrCX3hKLblwYaiTlP7
KLTFCog07siVUDQHPzu+nK7EGW5G7Fx9t8r7ilRbZ1sMD+/qKnUfsTroNKtTeVvN
VcT6I9lzcFsesDvxI9ARtZquO3HWH4IbPVLBIav56wcJYcWwbTyK/JBiyMJi5zOg
HhWdylAY7gTilWU0aVTAkwXalzyO1k9V/pZreuP93rT6ugBp
-----END CERTIFICATE REQUEST-----` as CSR.Raw;

describe("CSR", () => {
  it.effect("parse should successfully extract hostname from valid CSR", () =>
    Effect.gen(function* () {
      const result = yield* CSR.parse(validCSR);
      expect(result.hostname).toBe("test.example.com");
      expect(result.raw).toBe(validCSR);
    }),
  );

  it.effect("parse should return ParseError for invalid PEM format", () =>
    CSR.parse("not a valid CSR" as CSR.Raw).pipe(
      Effect.flip,
      Effect.map((error) => expect(error._tag).toBe("ParseError")),
    ),
  );

  it.effect("parse should return ParseError for malformed CSR content", () =>
    CSR.parse(
      `-----BEGIN CERTIFICATE REQUEST-----
invalid-base64-content!!!
-----END CERTIFICATE REQUEST-----` as CSR.Raw,
    ).pipe(
      Effect.flip,
      Effect.map((error) => expect(error._tag).toBe("ParseError")),
    ),
  );

  it.effect("Raw schema should validate PEM string", () =>
    Effect.gen(function* () {
      const validPEM =
        "-----BEGIN CERTIFICATE REQUEST-----\ntest\n-----END CERTIFICATE REQUEST-----";
      const decoded = yield* Schema.decodeUnknownEffect(CSR.Raw)(validPEM);
      expect(decoded).toBe(validPEM);
    }),
  );

  it.effect("Info schema should validate CSR info structure", () =>
    Effect.gen(function* () {
      const parsed = yield* CSR.parse(validCSR);
      const decoded = yield* Schema.decodeUnknownEffect(CSR.Info)({
        hostname: parsed.hostname,
        raw: parsed.raw,
        certificate: parsed.certificate,
      });
      expect(decoded.hostname).toBe("test.example.com");
      expect(decoded.raw).toBe(validCSR);
    }),
  );
});
