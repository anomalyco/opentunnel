#!/usr/bin/env bash
set -euo pipefail
out=$RUNNER_TEMP/release
mkdir "$out"
bash .github/release/stamp.sh
bun install --ignore-scripts
bun run ready
bun packages/cli/script/publish.ts
bun packages/client/script/publish.ts
bun packages/cli/script/release.ts
cp packages/cli/dist/{opentunnel-*.tar.gz,SHA256SUMS} "$out"
cargo package --locked --allow-dirty --no-verify -p opentunnel -p opentunnel-cli
python3 .github/release/crate-upload.py
if [[ $MODE == stable ]]; then cp "docs/releases/$VERSION.md" "$out/notes.md"; else echo "Dry run $VERSION" > "$out/notes.md"; fi
cd "$out"
sha256sum -- * > MANIFEST
echo "digest=$(sha256sum MANIFEST | cut -d' ' -f1)" >> "$GITHUB_OUTPUT"
