#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
tools="v1.57"
env -u RUSTFLAGS -u CARGO_ENCODED_RUSTFLAGS cargo build-sbf --tools-version "$tools" --manifest-path programs/intent_engine/Cargo.toml --sbf-out-dir target/deploy >&2
env -u RUSTFLAGS -u CARGO_ENCODED_RUSTFLAGS cargo build-sbf --tools-version "$tools" --manifest-path tests/relay/Cargo.toml --sbf-out-dir target/deploy >&2
