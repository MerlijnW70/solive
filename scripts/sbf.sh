#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
tools="v1.57"
cargo build-sbf --tools-version "$tools" --manifest-path programs/intent_engine/Cargo.toml --sbf-out-dir target/deploy >&2
cargo build-sbf --tools-version "$tools" --manifest-path tests/relay/Cargo.toml --sbf-out-dir target/deploy >&2
