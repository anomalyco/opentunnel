#!/usr/bin/env bash
set -euo pipefail
umask 077
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
case $1 in
  homebrew)
    key=HOMEBREW_TAP_DEPLOY_KEY
    export HOMEBREW_TAP=1
    echo 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' > "$temporary/hosts" ;;
  aur)
    key=AUR_SSH_KEY
    export AUR=1
    echo 'aur.archlinux.org ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEuBKrPzbawxA/k2g6NcyV5jmqwJ2s+zpgZGZ7tpLIcN' > "$temporary/hosts" ;;
  *) exit 1 ;;
esac
aws secretsmanager get-secret-value --region us-east-1 --secret-id "shared/$key" --query SecretString --output text > "$temporary/key"
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
export GIT_SSH_COMMAND="ssh -i $temporary/key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$temporary/hosts"
export GIT_AUTHOR_NAME=opentunnel GIT_AUTHOR_EMAIL=opentunnel@anoma.ly GIT_COMMITTER_NAME=opentunnel GIT_COMMITTER_EMAIL=opentunnel@anoma.ly
bun .github/release/distribute.ts
