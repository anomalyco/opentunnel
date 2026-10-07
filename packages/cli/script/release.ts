#!/usr/bin/env bun
// Publishes the CLI binaries outside npm: a GitHub release with one tarball per
// platform (also used by the install script), the Homebrew formula in
// anomalyco/homebrew-tap, and the opentunnel-bin AUR package. Each step is
// skipped when its credentials are missing.

import { $ } from "bun"
import { fileURLToPath } from "url"
import pkg from "../package.json"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

const version = pkg.version
const tag = `v${version}`
const repo = "anomalyco/opentunnel"
const description = "Public URLs for local services, end-to-end encrypted"
const download = (platform: string) =>
  `https://github.com/${repo}/releases/download/${tag}/opentunnel-${platform}.tar.gz`

const platforms = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]
const sha: Record<string, string> = {}
for (const platform of platforms) {
  const tarball = `./dist/opentunnel-${platform}.tar.gz`
  await $`chmod 755 ./dist/cli-${platform}/bin/opentunnel`
  await $`tar -czf ${tarball} -C ./dist/cli-${platform}/bin opentunnel`
  sha[platform] = new Bun.CryptoHasher("sha256").update(await Bun.file(tarball).arrayBuffer()).digest("hex")
}

// GitHub release
if (process.env.GH_TOKEN) {
  if ((await $`gh release view ${tag} --repo ${repo}`.nothrow().quiet()).exitCode === 0) {
    console.log(`release ${tag} already exists`)
  } else {
    const tarballs = platforms.map((platform) => `./dist/opentunnel-${platform}.tar.gz`)
    await $`gh release create ${tag} ${tarballs} --repo ${repo} --title ${tag} --generate-notes`
  }
} else {
  console.warn("GH_TOKEN is not set; skipping the GitHub release, Homebrew, and AUR")
  process.exit(0)
}

// Homebrew: brew install anomalyco/tap/opentunnel
const formula = `class Opentunnel < Formula
  desc "${description}"
  homepage "https://opentunnel.xyz"
  version "${version}"
  license "MIT"

  on_macos do
    on_arm do
      url "${download("darwin-arm64")}"
      sha256 "${sha["darwin-arm64"]}"
    end
    on_intel do
      url "${download("darwin-x64")}"
      sha256 "${sha["darwin-x64"]}"
    end
  end

  on_linux do
    on_arm do
      url "${download("linux-arm64")}"
      sha256 "${sha["linux-arm64"]}"
    end
    on_intel do
      url "${download("linux-x64")}"
      sha256 "${sha["linux-x64"]}"
    end
  end

  def install
    bin.install "opentunnel"
  end

  test do
    system bin/"opentunnel", "--version"
  end
end
`
// CI writes the tap's deploy key (HOMEBREW_TAP_KEY) to an SSH host alias, homebrew-tap.github.com.
if (process.env.HOMEBREW_TAP_KEY) {
  const tap = "git@homebrew-tap.github.com:anomalyco/homebrew-tap.git"
  await $`rm -rf ./dist/homebrew-tap`
  await $`git clone --depth 1 ${tap} ./dist/homebrew-tap`
  await Bun.write("./dist/homebrew-tap/opentunnel.rb", formula)
  await $`git add opentunnel.rb`.cwd("./dist/homebrew-tap")
  if ((await $`git diff --cached --quiet`.cwd("./dist/homebrew-tap").nothrow()).exitCode !== 0) {
    await $`git commit -m ${`opentunnel ${version}`}`.cwd("./dist/homebrew-tap")
    await $`git push`.cwd("./dist/homebrew-tap")
  }
} else {
  console.warn("HOMEBREW_TAP_KEY is not set; skipping Homebrew")
}

// AUR: yay -S opentunnel-bin
const aurSource = (arch: string, platform: string) =>
  `opentunnel-${version}-${arch}.tar.gz::${download(platform)}`
const pkgbuild = `pkgname=opentunnel-bin
pkgver=${version}
pkgrel=1
pkgdesc='${description}'
url='https://opentunnel.xyz'
arch=('aarch64' 'x86_64')
license=('MIT')
provides=('opentunnel')
conflicts=('opentunnel')
options=('!debug' '!strip')
source_aarch64=("${aurSource("aarch64", "linux-arm64")}")
sha256sums_aarch64=('${sha["linux-arm64"]}')
source_x86_64=("${aurSource("x86_64", "linux-x64")}")
sha256sums_x86_64=('${sha["linux-x64"]}')

package() {
  install -Dm755 opentunnel "$pkgdir/usr/bin/opentunnel"
}
`
// Equivalent to \`makepkg --printsrcinfo\`, which is not available on CI runners.
const srcinfo = `pkgbase = opentunnel-bin
\tpkgdesc = ${description}
\tpkgver = ${version}
\tpkgrel = 1
\turl = https://opentunnel.xyz
\tarch = aarch64
\tarch = x86_64
\tlicense = MIT
\tprovides = opentunnel
\tconflicts = opentunnel
\toptions = !debug
\toptions = !strip
\tsource_aarch64 = ${aurSource("aarch64", "linux-arm64")}
\tsha256sums_aarch64 = ${sha["linux-arm64"]}
\tsource_x86_64 = ${aurSource("x86_64", "linux-x64")}
\tsha256sums_x86_64 = ${sha["linux-x64"]}

pkgname = opentunnel-bin
`
if (process.env.AUR_KEY) {
  await $`rm -rf ./dist/aur`
  await $`git clone ssh://aur@aur.archlinux.org/opentunnel-bin.git ./dist/aur`
  await Bun.write("./dist/aur/PKGBUILD", pkgbuild)
  await Bun.write("./dist/aur/.SRCINFO", srcinfo)
  await $`git add PKGBUILD .SRCINFO`.cwd("./dist/aur")
  if ((await $`git diff --cached --quiet`.cwd("./dist/aur").nothrow()).exitCode !== 0) {
    await $`git commit -m ${`Update to ${version}`}`.cwd("./dist/aur")
    await $`git push origin HEAD:master`.cwd("./dist/aur")
  }
} else {
  console.warn("AUR_KEY is not set; skipping AUR")
}
