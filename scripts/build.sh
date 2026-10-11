#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
keypair="$HOME/.config/intent-engine/program-keypair.json"
mkdir -p target/deploy
if [[ -f "$keypair" ]]; then
  cp "$keypair" target/deploy/intent_engine-keypair.json
fi
bash scripts/sbf.sh
anchor idl build -p intent_engine -o idl/intent_engine.json >&2
