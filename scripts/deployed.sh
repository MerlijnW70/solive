#!/usr/bin/env bash
set -euo pipefail
cluster="${1:?usage: bash scripts/deployed.sh devnet <verifiable hash file>}"
expected="$(tr -d '[:space:]' < "${2:?usage: bash scripts/deployed.sh devnet <verifiable hash file>}")"
case "$cluster" in
  devnet) url="https://api.devnet.solana.com" ;;
  *) echo "deployed.sh checks devnet only, not $cluster" >&2; exit 2 ;;
esac
program="$(sed -n 's/^declare_id!("\([1-9A-HJ-NP-Za-km-z]*\)");$/\1/p' programs/intent_engine/src/lib.rs)"
if [[ -z "$program" || ! "$expected" =~ ^[0-9a-f]{64}$ ]]; then
  echo "no program id in lib.rs or no hash in $2" >&2
  exit 2
fi
deployed="$(solana-verify get-program-hash -u "$url" "$program" | tr -d '[:space:]')"
if [[ "$deployed" != "$expected" ]]; then
  echo "the $cluster program $program has hash $deployed, but the verifiable build of this commit has $expected" >&2
  exit 1
fi
echo "the $cluster program $program matches the verifiable build $expected"
