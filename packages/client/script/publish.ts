#!/usr/bin/env bun
// Publishes @opentunnel/protocol and @opentunnel/client. `bun pm pack` replaces
// workspace and catalog versions with real ones before npm publishes the tarball.

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
