#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mapfile -t code < <(git ls-files '*.rs' '*.ts' '*.mjs' | grep -v -e '/generated/' -e '\.d\.ts$')
mapfile -t shell < <(git ls-files '*.sh')
status=0
if grep -nE '^\s*(//|/\*)|[;,){]\s+//\s' "${code[@]}" | grep -v '^[^:]*:[0-9]*:\s*/// CHECK:'; then
  status=1
fi
hash="$(printf '\043')"
if grep -nE "^\s*${hash}" "${shell[@]}" | grep -v ":1:${hash}!"; then
  status=1
fi
if [[ "$status" != 0 ]]; then
  echo "comments above; state behaviour in a test instead (Anchor's /// CHECK: lines are the only exception)"
fi
exit "$status"
