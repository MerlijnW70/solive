#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -n "${1:-}" ]]; then
  [[ -e node_modules ]] || ln -s "$1/packages/solver/node_modules" node_modules
  export INTENT_ENGINE_SO="$1/target/deploy/intent_engine.so"
fi
case "${2:-all}" in
  build) node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit ;;
  test) timeout 1200 node node_modules/vitest/vitest.mjs run --testTimeout=60000 --config ./vitest.setup.ts ;;
  all) node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit && node node_modules/vitest/vitest.mjs run --config ./vitest.setup.ts ;;
  *) echo "mode must be build, test or all" >&2; exit 2 ;;
esac
