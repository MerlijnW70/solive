#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
guard_temps
targets=("$@")
if [[ ${#targets[@]} -eq 0 ]]; then
  targets=(packages/core packages/client packages/solver packages/cli packages/multisig services/faucet services/live services/specs)
fi
status=0
for target in "${targets[@]}"; do
  if [[ ! -f "$target/package.json" ]]; then
    echo "no package at $target" >&2
    exit 2
  fi
  make_temp fresh -d
  chmod 711 "$fresh"
  if ! NODE_DISABLE_COMPILE_CACHE=1 TMPDIR="$fresh" TMP="$fresh" TEMP="$fresh" pnpm --filter "./$target" test; then
    echo "temp-guard $target: the test run failed" >&2
    status=1
  fi
  left="$(find "$fresh" -mindepth 1 -maxdepth 1 | wc -l)"
  echo "temp-guard $target: $left leftover entries"
  if [[ "$left" != 0 ]]; then
    find "$fresh" -mindepth 1 -maxdepth 1 >&2
    status=1
  fi
done
exit "$status"
