#!/usr/bin/env bun
// Publishes @opentunnel/protocol and @opentunnel/client from their built `dist` (run `bun run ready`
// first). `bun pm pack` replaces workspace and catalog versions with real ones before npm publishes the
// tarball.

import { $ } from "bun"
import { rm } from "fs/promises"
import { tmpdir } from "os"
import { fileURLToPath } from "url"

const root = fileURLToPath(new URL("../../..", import.meta.url))

for (const dir of ["packages/protocol", "packages/client"]) {
  const cwd = `${root}/${dir}`
  const pkg = await Bun.file(`${cwd}/package.json`).json()
  if ((await $`npm view ${pkg.name}@${pkg.version} version`.nothrow().quiet()).exitCode === 0) {
    console.log(`already published ${pkg.name}@${pkg.version}`)
    continue
  }
  const tarball = `${tmpdir()}/${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`
  await $`bun pm pack --filename ${tarball}`.cwd(cwd)
  try {
    // `bun pm pack` fills in workspace versions from bun.lock; a stale lockfile once shipped the client
    // depending on protocol 0.0.0. Refuse to publish unless they match the packages being released.
    const packed = JSON.parse(await $`tar -xzOf ${tarball} package/package.json`.text())
    // Only compiled JavaScript and declarations ship, and every export has to resolve to a packed file.
    const files = new Set((await $`tar -tzf ${tarball}`.text()).split("\n").filter(Boolean).map((file) => file.replace(/^package\//, "")))
    const sources = [...files].filter((file) => /\.(c|m)?tsx?$/.test(file) && !/\.d\.(c|m)?ts$/.test(file))
    if (sources.length > 0) throw new Error(`${pkg.name} would publish TypeScript sources: ${sources.join(", ")}`)
    const targets = (value: unknown): string[] =>
      typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(targets) : []
    const missing = targets(packed.exports).map((target) => target.replace(/^\.\//, "")).filter((target) => !files.has(target))
    if (missing.length > 0) throw new Error(`${pkg.name} exports files it doesn't pack (run the build first): ${missing.join(", ")}`)
    // Effect is a peer, so apps that use it share one copy; the range must cover the version we build with.
    const effect = (await Bun.file(`${root}/package.json`).json()).workspaces.catalog.effect
    const range = packed.peerDependencies?.effect
    if (!range || !Bun.semver.satisfies(effect, range)) throw new Error(`${pkg.name}'s effect peer range ${range} doesn't cover ${effect}`)
    for (const [name, range] of Object.entries<string>(packed.dependencies ?? {})) {
      if (!name.startsWith("@opentunnel/")) continue
      const local = await Bun.file(`${root}/packages/${name.slice("@opentunnel/".length)}/package.json`).json()
      if (range !== local.version) throw new Error(`${pkg.name} would publish depending on ${name}@${range}, not ${local.version}`)
    }
    await $`npm publish ${tarball} --access public`.cwd(cwd)
  } finally {
    await rm(tarball, { force: true })
  }
}
