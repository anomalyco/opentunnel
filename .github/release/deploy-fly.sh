#!/usr/bin/env bash
set -euo pipefail
umask 077
DOCKER_CONFIG=$(mktemp -d)
export DOCKER_CONFIG
trap 'rm -rf "$DOCKER_CONFIG"' EXIT
FLY_API_TOKEN=$(aws secretsmanager get-secret-value --region us-east-1 --secret-id opentunnel/production/FLY_API_TOKEN --query SecretString --output text)
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
export FLY_API_TOKEN
flyctl auth docker
repository=registry.fly.io/opentunnel
crane push "$RUNNER_TEMP/image/image.tar" "$repository:$GITHUB_SHA" --image-refs "$RUNNER_TEMP/image-ref"
image=$(cat "$RUNNER_TEMP/image-ref")
[[ $image =~ ^registry\.fly\.io/opentunnel@sha256:[a-f0-9]{64}$ ]]
config=.github/release/targets/production.toml
for attempt in 1 2 3; do
  if flyctl deploy --app opentunnel --config "$config" --image "$image"; then exit 0; fi
  sleep 60
done
flyctl deploy --app opentunnel --config "$config" --image "$image" --strategy rolling
