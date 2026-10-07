import { bindings, defineConfig, defineWorker, exports, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// One Worker per mode, every resource suffixed with it: `cf deploy --mode production` is opentunnel.xyz;
// any other mode (`cf deploy --mode dev`) is a separate Worker, with its own Durable Objects and Workflow,
// on workers.dev. Deploying without --mode deploys `development`, never production.
export default defineConfig(({ mode = "development" }) => {
  const production = mode === "production";
  const name = `opentunnel-${mode}`;
  const domain = production ? "opentunnel.xyz" : `${mode}.opentunnel.xyz`;
  const certificates = `opentunnel-certificates-${mode}`;
  // This Worker, for the bindings to its own classes: referencing the definition rather than the name types them.
  const self = defineWorker({
    name,
    compatibilityDate: "2026-08-08",
    entrypoint,
    exports: {
      TunnelObject: exports.durableObject({ storage: "sqlite" }),
      CertificateWorkflow: exports.workflow({ name: certificates }),
    },
  });
  return {
    worker: {
      ...self,
      compatibilityFlags: ["nodejs_compat"],
      workersDev: !production,
      observability: { enabled: true },
      triggers: production ? [triggers.fetch({ pattern: "opentunnel.xyz/api/*", zone: "opentunnel.xyz" })] : [],
      env: {
        OPENTUNNEL_DOMAIN: bindings.text(domain),
        ACME_URL: bindings.text("https://acme.zerossl.com/v2/DV90"),
        ACME_EMAIL: bindings.text("acme@opentunnel.xyz"),
        ACME_DNS_PROPAGATION_TIMEOUT_MS: bindings.text("10000"),
        CLOUDFLARE_ZONE_ID: bindings.text("43d8e5cf1c0ccc8c3868125be74a5e68"),
        ACME_EAB_KID: bindings.secret(),
        ACME_EAB_HMAC_KEY: bindings.secret(),
        ACME_ACCOUNT_KEY_JWK: bindings.secret(),
        CLOUDFLARE_API_TOKEN: bindings.secret(),
        RELAY_TOKEN: bindings.secret(),
        TUNNELS: bindings.durableObject({ worker: self, exportName: "TunnelObject" }),
        CERTIFICATES: bindings.workflow({ name: certificates, worker: self, exportName: "CertificateWorkflow" }),
      },
    },
  };
});
