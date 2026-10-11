#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
filler='\b(simply|just|easy|easily|please|note that|very|basically|obviously|clearly|powerful|seamless(ly)?|actually|really|in order to|you can|there (is|are))\b'
mapfile -t pages < <(find docs -name '*.md' 2>/dev/null; echo README.md; echo SECURITY.md; echo CONTRIBUTING.md)
if grep -niE "$filler" "${pages[@]}"; then
  echo "filler words above; state the fact or the step instead"
  exit 1
fi
