#!/usr/bin/env bash
set -euo pipefail
[[ $GITHUB_EVENT_NAME == workflow_dispatch && $GITHUB_REF == refs/heads/dev ]]
if [[ $MODE == stable ]]; then
  [[ $GITHUB_ACTOR == thdxr && $GITHUB_TRIGGERING_ACTOR == thdxr ]]
fi
latest=$(git tag --list 'v*' | grep -Ex 'v[0-9]+\.[0-9]+\.[0-9]+' | sort -V | tail -1)
IFS=. read -r major minor patch <<< "${latest#v}"
case $BUMP in
  major) major=$((major+1)); minor=0; patch=0 ;;
  minor) minor=$((minor+1)); patch=0 ;;
  patch) patch=$((patch+1)) ;;
  *) exit 1 ;;
esac
version=$major.$minor.$patch
if [[ $MODE == stable ]]; then test -s "docs/releases/$version.md"; fi
echo "version=$version" >> "$GITHUB_OUTPUT"
