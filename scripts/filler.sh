#!/usr/bin/env bash
set -uo pipefail
if [[ -n "${FILLER_CLI:-}" ]]; then
  cli=("$FILLER_CLI")
else
  cli=(node "$(dirname "$0")/../packages/cli/dist/src/bin.js")
fi
keypair="${FILLER_KEYPAIR:?set FILLER_KEYPAIR to the keypair of the test token mint authority}"
url="${FILLER_URL:-devnet}"
interval="${FILLER_INTERVAL:-5}"
wrapped_sol=So11111111111111111111111111111111111111112
test_token=ETU8trkkfE8gNVPDGbCaJUoH88wy6yYV6ttJdc9NKB88
"${cli[@]}" treasury --url "$url" --create --mints "$wrapped_sol" --keypair "$keypair" --yes
stop() {
  trap - EXIT INT TERM
  kill -STOP "$crank" 2>/dev/null
  pkill -P "$crank" 2>/dev/null
  kill -KILL "$crank" 2>/dev/null
  kill "${solving:-}" 2>/dev/null
  exit 0
}
(
  while true; do
    "${cli[@]}" crank --url "$url" --keypair "$keypair"
    sleep 30
  done
) &
crank=$!
trap stop EXIT INT TERM
while true; do
  "${cli[@]}" solve --url "$url" --keypair "$keypair" --issue "$wrapped_sol:$test_token=200/1" --min-profit "$test_token=1" --watch --interval "$interval" &
  solving=$!
  wait "$solving"
  sleep 1
done
