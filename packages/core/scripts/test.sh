#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -n "${1:-}" ]]; then
  [[ -e node_modules ]] || ln -s "$1/packages/core/node_modules" node_modules
  export INTENT_ENGINE_SO="$1/target/deploy/intent_engine.so"
  export INTENT_ENGINE_ROOT="$1"
fi
case "${2:-all}" in
  build) node_modules/.bin/tsc -p tsconfig.json --noEmit ;;
  test) node_modules/.bin/vitest run --fsModuleCache --bail=1 --config ./vitest.setup.ts ;;
  all) node_modules/.bin/tsc -p tsconfig.json --noEmit && node_modules/.bin/vitest run --fsModuleCache --config ./vitest.setup.ts ;;
  *) echo "mode must be build, test or all" >&2; exit 2 ;;
esac
