#!/usr/bin/env bash
set -euo pipefail
cd "$RUNNER_TEMP/release"
for slug in cli-linux-x64 cli-linux-arm64 cli-darwin-x64 cli-darwin-arm64 protocol client opentunnel; do
  name=@opentunnel/$slug
  if [[ $slug == opentunnel ]]; then name=opentunnel; fi
  tar -xzOf "$slug.tgz" package/package.json | jq -e --arg name "$name" --arg version "$VERSION" '.name==$name and .version==$version and (.publishConfig.registry // "https://registry.npmjs.org") == "https://registry.npmjs.org"' >/dev/null
  if existing=$(npm view "$name@$VERSION" dist.integrity); then
    local_sum=$(openssl dgst -sha512 -binary < "$slug.tgz" | openssl base64 -A)
    [[ $existing == "sha512-$local_sum" ]]
  else
    npm publish "./$slug.tgz" --registry=https://registry.npmjs.org --access public --tag latest --provenance --ignore-scripts
  fi
done
