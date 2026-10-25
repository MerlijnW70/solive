#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
tools="v1.57"
build() {
  env -u RUSTFLAGS -u CARGO_ENCODED_RUSTFLAGS cargo build-sbf --tools-version "$tools" --manifest-path "$1" --sbf-out-dir target/deploy >&2
}
if [[ "${1:-}" != "--relay" ]]; then
  build programs/intent_engine/Cargo.toml
fi
build tests/relay/Cargo.toml
