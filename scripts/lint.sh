#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
bash scripts/identity.sh --check
bash scripts/bans.sh
bash scripts/docs-lint.sh
bash scripts/comments.sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
pnpm --filter @intent-engine/core build
pnpm --filter @intent-engine/client build
pnpm --filter @intent-engine/solver build
bash scripts/api-report.sh
pnpm -r typecheck
