#!/usr/bin/env bash
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -n "${DEMO_WORKER_CLI:-}" ]]; then
  cli=("$DEMO_WORKER_CLI")
else
  cli=(node "$root/packages/cli/dist/src/bin.js")
fi
: "${DEMO_WORKER_KEYPAIR:?set DEMO_WORKER_KEYPAIR to the devnet key file of the demo worker}"
repository="$(sed -n 's/^repository = "\(https:\/\/github\.com\/[^"]*\)"$/\1/p' "$root/identity.toml")"
if [[ -z "${DEMO_WORKER_BASE_URL:-}" && -z "$repository" ]]; then
  echo "identity.toml names no github repository; set DEMO_WORKER_BASE_URL to where examples/demo is served" >&2
  exit 1
fi
export DEMO_WORKER_KEYPAIR
export DEMO_WORKER_DEMOS="${DEMO_WORKER_DEMOS:-$root/examples/demo}"
export DEMO_WORKER_BASE_URL="${DEMO_WORKER_BASE_URL:-${repository/https:\/\/github.com/https://raw.githubusercontent.com}/main/examples/demo}"
export DEMO_WORKER_STATE="${DEMO_WORKER_STATE:-$HOME/demo-worker.json}"
exec node --experimental-strip-types --disable-warning=ExperimentalWarning "$root/scripts/demo-worker.mts" "$@" -- "${cli[@]}"
