#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
if [[ -n "${INTENT_ENGINE_ROOT:-}" && ! -e packages/core/node_modules ]]; then
  ln -s "$INTENT_ENGINE_ROOT/packages/core/node_modules" packages/core/node_modules
fi
bash scripts/sbf.sh
cargo test --workspace --quiet "$@"
