#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
secs="${1:-60}"
cd crates/intent-core
for target in settle lifecycle sig ext mandate partner preimage; do
  cargo +"${FUZZ_TOOLCHAIN:-nightly}" fuzz run "$target" -- -max_total_time="$secs"
done
