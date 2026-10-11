#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
roots=(programs/intent_engine/src crates/intent-core/src)
patterns=(
  'init_if_needed'
  'remaining_accounts'
  'realloc'
  '\binvoke(_signed)?\('
  '\[allow\('
  '\bstd::'
)
status=0
for pattern in "${patterns[@]}"; do
  if grep -rnE --include='*.rs' "$pattern" "${roots[@]}"; then
    status=1
  fi
done
shipped=(crates/*/src programs/*/src)
attribute="$(printf '\043')"
if grep -rnE --include='*.rs' "${attribute}"'\[(cfg\([^]]*\b(test|kani)\b|test\]|kani::)|\bmod tests\b' "${shipped[@]}"; then
  echo "tests belong in tests/, tests/svm or tests/proofs, never in shipped src"
  status=1
fi
delegate_users="$(grep -rlE --include='*.rs' 'DELEGATE_SEED|b"delegate"' programs/intent_engine/src | sort | tr '
' ' ')"
if [[ "$delegate_users" != "programs/intent_engine/src/instructions/create_intent_by_agent.rs programs/intent_engine/src/instructions/create_intent_signed.rs programs/intent_engine/src/policy.rs programs/intent_engine/src/state.rs " ]]; then
  echo "delegate seed used outside create_intent_signed, create_intent_by_agent and their shared draw: $delegate_users"
  status=1
fi
exit "$status"
