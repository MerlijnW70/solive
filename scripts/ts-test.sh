#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
bash scripts/identity.sh --check
pnpm --filter @intent-engine/core build
pnpm --filter @intent-engine/solver build
pnpm --filter @intent-engine/cli build
pnpm -r typecheck
pnpm -r test
