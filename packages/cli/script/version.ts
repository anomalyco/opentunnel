#!/usr/bin/env bun
// Runs after `changeset version`: the crates take the CLI's npm version, so crates.io, npm, and the binaries
// always ship the same number. Updates the workspace version, the CLI's dependency on the library, and the
// lockfile entries for both crates.

import pkg from "../package.json"

const root = new URL("../../../", import.meta.url)
const version = pkg.version

async function rewrite(path: string, edit: (text: string) => string) {
  const file = Bun.file(new URL(path, root))
  const before = await file.text()
  const after = edit(before)
  if (after === before) return
  await Bun.write(file, after)
  console.log(`${path} → ${version}`)
}

await rewrite("Cargo.toml", (text) =>
  text.replace(/(\[workspace\.package\][^[]*?\nversion = ")[^"]+"/, `$1${version}"`),
)
await rewrite("crates/opentunnel-cli/Cargo.toml", (text) =>
  text.replace(/(opentunnel = \{ version = ")[^"]+"/, `$1${version}"`),
)
await rewrite("Cargo.lock", (text) =>
  text.replace(/(name = "opentunnel(?:-cli)?"\nversion = ")[^"]+"/g, `$1${version}"`),
)
