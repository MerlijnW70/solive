#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -n "${1:-}" ]]; then
  [[ -e node_modules ]] || ln -s "$1/packages/cli/node_modules" node_modules
  export INTENT_ENGINE_SO="$1/target/deploy/intent_engine.so"
  export INTENT_ENGINE_ROOT="$1"
fi
base="$HOME/.cache/solive-kill/base"
if [[ "${2:-}" == test && "$PWD" == /mnt/* && -f "$base/.ready" && "$(cat "$base/.ready")" == "$(bash scripts/kill-key.sh "$1")" ]]; then
  copy="$HOME/.cache/solive-kill/slots/$(printf '%s' "$PWD" | sha256sum | cut -c1-16)"
  mkdir -p "$copy"
  rsync -a --delete --exclude=node_modules --exclude=dist --exclude=.noha ./ "$copy/"
  ln -sfn "$base/packages/cli/node_modules" "$copy/node_modules"
  export INTENT_ENGINE_SO="$base/target/deploy/intent_engine.so"
  export INTENT_ENGINE_ROOT="$base"
  cd "$copy"
fi
case "${2:-all}" in
  build) node_modules/.bin/tsc -p tsconfig.json --noEmit ;;
  test) node_modules/.bin/tsc -p tsconfig.build.json && timeout 1200 node_modules/.bin/vitest run --bail=1 --fsModuleCache --testTimeout=60000 --config ./vitest.setup.ts --exclude test/binary.test.ts ;;
  all) node_modules/.bin/tsc -p tsconfig.json --noEmit && node_modules/.bin/tsc -p tsconfig.build.json && node_modules/.bin/vitest run --config ./vitest.setup.ts ;;
  *) echo "mode must be build, test or all" >&2; exit 2 ;;
esac
