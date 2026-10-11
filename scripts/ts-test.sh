#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
if [[ "$PWD" == /mnt/* ]]; then
  export INTENT_ENGINE_SO="${INTENT_ENGINE_SO:-$PWD/target/deploy/intent_engine.so}"
  mirror="${CARGO_TARGET_DIR/solive-target/solive-mirror}"
  mkdir -p "$mirror"
  rsync -a --delete \
    --exclude=node_modules --exclude=dist \
    --exclude=/target --exclude=/.git --exclude=/verifiable --exclude=/.pnpm-store \
    --exclude=/crates/intent-core/fuzz/target --exclude=/crates/intent-core/fuzz/corpus --exclude=/crates/intent-core/fuzz/artifacts \
    ./ "$mirror/"
  cd "$mirror"
  pnpm install --frozen-lockfile --prefer-offline >/dev/null
fi
bash scripts/identity.sh --check
pnpm --filter @intent-engine/core build
pnpm --filter @intent-engine/solver build
pnpm --filter @intent-engine/cli build
pnpm -r typecheck
pnpm -r test
