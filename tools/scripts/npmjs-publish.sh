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

echo "[npmjs-publish] Target package: ${TARGET}"
echo "[npmjs-publish] Registry override active for this workspace only: ${SCOPE_REGISTRY_LINE}"
echo "[npmjs-publish] Checking npmjs.com version availability..."
if npm view "${TARGET}" version >/tmp/doc-viewer-npmjs-existing-version.txt 2>/tmp/doc-viewer-npmjs-view.err; then
  echo "[npmjs-publish] ERROR: ${TARGET} already exists on npmjs.com; refusing to publish over it." >&2
  cat /tmp/doc-viewer-npmjs-existing-version.txt >&2 || true
  exit 1
fi
if ! grep -qiE 'E404|404 Not Found|not in this registry' /tmp/doc-viewer-npmjs-view.err; then
  echo "[npmjs-publish] ERROR: unexpected npm view failure:" >&2
  echo "--- stdout ---" >&2
  cat /tmp/doc-viewer-npmjs-existing-version.txt >&2 || true
  echo "--- stderr ---" >&2
  cat /tmp/doc-viewer-npmjs-view.err >&2 || true
  exit 1
fi

echo "[npmjs-publish] Running npm pack --dry-run..."
PACK_JSON="$(mktemp)"
npm pack --dry-run --json > "${PACK_JSON}"
node - "${PACK_JSON}" <<'NODE'
const fs = require('fs');
const pack = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))[0];
console.log(`[npmjs-publish] Package: ${pack.name}@${pack.version}`);
console.log('[npmjs-publish] Files to publish:');
for (const file of pack.files) console.log(`  - ${file.path}`);
NODE

echo "[npmjs-publish] Running anti-leak scan on publish allowlist..."
node - "${PACK_JSON}" <<'NODE' > /tmp/doc-viewer-pack-files.txt
const fs = require('fs');
const pack = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))[0];
for (const file of pack.files) console.log(file.path);
NODE
while IFS= read -r file; do
  [[ -f "${file}" ]] || continue
  if grep -InE 'git\.taila|git\.yieldcraft|backend:|Forgejo Packages|NPMJS_TOKEN|GH_SYNC_TOKEN|api/packages/.*/npm' "${file}"; then
    echo "[npmjs-publish] ERROR: private/internal string found in ${file}; aborting." >&2
    exit 1
  fi
done < /tmp/doc-viewer-pack-files.txt

echo "[npmjs-publish] OK: no private/internal strings found."
echo "[npmjs-publish] Publishing to npmjs.com. If npm asks for MFA, re-run with:"
echo "  tools/scripts/npmjs-publish.sh --otp=123456"
npm publish --access public "$@"

echo "[npmjs-publish] Published to npmjs.com."
echo "[npmjs-publish] Do not re-publish ${TARGET}."
echo "[npmjs-publish] If needed, verify later with: tools/scripts/npmjs-verify.sh"
