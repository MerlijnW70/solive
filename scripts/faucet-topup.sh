#!/usr/bin/env bash
set -euo pipefail
keypair="${TOPUP_KEYPAIR:?set TOPUP_KEYPAIR to the keypair of the wallet that funds the faucet}"
url="${TOPUP_URL:-devnet}"
faucet="${TOPUP_FAUCET:-CrYx7JA1TRwGtpn9T6C2mVsRgMP7XztGRwZdasV9XSLS}"
floor="${TOPUP_FLOOR:-5}"
target="${TOPUP_TARGET:-10}"
devnet_genesis=EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG
lamports_per_sol=1000000000

yes=0
for arg in "$@"; do
  case "$arg" in
    --yes) yes=1 ;;
    *)
      echo "usage: faucet-topup.sh [--yes]" >&2
      exit 2
      ;;
  esac
done

lamports() {
  if ! [[ "$1" =~ ^([0-9]+)(\.([0-9]{1,9}))?$ ]]; then
    echo "$2 is SOL with at most 9 decimals, such as 5 or 2.5, not $1" >&2
    exit 2
  fi
  local fraction="${BASH_REMATCH[3]}000000000" digits
  digits=$(printf '%s' "${BASH_REMATCH[1]}${fraction:0:9}" | sed 's/^0*//')
  echo "${digits:-0}"
}

sol() {
  local fraction
  fraction=$(printf '%09d' $(($1 % lamports_per_sol)) | sed 's/0*$//')
  echo "$(($1 / lamports_per_sol))${fraction:+.$fraction}"
}

floor_lamports=$(lamports "$floor" TOPUP_FLOOR)
target_lamports=$(lamports "$target" TOPUP_TARGET)
if ((target_lamports < floor_lamports)); then
  echo "TOPUP_TARGET $target is below TOPUP_FLOOR $floor" >&2
  exit 2
fi
genesis=$(solana genesis-hash --url "$url")
if [ "$genesis" != "$devnet_genesis" ]; then
  echo "refusing: $url is not devnet, its genesis hash is $genesis; the top-up sends devnet SOL only" >&2
  exit 1
fi
held=$(solana balance "$faucet" --url "$url" --lamports)
held="${held%% *}"
if ((held >= floor_lamports)); then
  echo "the faucet $faucet holds $(sol "$held") SOL, at least the floor of $(sol "$floor_lamports") SOL; nothing sent"
  exit 0
fi
amount=$((target_lamports - held))
from=$(solana address --keypair "$keypair")
if ((yes == 0)); then
  echo "would send $(sol "$amount") SOL from $from to the faucet $faucet, which holds $(sol "$held") SOL, to reach $(sol "$target_lamports") SOL; run again with --yes to send"
  exit 0
fi
signature=$(solana transfer --url "$url" --keypair "$keypair" --allow-unfunded-recipient --output json "$faucet" "$(sol "$amount")" | sed -n 's/.*"signature": *"\([1-9A-HJ-NP-Za-km-z]*\)".*/\1/p')
if [ -z "$signature" ]; then
  echo "the transfer printed no signature" >&2
  exit 1
fi
echo "sent $(sol "$amount") SOL from $from to the faucet $faucet: https://explorer.solana.com/tx/$signature?cluster=devnet"
