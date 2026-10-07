import { defineConfig, triggers } from "cf/config"

// One Worker per mode, named after it: `cf deploy --mode production` serves opentunnel.xyz; any other mode
// (`cf deploy --mode dev`) is a separate Worker on workers.dev. Builds default to production, as in Vite.
export default defineConfig(({ mode = "production" }) => {
  const production = mode === "production"
  return {
    worker: {
      name: `opentunnel-website-${mode}`,
      compatibilityDate: "2026-08-08",
      workersDev: !production,
      triggers: production ? [triggers.fetch({ pattern: "opentunnel.xyz/*", zone: "opentunnel.xyz" })] : [],
    },
  }
})
