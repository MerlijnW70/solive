#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
bash scripts/supply-chain.sh
cargo deny check
pnpm audit
