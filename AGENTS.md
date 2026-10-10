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

- There are two client implementations: Rust (`crates/`) and the TypeScript SDK (`packages/client`). The SDK and `@opentunnel/protocol` publish only their built `dist` (JavaScript and declarations), never TypeScript sources, and take `effect` as a peer dependency.
- The CLI and background service are Rust (`crates/opentunnel-cli`). `packages/cli` only contains the npm launcher and the publish script that generates the per-platform packages.
- The CLI, the SDK (`@opentunnel/client`), `@opentunnel/protocol`, and the Rust crates always share one version: they are a changesets `fixed` group, and `packages/cli/script/version.ts` copies the version into Cargo.
- `docs/protocol.md` is the source of truth for the wire protocol and on-disk layout. Protocol changes must update the spec, `spec/vectors`, and both clients.
- Rust checks: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`.
- Rust uses the `ring` crypto provider everywhere; do not add dependencies that pull in `aws-lc-rs`, since it complicates cross-compiling.

## Hosted Service

- The hosted service is one Rust binary, `crates/opentunnel-server`, deployed to Fly.io by the root `Dockerfile` and `fly.toml` (app `opentunnel`, region `iad`, storage in PlanetScale MySQL through `DATABASE_URL`). `docs/server.md` describes it; `docs/cutover.md` is the runbook for moving off the Cloudflare Worker.
- It is not published and keeps its own version (`publish = false`), outside the release group.
- Keep runtime-neutral schemas, bridge framing, and HTTP contracts in `packages/protocol`; the server reuses the Rust wire types in `crates/opentunnel/src/protocol`.
- The HTTP API must answer exactly as `crates/opentunnel-server/tests/fixtures/worker-contract.json` records (paths, status codes, bodies, key order); installed clients depend on it.
- Never terminate tenant TLS in the server: only the API domain is terminated there, everything else is routed by SNI and passed through.
- Storage (`crates/opentunnel-server/src/store.rs`) must stay Vitess-compatible: every table has a primary key, no foreign keys, triggers or stored procedures, schema changes are idempotent `CREATE TABLE IF NOT EXISTS` migrations behind `SCHEMA_VERSION`, and nothing assumes a single writer (revisions on tunnel rows, conditional updates for alarms, leases on jobs).
- Server tests need MySQL 8: set `TEST_DATABASE_URL` (see `docs/server.md`); without it they skip.
- DNS stays on Cloudflare; DNS-01 challenges go through the provider in `crates/opentunnel-server/src/dns.rs`.
- `packages/website` is built with plain Vite (`bun run ready`, output `dist/website`) and served by the server.
- Code marked TEMPORARY (the `migration/` directory, `crates/opentunnel-server/src/migration.rs` apart from the export file format, and the `LEGACY_*` settings) exists only for the cutover and is removed once the Worker is decommissioned.
