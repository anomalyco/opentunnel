- This codebase uses Effect v4 which is not yet documented yet
- Do not rely on your own knowledge of Effect (e.g. don't use `Effect.gen` if the codebase uses a different pattern found in effect-smol)
- When working on Effect-related code, use the explore agent to scan ~/dev/external/effect-smol
- Use the explore agent to find relevant patterns, types, and implementations in the Effect codebase (e.g. search for similar services, layers, or effect composition patterns)
- Copy and adapt patterns found in the external repository rather than using what you know about Effect v3 or earlier versions (e.g. use the type signatures and helper functions found in effect-smol, not what you remember from Effect v3 docs)
- Always verify your implementation against the patterns found in the effect-smol repository (e.g. compare your service definition to similar ones in the external repo)
- `bunfig.toml` enables exact dependency versions.
- Run commands in the most granular package you are testing, not at the root (e.g. `cd packages/protocol && bun run build` instead of `bun run ready` from the root).
- Common commands: `bun run build` (build for production), `bun run test` (run tests).

## Cloudflare Runtime

- The hosted application is `packages/server`.
- It is one Wrangler Worker containing HTTP handlers, inbound TCP, Durable Objects, and a certificate Workflow.
- Keep runtime-neutral schemas, bridge framing, and HTTP contracts in `packages/protocol`.
- Keep API handlers, TLS parsing, Durable Objects, and Workflows in `packages/server`.
- Spectrum must use TLS passthrough; never move tenant TLS termination into the Worker.
- Run `bun run cf-typegen` after changing Wrangler bindings.
- Use `bun run build` in `packages/server` to typecheck the Worker and run a Wrangler dry-run bundle.
