import "reflect-metadata";
import { Effect, Schema } from "effect";
import { Pkcs10CertificateRequest } from "@peculiar/x509";
export namespace CSR {
  export class ParseError extends Schema.TaggedErrorClass()("ParseError", {
    message: Schema.String,
    cause: Schema.Defect,
  }) {}

  export const Raw = Schema.String.pipe(Schema.brand("CSR.Raw"));
  export type Raw = Schema.Schema.Type<typeof Raw>;

  export const Hostname = Schema.String.pipe(Schema.brand("Hostname"));
  export type Hostname = Schema.Schema.Type<typeof Hostname>;

  export class Info extends Schema.Class<Info>("CSR/Info")({
    hostname: CSR.Hostname,
    raw: Raw,
    certificate: Schema.declare<Pkcs10CertificateRequest>(
      (_): _ is Pkcs10CertificateRequest => true,
      { identifier: "Pkcs10CertificateRequest" },
    ),
  }) {}

  export const parse = Effect.fn(function* (csr: Raw) {
    // Step 1: Parse CSR from PEM (native PEM support)
    const req = yield* Effect.try({
      try: () => new Pkcs10CertificateRequest(csr),
      catch: (error) =>
        new ParseError({
          message: `Failed to parse CSR`,
          cause: error,
        }),
    });

    // Step 2: Extract Common Name from Subject
    const cn = req.subjectName.getField("CN");

    return {
      hostname: String(cn),
      certificate: req,
      raw: csr,
    } as Info;
  });
}
