import { bindings, defineConfig, defineWorker, exports, triggers } from "cf/config";
import * as entrypoint from "./packages/server/src/index.ts" with { type: "cf-worker" };

// opentunnel is one Worker: the relay's API under /api/* and the website (the Vite build of packages/website)
// as static assets for everything else. One Worker per mode, every resource suffixed with it:
// `cf deploy --mode production` is opentunnel.xyz; any other mode (`cf deploy --mode dev`) is a separate
// Worker, with its own Durable Objects and Workflow, on workers.dev.
export default defineConfig(({ mode = "production" }) => {
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
      // TEMPORARY (migration to the Fly server, docs/cutover.md): production also answers on workers.dev, so
      // the new server can reach the export endpoint and /api/relay once opentunnel.xyz points at it.
      workersDev: true,
      observability: { enabled: true },
      assets: { runWorkerFirst: ["/api/*"] },
      triggers: production ? [triggers.fetch({ pattern: "opentunnel.xyz/*", zone: "opentunnel.xyz" })] : [],
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
        // TEMPORARY (migration): bearer secret for /api/admin/export and /api/admin/handoff.
        ADMIN_EXPORT_TOKEN: bindings.secret(),
        // Anomaly's platform event stream, platform_<stack>_event (anomaly/platform src/lake), by stream ID.
        EVENTS: bindings.pipeline({
          name: production ? "251a89241c3a461c9007f6b6f345ed8b" : "04809367dc154b469b80b054cc6afa6e",
        }),
        TUNNELS: bindings.durableObject({ worker: self, exportName: "TunnelObject" }),
        CERTIFICATES: bindings.workflow({ name: certificates, worker: self, exportName: "CertificateWorkflow" }),
      },
    },
  };
});
