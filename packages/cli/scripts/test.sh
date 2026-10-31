#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -n "${1:-}" ]]; then
  [[ -e node_modules ]] || ln -s "$1/packages/cli/node_modules" node_modules
  export INTENT_ENGINE_SO="$1/target/deploy/intent_engine.so"
  export INTENT_ENGINE_ROOT="$1"
fi
case "${2:-all}" in
  build) node node_modules/typescript/bin/tsc -p tsconfig.sandbox.json --noEmit ;;
  test) node node_modules/typescript/bin/tsc -p tsconfig.build.json && timeout 1200 node node_modules/vitest/vitest.mjs run --maxWorkers=4 --bail=1 --fsModuleCache --testTimeout=60000 --config ./vitest.setup.ts --exclude test/binary.test.ts --exclude test/demo-worker.test.ts --exclude test/demo-worker-fast.test.ts ;;
  all) node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit && node node_modules/typescript/bin/tsc -p tsconfig.build.json && node node_modules/vitest/vitest.mjs run --config ./vitest.setup.ts ;;
  *) echo "mode must be build, test or all" >&2; exit 2 ;;
esac
