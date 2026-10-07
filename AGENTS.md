- This codebase uses Effect v4 which is not yet documented yet
- Do not rely on your own knowledge of Effect (e.g. don't use `Effect.gen` if the codebase uses a different pattern found in effect-smol)
- When working on Effect-related code, use the explore agent to scan ~/dev/external/effect-smol
- Use the explore agent to find relevant patterns, types, and implementations in the Effect codebase (e.g. search for similar services, layers, or effect composition patterns)
- Copy and adapt patterns found in the external repository rather than using what you know about Effect v3 or earlier versions (e.g. use the type signatures and helper functions found in effect-smol, not what you remember from Effect v3 docs)
- Always verify your implementation against the patterns found in the effect-smol repository (e.g. compare your service definition to similar ones in the external repo)
- `bunfig.toml` enables exact dependency versions.
- Run commands in the most granular package you are testing, not at the root (e.g. `cd packages/protocol && bun run build` instead of `bun run ready` from the root).
- Common commands: `bun run build` (build for production), `bun run test` (run tests).

## Clients

- There are two client implementations: Rust (`crates/`) and the TypeScript SDK (`packages/client`, Bun only).
- The CLI and background service are Rust (`crates/opentunnel-cli`). `packages/cli` only contains the npm launcher and the publish script that generates the per-platform packages.
- `docs/protocol.md` is the source of truth for the wire protocol and on-disk layout. Protocol changes must update the spec, `spec/vectors`, and both clients.
- Rust checks: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`.
- Rust uses the `ring` crypto provider everywhere; do not add dependencies that pull in `aws-lc-rs`, since it complicates cross-compiling.

## Cloudflare Runtime

- The hosted application is one Worker, configured by the root `cloudflare.config.ts` and built by the root `vite.config.ts` (Cloudflare Vite plugin): `packages/server` is its code (HTTP handlers, inbound TCP, Durable Objects, a certificate Workflow) and `packages/website` its static assets.
- Keep runtime-neutral schemas, bridge framing, and HTTP contracts in `packages/protocol`.
- Keep API handlers, TLS parsing, Durable Objects, and Workflows in `packages/server`.
- Spectrum must use TLS passthrough; never move tenant TLS termination into the Worker.
- `cloudflare.config.ts` switches on `mode`, and every resource is named `<name>-<mode>`; production is `--mode production`. It loads with Node 22.18 or later, not Bun.
- Run `bun run types` at the root after changing bindings.
- `bun run ready` at the root builds everything; `bun run deploy --mode <mode>` deploys that build.
