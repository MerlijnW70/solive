#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
cargo kani -p proofs --output-format terse "$@"
