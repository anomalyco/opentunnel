---
"@opentunnel/client": patch
---

Fix installing the SDK: 0.1.0 was published depending on `@opentunnel/protocol@0.0.0`. Certificate requests are now encoded with WebCrypto, so the SDK no longer depends on `@peculiar/x509` or `reflect-metadata`, and duplicate `@peculiar/asn1-schema` copies in your tree can no longer break tunnel creation.
