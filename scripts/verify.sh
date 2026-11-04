#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
image="solanafoundation/solana-verifiable-build@sha256:2e0b78f44ee76612e9260c7c988570c5e14de6fbd93e0ab07115ec7054473b4f"
base="${TMPDIR:-/tmp}/solive-verify-$(id -u)"
mkdir -p -m 700 "$base" 2> /dev/null || true
if [[ -L "$base" || ! -d "$base" ]]; then
  echo "$base is not a plain directory; remove it, or set TMPDIR to a directory of your own, and run again" >&2
  exit 1
fi
if [[ "$(stat -c %u "$base")" != "$(id -u)" ]]; then
  echo "$base belongs to $(stat -c %U "$base"), not $(id -un); ask that user or root to remove it, or set TMPDIR to a directory of your own, and run again" >&2
  exit 1
fi
if [[ "$(stat -c %a "$base")" != 700 ]]; then
  echo "$base must be private to you; run chmod 700 $base and run again" >&2
  exit 1
fi
exec 9> "$base/lock"
flock 9
work="$base/work"
wipe() {
  chmod -R u+rwX "$work" 2> /dev/null || true
  rm -rf "$work" 2> /dev/null || docker run --rm -v "$base:/base" --entrypoint rm "$image" -rf /base/work || true
  if [[ -e "$work" ]]; then
    echo "$work holds files you cannot remove, such as root-owned files from a failed build; run sudo rm -rf $work and run again" >&2
    exit 1
  fi
}
wipe
mkdir "$work"
git archive HEAD | tar -x -C "$work"
(cd "$work" && solana-verify build --library-name intent_engine --base-image "$image")
docker run --rm -v "$work:/work" --entrypoint chown "$image" -R "$(id -u):$(id -g)" /work
mkdir -p verifiable
cp "$work/target/deploy/intent_engine.so" verifiable/intent_engine.so
wipe
solana-verify get-executable-hash verifiable/intent_engine.so | tee verifiable/intent_engine.hash
