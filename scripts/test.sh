#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
bash scripts/sbf.sh
cargo test --workspace --quiet "$@"
