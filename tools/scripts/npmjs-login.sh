#!/usr/bin/env bash
set -euo pipefail

REGISTRY="https://registry.npmjs.org/"

echo "[npmjs-login] Logging in to ${REGISTRY}"
echo "[npmjs-login] This only authenticates the npm CLI; it does not change @yieldcraft scoped registry config."
npm login --registry="${REGISTRY}"
