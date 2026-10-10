import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Builds the website (index.html, packages/website) into dist/website, which the server
// (crates/opentunnel-server) serves as static files. `bun run dev` proxies the API to a local server
// started with `--http-mode serve` (see README.md).
export default defineConfig({
  publicDir: "packages/website/public",
  plugins: [react()],
  build: { outDir: "dist/website", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    port: 4190,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:8080", ws: true },
      "/health": "http://127.0.0.1:8080",
      "/openapi.json": "http://127.0.0.1:8080",
    },
  },
});
