#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -n "${1:-}" ]]; then
  [[ -e node_modules ]] || ln -s "$1/packages/solver/node_modules" node_modules
  export INTENT_ENGINE_SO="$1/target/deploy/intent_engine.so"
fi
case "${2:-all}" in
  build) node_modules/.bin/tsc -p tsconfig.json --noEmit ;;
  test) node_modules/.bin/vitest run ;;
  all) node_modules/.bin/tsc -p tsconfig.json --noEmit && node_modules/.bin/vitest run ;;
  *) echo "mode must be build, test or all" >&2; exit 2 ;;
esac
