#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
commit=51941c4162591d3d9961645bcaa8ff26056926e7
toolchain=1.99.0
pinned=packages/cli/assets/viperjs-judge.sha256
work=/tmp/viperjs-judge-build
rustup toolchain install "$toolchain" --profile minimal --target wasm32-unknown-unknown >/dev/null
rm -rf "$work"
git clone -q https://github.com/MerlijnW70/viperjs "$work"
git -C "$work" checkout -q "$commit"
(
  cd "$work"
  CARGO_TARGET_DIR="$work/target" RUSTFLAGS="--remap-path-prefix=$work=/viperjs --remap-path-prefix=$HOME=/home"     cargo +"$toolchain" build -q --locked -p viperjs-judge --release --target wasm32-unknown-unknown
)
built="$work/target/wasm32-unknown-unknown/release/viperjs_judge.wasm"
sha=$(sha256sum "$built" | cut -d' ' -f1)
if [[ "${1:-}" == "--write" ]]; then
  cp "$built" packages/cli/assets/viperjs-judge.wasm
  printf '%s\n' "$sha" > "$pinned"
  echo "wrote $sha"
elif [[ "$sha" == "$(cat "$pinned")" ]]; then
  echo "reproduced $sha"
else
  echo "built $sha, pinned $(cat "$pinned")" >&2
  exit 1
fi
