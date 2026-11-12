#!/usr/bin/env bun
// Publishes the per-platform binary packages from dist/cli-<os>-<arch>/bin/opentunnel
// (placed there by CI), then the `opentunnel` launcher that depends on them.

import { $ } from "bun"
import { fileURLToPath } from "url"
import pkg from "../package.json"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

const repository = { type: "git", url: "git+https://github.com/anomalyco/opentunnel.git" }

async function pack(dir: string, name: string) {
  const destination = `${process.env.RUNNER_TEMP}/release/${name.replace("@opentunnel/", "")}.tgz`
  await $`bun pm pack --ignore-scripts --filename ${destination}`.cwd(dir)
}

const binaries: Record<string, string> = {}
for (const filepath of new Bun.Glob("cli-*/bin/opentunnel").scanSync({ cwd: "./dist" })) {
  const target = filepath.split("/")[0]!
  const [, os, cpu] = target.split("-")
  const name = `@opentunnel/${target}`
  await $`chmod 755 ./dist/${filepath}`
  await Bun.write(
    `./dist/${target}/package.json`,
    JSON.stringify({ name, version: pkg.version, license: pkg.license, repository, os: [os], cpu: [cpu] }, null, 2),
  )
  binaries[name] = pkg.version
}
if (Object.keys(binaries).length === 0) throw new Error("No binaries found in dist/")
console.log("binaries", binaries)

await $`mkdir -p ./dist/${pkg.name}/bin`
await $`cp ./bin/opentunnel.cjs ./dist/${pkg.name}/bin/opentunnel`
await $`cp ./README.md ./dist/${pkg.name}/README.md`
await Bun.write(
  `./dist/${pkg.name}/package.json`,
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      license: pkg.license,
      repository,
      bin: { opentunnel: "bin/opentunnel" },
      optionalDependencies: binaries,
    },
    null,
    2,
  ),
)

for (const name of Object.keys(binaries)) await pack(`./dist/${name.replace("@opentunnel/", "")}`, name)
await pack(`./dist/${pkg.name}`, pkg.name)
