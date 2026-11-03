#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
max=510
mapfile -t files < <(git ls-files '*.ts' '*.mts' '*.cts' '*.mjs' '*.cjs' '*.js' '*.css' | grep -v -e '/generated/' -e '\.d\.ts$')
status=0
for file in "${files[@]}"; do
  lines="$(wc -l < "$file")"
  if (( lines > max )); then
    echo "$file has $lines lines, over the limit of $max; split it"
    status=1
  fi
done
exit "$status"
