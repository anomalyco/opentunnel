#!/usr/bin/env bash
set -euo pipefail
cd "$RUNNER_TEMP"
mkdir -p fly-tools
curl -fsSLo flyctl.tar.gz https://github.com/superfly/flyctl/releases/download/v0.4.120/flyctl_0.4.120_Linux_x86_64.tar.gz
echo 'ef9b938ff3af2b28fad961a676e5ac2295124ad0b892ffb1c5f16a03bd4ee378  flyctl.tar.gz' | sha256sum --strict -c
tar -xzf flyctl.tar.gz -C fly-tools flyctl
curl -fsSLo crane.tar.gz https://github.com/google/go-containerregistry/releases/download/v0.20.6/go-containerregistry_Linux_x86_64.tar.gz
echo 'c1d593d01551f2c9a3df5ca0a0be4385a839bd9b86d4a76e18d7b17d16559127  crane.tar.gz' | sha256sum --strict -c
tar -xzf crane.tar.gz -C fly-tools crane
echo "$RUNNER_TEMP/fly-tools" >> "$GITHUB_PATH"
