#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
usage="usage: idl.sh devnet|mainnet-beta|<https rpc url> [--multisig <address> | --check]"
mainnet_genesis="5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
case "${1:-}" in
  devnet) url="https://api.devnet.solana.com"; genesis="EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" ;;
  mainnet-beta) url="https://api.mainnet-beta.solana.com"; genesis="$mainnet_genesis" ;;
  https://*) url="$1"; genesis="" ;;
  *) echo "$usage" >&2; exit 2 ;;
esac
mode=write
multisig=""
case "${2:-}" in
  "") ;;
  --check) mode=check ;;
  --multisig) mode=multisig; multisig="${3:-}" ;;
  *) echo "$usage" >&2; exit 2 ;;
esac
if [[ "$mode" == multisig && -z "$multisig" ]]; then
  echo "$usage" >&2
  exit 2
fi
if ! served="$(solana genesis-hash --url "$url")" || [[ -z "$served" ]]; then
  echo "refusing: could not read the genesis hash of $url" >&2
  exit 1
fi
if [[ -n "$genesis" && "$served" != "$genesis" ]]; then
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
pmp=(env NO_COLOR=1 npx -y @solana-program/program-metadata@0.10.0 --keypair "$authority" --rpc "$url")
if [[ "$served" == "$mainnet_genesis" && "$mode" != check ]]; then
  read -r -p "type the program id $program to publish its IDL on mainnet-beta: " typed
  if [[ "$typed" != "$program" ]]; then
    echo "refusing: the confirmation did not match" >&2
    exit 1
  fi
fi
if [[ "$mode" == multisig ]]; then
  pnpm --filter @intent-engine/core build > /dev/null
  pnpm --filter @intent-engine/client build > /dev/null
  pnpm --filter @intent-engine/multisig build > /dev/null
  squads=(node packages/multisig/dist/bin.js)
  idl_hash="$(sha256sum "$idl" | cut -c1-64)"
  echo "idl      $idl hashes to $idl_hash"
  vault="$("${squads[@]}" vault --multisig "$multisig" --url "$url" | node -e 'let t="";process.stdin.on("data",(d)=>t+=d).on("end",()=>console.log(JSON.parse(t).vault))')"
  created="$("${pmp[@]}" create-buffer "$idl" --format json)"
  buffer="$(printf '%s\n' "$created" | sed -n 's/.*buffer: *\([1-9A-HJ-NP-Za-km-z]\{32,44\}\).*/\1/p' | head -1)"
  if [[ -z "$buffer" ]]; then
    echo "refusing: no buffer address in the create-buffer output: $created" >&2
    exit 1
  fi
  "${pmp[@]}" set-buffer-authority "$buffer" --new-authority "$vault" >/dev/null
  exported="$("${pmp[@]}" update idl "$program" --buffer "$buffer" --close-buffer "$(solana-keygen pubkey "$authority")" --format json --export "$vault" --export-encoding instruction-list)"
  proposal="$(mktemp)"
  printf '%s\n' "$exported" | node scripts/instruction-list.mjs > "$proposal"
  "${squads[@]}" propose-admin --multisig "$multisig" --keypair "${MULTISIG_MEMBER:-$authority}" --url "$url" --yes -- cat "$proposal"
  echo "buffer   $buffer, now controlled by the vault $vault and closed by the proposal"
  echo "next: two members approve the proposal above with packages/multisig/dist/bin.js approve, which prints the buffer's decoded IDL sha256 as buffer_hash and has to print $idl_hash; one runs execute --expect-buffer-hash $idl_hash, then run bash scripts/idl.sh $1 --check"
  exit 0
fi
if [[ "$mode" == write ]] && ! "${pmp[@]}" write idl "$program" "$idl" --format json; then
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
