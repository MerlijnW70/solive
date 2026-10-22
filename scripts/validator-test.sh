#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
engine="${INTENT_ENGINE_SO:-$PWD/target/deploy/intent_engine.so}"
program="$(sed -n 's/^intent_engine = "\(.*\)"/\1/p' Anchor.toml | head -n 1)"
span=40
if [[ ! -f "$engine" ]]; then
  echo "build the program first: bash scripts/build.sh" >&2
  exit 2
fi
if [[ ! -d node_modules ]]; then
  pnpm install --frozen-lockfile
fi
pnpm --filter @intent-engine/core build >/dev/null
work="$(mktemp -d)"
validator=""
stop() {
  if [[ -n "$validator" ]] && kill -0 "$validator" 2>/dev/null; then
    kill -TERM "$validator" 2>/dev/null || true
    for _ in $(seq 1 50); do
      kill -0 "$validator" 2>/dev/null || break
      sleep 0.2
    done
    kill -KILL "$validator" 2>/dev/null || true
    wait "$validator" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap stop EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
free_base() {
  local used base port clash
  used="$(ss -Htuan | awk '{print $5}' | sed 's/.*://')"
  for _ in $(seq 1 200); do
    base=$((20000 + RANDOM % 40000))
    clash=0
    for port in $(seq "$base" $((base + span))); do
      if grep -qx "$port" <<<"$used"; then
        clash=1
        break
      fi
    done
    if [[ "$clash" == 0 ]]; then
      echo "$base"
      return
    fi
  done
  echo "no free port range found" >&2
  return 1
}
answers() {
  curl -sf -m 2 -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "http://127.0.0.1:$1" | grep -q '"ok"'
}
solana-keygen new --no-bip39-passphrase --silent --force -o "$work/authority.json" >/dev/null
for attempt in 1 2 3; do
  base="$(free_base)"
  rm -rf "$work/ledger"
  solana-test-validator \
    --ledger "$work/ledger" --reset --quiet \
    --bind-address 127.0.0.1 \
    --rpc-port "$base" \
    --faucet-port $((base + 2)) \
    --gossip-port $((base + 3)) \
    --dynamic-port-range "$((base + 4))-$((base + span))" \
    --upgradeable-program "$program" "$engine" "$work/authority.json" \
    >"$work/validator.log" 2>&1 &
  validator=$!
  for _ in $(seq 1 120); do
    if answers "$base" || ! kill -0 "$validator" 2>/dev/null; then
      break
    fi
    sleep 0.5
  done
  if answers "$base"; then
    break
  fi
  cat "$work/validator.log" >&2
  kill -KILL "$validator" 2>/dev/null || true
  wait "$validator" 2>/dev/null || true
  validator=""
  if [[ "$attempt" == 3 ]]; then
    echo "solana-test-validator did not answer" >&2
    exit 1
  fi
done
VALIDATOR_URL="http://127.0.0.1:$base" VALIDATOR_AUTHORITY="$work/authority.json" \
  pnpm --filter @intent-engine/client exec vitest run --fsModuleCache test/validator.test.ts
