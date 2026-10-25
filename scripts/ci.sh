#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
pnpm install --frozen-lockfile
bash scripts/build.sh
bash scripts/codegen.sh
git diff --exit-code -- idl packages/core/generated README.md scripts/wsl.cmd packages/core/scripts/wsl.cmd packages/client/scripts/wsl.cmd packages/cli/scripts/wsl.cmd packages/solver/scripts/wsl.cmd programs/intent_engine/src/security.rs programs/intent_engine/LICENSE crates/intent-core/LICENSE
bash scripts/lint.sh
cargo test --workspace --locked --quiet
bash scripts/ts-test.sh
