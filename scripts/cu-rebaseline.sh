#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
records="${TMPDIR:-/tmp}/solive-cu"
rm -rf "$records"
bash scripts/sbf.sh
for t in attested fill flash forged intent_lifecycle mandate signed; do
  cargo test --quiet -p svm-tests --test "$t" >/dev/null 2>&1 || true
done
baseline=tests/svm/cu-baseline.json
names="$(grep -oE '"[a-z0-9_]+"' "$baseline" | tr -d '"')"
{
  echo "{"
  first=1
  for name in $names; do
    if [[ ! -f "$records/$name" ]]; then
      echo "no measurement recorded for $name" >&2
      exit 1
    fi
    if [[ $first -eq 0 ]]; then echo ","; fi
    printf '  "%s": %s' "$name" "$(cat "$records/$name")"
    first=0
  done
  printf '\n}\n'
} > "$records/baseline.json"
cp "$records/baseline.json" "$baseline"
