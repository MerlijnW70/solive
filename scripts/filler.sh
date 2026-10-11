#!/usr/bin/env bash
set -uo pipefail
cli=(node "$(dirname "$0")/../packages/cli/dist/src/bin.js")
keypair="${FILLER_KEYPAIR:?set FILLER_KEYPAIR to the keypair of the test token mint authority}"
url="${FILLER_URL:-devnet}"
wrapped_sol=So11111111111111111111111111111111111111112
test_token=ETU8trkkfE8gNVPDGbCaJUoH88wy6yYV6ttJdc9NKB88
"${cli[@]}" treasury --url "$url" --create --mints "$wrapped_sol" --keypair "$keypair" --yes
while true; do
  "${cli[@]}" solve --url "$url" --keypair "$keypair" --issue "$wrapped_sol:$test_token=200/1" --min-profit "$test_token=1"
  "${cli[@]}" crank --url "$url" --keypair "$keypair"
  sleep "${FILLER_INTERVAL:-10}"
done
