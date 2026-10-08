---
"@opentunnel/client": minor
"@opentunnel/protocol": minor
---

Publish compiled JavaScript with type declarations instead of TypeScript sources, so the SDK runs on Node and Deno as well as Bun. The SDK now targets Effect 4.0 stable, and `effect` is a peer dependency (`^4.0.0`): apps that already use Effect share one copy with the SDK, and package managers install it automatically for everyone else.
