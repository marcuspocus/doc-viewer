#!/usr/bin/env bash
set -euo pipefail

REGISTRY="https://registry.npmjs.org/"
SCOPE_REGISTRY_LINE="@yieldcraft:registry=${REGISTRY}"
PACKAGE_NAME="$(node -p "require('./package.json').name")"
PACKAGE_VERSION="$(node -p "require('./package.json').version")"
TARGET="${PACKAGE_NAME}@${PACKAGE_VERSION}"
BACKUP=""

cleanup() {
  if [[ -n "${BACKUP}" && -f "${BACKUP}" ]]; then
    mv "${BACKUP}" .npmrc
  else
    rm -f .npmrc
  fi
}
trap cleanup EXIT

if [[ -f .npmrc ]]; then
  BACKUP=".npmrc.doc-viewer.bak"
  cp .npmrc "${BACKUP}"
fi

printf '%s\n' "${SCOPE_REGISTRY_LINE}" > .npmrc

echo "[npmjs-verify] npm access status for ${PACKAGE_NAME}:"
npm access get status "${PACKAGE_NAME}" --registry="${REGISTRY}" || true

echo "[npmjs-verify] Querying npmjs.com packument for ${TARGET}:"
npm view "${TARGET}" version dist.tarball
