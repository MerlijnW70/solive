#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
usage="usage: idl.sh devnet|mainnet-beta|<https rpc url>"
case "${1:-}" in
  devnet) url="https://api.devnet.solana.com"; genesis="EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" ;;
  mainnet-beta) url="https://api.mainnet-beta.solana.com"; genesis="5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" ;;
  https://*) url="$1"; genesis="" ;;
  *) echo "$usage" >&2; exit 2 ;;
esac
if [[ -n "$genesis" && "$(solana genesis-hash --url "$url")" != "$genesis" ]]; then
  echo "refusing: $url does not serve the $1 cluster" >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "refusing: the working tree has uncommitted changes" >&2
  exit 1
fi
git fetch --quiet origin main
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  echo "refusing: HEAD is not origin/main, so the published IDL could not be checked against the public repository" >&2
  exit 1
fi
idl="idl/intent_engine.json"
program="$(node -p "require('./$idl').address")"
authority="${UPGRADE_AUTHORITY:-$HOME/.config/solana/id.json}"
pmp=(npx -y @solana-program/program-metadata@0.10.0 --keypair "$authority" --rpc "$url")
if [[ "${1}" == "mainnet-beta" ]]; then
  read -r -p "type the program id $program to publish its IDL on mainnet-beta: " typed
  if [[ "$typed" != "$program" ]]; then
    echo "refusing: the confirmation did not match" >&2
    exit 1
  fi
fi
if ! "${pmp[@]}" write idl "$program" "$idl" --format json; then
  echo "the write did not finish; list what it left with: npx @solana-program/program-metadata@0.10.0 --rpc $url list-buffers" >&2
  echo "a half-written IDL account can only be removed with: npx @solana-program/program-metadata@0.10.0 --keypair $authority --rpc $url close idl $program" >&2
  exit 1
fi
fetched="$(mktemp)"
"${pmp[@]}" fetch idl "$program" --output "$fetched" >/dev/null
node -e "
const fs = require('fs');
const same = JSON.stringify(JSON.parse(fs.readFileSync(process.argv[1], 'utf8'))) === JSON.stringify(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
console.log('program  ' + process.argv[3]);
console.log('on chain ' + (same ? 'matches' : 'DIFFERS FROM') + ' ' + process.argv[2]);
process.exit(same ? 0 : 1);
" "$fetched" "$idl" "$program"
