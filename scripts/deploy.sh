#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
usage="usage: deploy.sh devnet|mainnet-beta|<https rpc url> <sha256 of the CI verifiable build> [--multisig <squads multisig address>]"
mainnet="5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
devnet="EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
case "${1:-}" in
  devnet) url="https://api.devnet.solana.com"; want="$devnet" ;;
  mainnet-beta) url="https://api.mainnet-beta.solana.com"; want="$mainnet" ;;
  https://*) url="$1"; want="" ;;
  *) echo "$usage" >&2; exit 2 ;;
esac
expected="${2:-}"
if [[ ! "$expected" =~ ^[0-9a-f]{64}$ ]]; then
  echo "$usage" >&2
  exit 2
fi
multisig=""
case "$#:${3:-}" in
  2:) ;;
  4:--multisig) multisig="$4" ;;
  *) echo "$usage" >&2; exit 2 ;;
esac
if [[ -n "$multisig" && ! "$multisig" =~ ^[1-9A-HJ-NP-Za-km-z]{32,44}$ ]]; then
  echo "refusing: --multisig takes a base58 address, not $multisig" >&2
  exit 2
fi
actual="$(solana genesis-hash --url "$url")"
if [[ -n "$want" && "$actual" != "$want" ]]; then
  echo "refusing: $url serves genesis $actual, not the $1 cluster" >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "refusing: the working tree has uncommitted changes" >&2
  exit 1
fi
git fetch --quiet origin main
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  echo "refusing: HEAD is not origin/main, so the deployed program could not be verified against the public repository" >&2
  exit 1
fi
authority="${UPGRADE_AUTHORITY:-$HOME/.config/solana/id.json}"
program_keypair="$HOME/.config/intent-engine/program-keypair.json"
program="${PROGRAM_ID:-$(solana-keygen pubkey "$program_keypair")}"
squads=()
vault=""
if [[ -n "$multisig" ]]; then
  pnpm --filter @intent-engine/core build > /dev/null
  pnpm --filter @intent-engine/multisig build > /dev/null
  squads=(node packages/multisig/dist/bin.js)
  vault="$("${squads[@]}" show --multisig "$multisig" --url "$url" | node -e 'let t="";process.stdin.on("data",(d)=>t+=d).on("end",()=>console.log(JSON.parse(t).vault))')"
  current="$(solana program show "$program" --url "$url" --output json | node -e 'let t="";process.stdin.on("data",(d)=>t+=d).on("end",()=>console.log(JSON.parse(t).authority))')"
  if [[ "$current" != "$vault" ]]; then
    echo "refusing: program $program is upgraded by $current, not the vault $vault of multisig $multisig; move the upgrade authority first as docs/maintainers/operations.md describes" >&2
    exit 1
  fi
fi
bash scripts/verify.sh
built="$(cat verifiable/intent_engine.hash)"
if [[ "$built" != "$expected" ]]; then
  echo "refusing: this build hashes to $built, not the expected $expected" >&2
  exit 1
fi
if [[ "$actual" == "$mainnet" ]]; then
  read -r -p "type the program id $program to deploy it to mainnet (genesis $actual): " typed
  if [[ "$typed" != "$program" ]]; then
    echo "refusing: the confirmation did not match" >&2
    exit 1
  fi
fi
price="${DEPLOY_CU_PRICE:-100000}"
if [[ -n "$multisig" ]]; then
  written="$(solana program write-buffer verifiable/intent_engine.so --buffer-authority "$authority" --keypair "$authority" --url "$url" --with-compute-unit-price "$price")"
  buffer="$(printf '%s\n' "$written" | sed -n 's/^Buffer: *\([1-9A-HJ-NP-Za-km-z]\{32,44\}\).*/\1/p')"
  if [[ -z "$buffer" ]]; then
    echo "refusing: no buffer address in the write-buffer output: $written" >&2
    exit 1
  fi
  staged="$(solana-verify get-buffer-hash --url "$url" "$buffer")"
  if [[ "$staged" != "$expected" ]]; then
    echo "refusing: buffer $buffer hashes to $staged, not the expected $expected; nothing was proposed, reclaim its rent with solana program close $buffer" >&2
    exit 1
  fi
  solana program set-buffer-authority "$buffer" --new-buffer-authority "$vault" --buffer-authority "$authority" --keypair "$authority" --url "$url"
  spill="$(solana-keygen pubkey "$authority")"
  "${squads[@]}" propose-upgrade --multisig "$multisig" --program "$program" --buffer "$buffer" --spill "$spill" --keypair "${MULTISIG_MEMBER:-$authority}" --url "$url" --yes
  echo "program  $program"
  echo "buffer   $buffer"
  echo "expected $expected"
  echo "staged   $staged"
  echo "next: members approve the proposal above with packages/multisig/dist/bin.js approve, check it prints buffer_hash $expected, one runs execute --expect-buffer-hash $expected, then run solana-verify get-program-hash --url $url $program"
  exit 0
fi
solana program deploy verifiable/intent_engine.so --program-id "$program_keypair" --upgrade-authority "$authority" --keypair "$authority" --url "$url" --with-compute-unit-price "$price"
deployed="$(solana-verify get-program-hash --url "$url" "$program")"
echo "program  $program"
echo "expected $expected"
echo "deployed $deployed"
[[ "$deployed" == "$expected" ]]
