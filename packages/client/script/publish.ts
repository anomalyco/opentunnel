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
    await $`npm publish ${tarball} --access public`.cwd(cwd)
  } finally {
    await rm(tarball, { force: true })
  }
}
