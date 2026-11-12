#!/usr/bin/env bash
set -euo pipefail
for pkg in packages/{cli,client,protocol}/package.json; do
  jq --arg version "$VERSION" '.version=$version' "$pkg" > "$pkg.new"
  mv "$pkg.new" "$pkg"
done
bun packages/cli/script/version.ts
