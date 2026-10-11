#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
bash scripts/identity.sh
pnpm --filter @intent-engine/core codegen
