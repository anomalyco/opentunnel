---
"@opentunnel/client": patch
"@opentunnel/protocol": patch
---

Publish compiled JavaScript with declarations, so the packages load on runtimes that refuse to strip TypeScript inside `node_modules` (Node, Deno) instead of only on Bun. The `exports` maps resolve to `dist` for every runtime except Bun, which keeps loading `src`.
