#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
target="${FILLER_HOME:-$HOME/solive-filler}"
if [[ "$target" == /mnt/* ]]; then
  echo "refusing: install the filler on the WSL filesystem, not under /mnt, so it starts in a fraction of a second" >&2
  exit 1
fi
repo="$PWD"
packed="$(mktemp -d)"
for package in core client solver cli; do
  pnpm --filter "@intent-engine/$package" build >/dev/null
  (cd "packages/$package" && pnpm pack --pack-destination "$packed" >/dev/null)
done
mkdir -p "$target"
cd "$target"
[[ -f package.json ]] || npm init -y >/dev/null
npm install --no-audit --no-fund --silent "$packed"/*.tgz
rm -rf "$packed"
install -m 0755 "$repo/scripts/filler.sh" "$target/filler.sh"
install -m 0755 "$repo/scripts/faucet-topup.sh" "$target/faucet-topup.sh"
installed=$("$target/node_modules/.bin/intent-engine" version | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p')
published=$(npm view @intent-engine/cli version 2>/dev/null || true)
echo "filler: $target/filler.sh"
echo "installed cli ${installed:-unknown}, published cli ${published:-unknown}"
if [[ -z "$published" ]]; then
  echo "npm did not answer, so the published version is unknown" >&2
elif [[ "$installed" != "$published" ]]; then
  echo "the installed cli $installed is not the published $published; check out v$published and install again" >&2
fi
