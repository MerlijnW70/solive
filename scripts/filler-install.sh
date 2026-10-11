#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
target="${FILLER_HOME:-$HOME/solive-filler}"
if [[ "$target" == /mnt/* ]]; then
  echo "refusing: install the filler on the WSL filesystem, not under /mnt, so it starts in a fraction of a second" >&2
  exit 1
fi
packed="$(mktemp -d)"
for package in core solver cli; do
  pnpm --filter "@intent-engine/$package" build >/dev/null
  (cd "packages/$package" && pnpm pack --pack-destination "$packed" >/dev/null)
done
mkdir -p "$target"
cd "$target"
[[ -f package.json ]] || npm init -y >/dev/null
npm install --no-audit --no-fund --silent "$packed"/*.tgz
rm -rf "$packed"
echo "FILLER_CLI=$target/node_modules/.bin/intent-engine"
"$target/node_modules/.bin/intent-engine" version
