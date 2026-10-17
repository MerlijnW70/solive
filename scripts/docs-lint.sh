#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
filler='\b(simply|just|easy|easily|please|note that|very|basically|obviously|clearly|powerful|seamless(ly)?|actually|really|in order to|you can|there (is|are))\b'
mapfile -t pages < <(find docs -name '*.md' 2>/dev/null; echo README.md; echo SECURITY.md; echo CONTRIBUTING.md)
if grep -niE "$filler" "${pages[@]}"; then
  echo "filler words above; state the fact or the step instead"
  exit 1
fi
mapfile -t guides < <(find docs -maxdepth 1 -name '*.md'; echo README.md)
long=$(awk '
  FNR == 1 { flush(); code = 0; front = ($0 == "---"); if (front) next }
  front { if ($0 == "---") front = 0; next }
  /^```/ { flush(); code = !code; next }
  code { next }
  /^[[:space:]]*$/ || substr($0, 1, 1) == "#" || substr($0, 1, 1) == "|" { flush(); next }
  /^[-*] / || /^[0-9]+\. / { flush() }
  { words += NF; if (!start) start = FNR; name = FILENAME }
  END { flush() }
  function flush() { if (words > 80) printf "%s:%d: %d words in one paragraph\n", name, start, words; words = 0; start = 0 }
' "${guides[@]}")
if [[ -n "$long" ]]; then
  echo "$long"
  echo "paragraphs above run past 80 words; split them or move the detail to docs/reference or docs/maintainers"
  exit 1
fi
