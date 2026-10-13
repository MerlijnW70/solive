#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
usage="usage: deploy.sh devnet|mainnet-beta|<https rpc url> <sha256 of the CI verifiable build>"
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
program="$(solana-keygen pubkey "$program_keypair")"
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
solana program deploy verifiable/intent_engine.so --program-id "$program_keypair" --upgrade-authority "$authority" --keypair "$authority" --url "$url" --with-compute-unit-price "${DEPLOY_CU_PRICE:-100000}"
deployed="$(solana-verify get-program-hash --url "$url" "$program")"
echo "program  $program"
echo "expected $expected"
echo "deployed $deployed"
[[ "$deployed" == "$expected" ]]
