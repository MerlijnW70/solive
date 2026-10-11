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
(
  while true; do
    "${cli[@]}" crank --url "$url" --keypair "$keypair"
    sleep 30
  done
) &
trap 'kill $!' EXIT
while true; do
  "${cli[@]}" solve --url "$url" --keypair "$keypair" --issue "$wrapped_sol:$test_token=200/1" --min-profit "$test_token=1" --watch --interval "$interval"
  sleep 1
done
