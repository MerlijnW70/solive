#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
if [[ ! -f "$root/packages/cli/dist/src/bin.js" ]]; then
  echo "build the CLI first: pnpm --filter @intent-engine/cli build" >&2
  exit 2
fi
exec node "$root/packages/cli/scripts/mcp-smoke.mjs" "$@"
