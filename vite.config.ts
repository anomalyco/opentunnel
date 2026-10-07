import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Builds the one opentunnel Worker described by cloudflare.config.ts, which the plugin reads from this, the
// Vite root: the website (index.html, packages/website) is the client build and becomes the Worker's static
// assets, and packages/server is the Worker.
export default defineConfig({
  publicDir: "packages/website/public",
  plugins: [react(), cloudflare()],
  resolve: { alias: { "@peculiar/acme-client": "@peculiar/acme-client/build/es2015/index.js" } },
  server: { host: "127.0.0.1", port: 4190, strictPort: true },
});
