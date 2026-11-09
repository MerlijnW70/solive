#!/usr/bin/env bash
set -euo pipefail
refuse() {
  echo "refusing: $1" >&2
  exit 2
}
keypair="${FAUCET_KEYPAIR:-}"
if [ -z "$keypair" ]; then
  refuse "FAUCET_KEYPAIR names the key file of the faucet wallet, and it is empty"
fi
url="${FAUCET_URL:-devnet}"
case "$url" in
  devnet | d) rpc=https://api.devnet.solana.com ;;
  testnet | t) rpc=https://api.testnet.solana.com ;;
  localhost | l) rpc=http://localhost:8899 ;;
  http://* | https://*) rpc="$url" ;;
  *) refuse "FAUCET_URL is devnet, testnet, localhost or an http(s) address, not \"$url\"" ;;
esac
now="${FAUCET_NOW:-$(date -u +%s)}"
if [[ ! "$now" =~ ^[0-9]+$ ]]; then
  refuse "FAUCET_NOW is a whole number of seconds since 1970, not \"$now\""
fi
settle_secs="${FAUCET_SETTLE:-5}"
if [[ ! "$settle_secs" =~ ^[0-9]{1,3}$ ]]; then
  refuse "FAUCET_SETTLE is a whole number of seconds below 1000, not \"$settle_secs\""
fi
finalize_secs="${FAUCET_FINALIZE:-60}"
if [[ ! "$finalize_secs" =~ ^[0-9]{1,3}$ ]]; then
  refuse "FAUCET_FINALIZE is a whole number of seconds below 1000, not \"$finalize_secs\""
fi
run_id="${GITHUB_RUN_ID:-}"
if [[ ! "$run_id" =~ ^[0-9A-Za-z_-]{1,40}$ ]]; then
  refuse "GITHUB_RUN_ID is empty or malformed; the faucet runs only inside .github/workflows/faucet.yml, which runs one faucet at a time"
fi
here=$(cd "$(dirname "$0")" && pwd)
workflow_text=$(cat "$here/../.github/workflows/faucet.yml" 2> /dev/null) || workflow_text=""
if [[ "$workflow_text" != *$'concurrency:\n  group: faucet\n  cancel-in-progress: false\n'* ]]; then
  refuse ".github/workflows/faucet.yml does not hold the faucet concurrency group, so two runs could overlap"
fi
set -E
trap 'exit 1' ERR
trap 'exit 1' TERM INT
amount_sol=0.5
amount=500000000
funded=1000000000
reserve=1000000000
min_age=$((7 * 86400))
daily=50
retry_secs=$((3 * 3600))
bot=github-actions
max_parks=8
max_sends=3
expiry_margin=150
send_secs=180
max_pages=20
page_size=1000
base58='[1-9A-HJ-NP-Za-km-z]'
day_ago=$(date -u -d "@$((now - 86400))" +%Y-%m-%dT%H:%M:%SZ)

answer() {
  gh issue comment "$issue" --body "$1" > /dev/null
  gh issue close "$issue" --reason "$2" > /dev/null
  echo "$1"
  exit 0
}

later() {
  if [ "$parks" -ge "$max_parks" ]; then
    answer "Refused: the faucet could not reach devnet to check \`$address\` after $max_parks tries. Nothing was sent. File a new request to try again." "not planned"
  fi
  retry_at=$(date -u -d "@$((now + retry_secs))" +%Y-%m-%dT%H:%M:%SZ)
  message="$1 The request stays open. Retry after: $retry_at."
  gh issue comment "$issue" --body "$message" > /dev/null
  echo "$message"
  exit 0
}

parse() {
  BOT="$bot" node "$here/faucet-parse.mjs" "$@"
}

inspect() {
  parse "$@"
}

json_of() {
  parse "$@"
}

key_bytes() {
  parse key-bytes "$1"
}

count() {
  if [[ ! "$1" =~ ^[0-9]+$ ]]; then
    echo "gh printed \"$1\" where a count belongs" >&2
    exit 1
  fi
  echo "$1"
}

call() {
  curl -sS --max-time 30 -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" "$rpc" 2> /dev/null
}

scan() {
  local payer="$1" kind="$2" bound="$3" floor="$4" before="" pages=0 page parsed tag sig slot time failed hit size last options
  scan_state=error
  scan_hits=()
  scan_seen=" "
  while [ "$pages" -lt "$max_pages" ]; do
    options="{\"limit\":$page_size,\"commitment\":\"finalized\""
    if [ -n "$floor" ]; then
      options+=",\"minContextSlot\":$floor"
    fi
    if [ -n "$before" ]; then
      options+=",\"before\":\"$before\""
    fi
    page=$(call getSignaturesForAddress "[\"$payer\",$options}]") || return 0
    parsed=$(printf '%s' "$page" | json_of history "faucet request $issue") || return 0
    size=""
    while read -r tag sig slot time failed hit; do
      case "$tag" in
        error) return 0 ;;
        entry)
          scan_seen+="$sig:$failed "
          if [ "$hit" = 1 ] && [ "$failed" = 0 ]; then
            scan_hits+=("$sig")
          fi
          if { [ "$kind" = slot ] && [ "$slot" -le "$bound" ]; } || { [ "$kind" = time ] && [ "$time" -ge 0 ] && [ "$time" -lt "$bound" ]; }; then
            scan_state=covered
          fi
          ;;
        *)
          size="$tag"
          last="$sig"
          ;;
      esac
    done <<< "$parsed"
    if [ "$scan_state" = covered ]; then
      return 0
    fi
    if [ -z "$size" ] || [ "$size" -lt "$page_size" ]; then
      scan_state=short
      return 0
    fi
    before="$last"
    pages=$((pages + 1))
  done
}

busy() {
  local closed open marked
  closed=$(gh issue list --label faucet-sent --state closed --limit 1000 --json closedAt --jq "[.[] | select(.closedAt >= \"$day_ago\")] | length")
  closed=$(count "$closed")
  open=$(gh issue list --label faucet-sent --state open --limit 1000 --json number --jq length)
  open=$(count "$open")
  marked=$(gh issue list --label faucet-pending --state all --limit 1000 --json number --jq length)
  marked=$(count "$marked")
  echo $((closed + open + marked))
}

load() {
  local found facts
  view=$(gh issue view "$issue" --json comments,labels,state,createdAt)
  facts=$(printf '%s' "$view" | inspect facts)
  read -r state created <<< "$facts"
  found=$(printf '%s' "$view" | inspect records)
  records=()
  if [ -n "$found" ]; then
    mapfile -t records <<< "$found"
  fi
  markers=" $(printf '%s' "$view" | inspect markers) "
}

unpend() {
  local labelled
  labelled=$(printf '%s' "$view" | inspect labelled faucet-pending)
  if [ "$labelled" = yes ]; then
    gh issue edit "$issue" --remove-label faucet-pending > /dev/null
  fi
}

deliver() {
  local text="Sent $amount_sol devnet SOL to \`$2\`: https://explorer.solana.com/tx/$1?cluster=devnet" said
  if [ -z "$2" ]; then
    text="Sent $amount_sol devnet SOL: https://explorer.solana.com/tx/$1?cluster=devnet"
  fi
  said=$(printf '%s' "$view" | inspect said "$text")
  if [ "$said" != yes ]; then
    gh issue comment "$issue" --body "$text" > /dev/null
  fi
  gh issue edit "$issue" --add-label faucet-sent --remove-label faucet-pending > /dev/null
  if [ "$state" = open ]; then
    gh issue close "$issue" --reason completed > /dev/null
  fi
  echo "$text"
  exit 0
}

tries() {
  local entry sig total=0
  for entry in "${records[@]}"; do
    sig="${entry%% *}"
    if [[ "$markers" == *" $sig "* ]]; then
      total=$((total + 1))
    fi
  done
  echo "$total"
}

resolve() {
  local entry sig to payer slot last status latest final_valid final_slot height lowest="" open_entries=()
  outcome=dead
  waiting_sig=""
  for entry in "${records[@]}"; do
    read -r sig to payer slot last <<< "$entry"
    if status=$(solana confirm --url "$url" --commitment finalized --output json "$sig" 2> /dev/null); then
      status=$(printf '%s' "$status" | json_of status)
    else
      status=unknown
    fi
    case "$status" in
      landed)
        outcome=landed
        landed_sig="$sig"
        landed_to="$to"
        return 0
        ;;
      failed) ;;
      *)
        open_entries+=("$entry")
        if [ -z "$lowest" ] || [ "$slot" -lt "$lowest" ]; then
          lowest="$slot"
        fi
        ;;
    esac
  done
  if [ "${#open_entries[@]}" -eq 0 ]; then
    return 0
  fi
  outcome=undecided
  waiting_sig="${open_entries[0]%% *}"
  latest=$(call getLatestBlockhash '[{"commitment":"finalized"}]') || return 0
  read -r _ final_valid final_slot < <(printf '%s' "$latest" | json_of latest) || return 0
  height=$((final_valid - 150))
  read -r _ _ payer _ _ <<< "${open_entries[0]}"
  scan "$payer" slot "$lowest" "$final_slot"
  if [ "$scan_state" != covered ]; then
    return 0
  fi
  outcome=dead
  for entry in "${open_entries[@]}"; do
    read -r sig to payer slot last <<< "$entry"
    if [[ "$scan_seen" == *" $sig:0 "* ]]; then
      outcome=landed
      landed_sig="$sig"
      landed_to="$to"
      return 0
    fi
    if [[ "$scan_seen" != *" $sig:1 "* ]] && [ "$height" -le $((last + expiry_margin)) ]; then
      outcome=undecided
      waiting_sig="$sig"
    fi
  done
  if [ "$outcome" = dead ] && [ "${#scan_hits[@]}" -gt 0 ]; then
    outcome=landed
    landed_sig="${scan_hits[0]}"
    read -r _ landed_to _ <<< "${records[-1]}"
  fi
}

orphan() {
  local payer
  payer=$(solana address --keypair "$keypair")
  scan "$payer" time "$created" ""
  if [ "${#scan_hits[@]}" -gt 0 ]; then
    deliver "${scan_hits[0]}" ""
  fi
}

settle() {
  local labelled
  issue="$1"
  load
  if [ "${#records[@]}" -eq 0 ]; then
    labelled=$(printf '%s' "$view" | inspect labelled faucet-pending)
    if [ "$labelled" = yes ]; then
      orphan
      echo "Pending: request $issue carries faucet-pending but no transfer record, and devnet shows no landed transfer for it; a maintainer checks and removes the label."
      exit 10
    fi
    return 0
  fi
  resolve
  case "$outcome" in
    landed) deliver "$landed_sig" "$landed_to" ;;
    undecided)
      echo "Pending: request $issue waits for transaction $waiting_sig to finalize or for devnet to show it can no longer land."
      exit 10
      ;;
  esac
  unpend
  if [ "$state" != open ]; then
    gh issue comment "$issue" --body "Nothing was sent: this request was closed before its transfer landed." > /dev/null
    echo "Closed: request $issue was closed before its transfer landed; nothing was sent."
    exit 0
  fi
  if [ "$(tries)" -ge "$max_sends" ]; then
    read -r _ to _ <<< "${records[-1]}"
    answer "Refused: the faucet tried $max_sends times to send to \`$to\` and no transfer landed. Nothing was sent. File a new request to try again." "not planned"
  fi
}

settle_only() {
  settle "$1"
  exit 11
}

send() {
  local floor latest blockhash last slot payer key signed signature text before first copies entry total memo="faucet request $issue" waited=0
  if ! floor=$(solana block-height --url "$url" --commitment finalized 2> /dev/null) || [[ ! "$floor" =~ ^[0-9]+$ ]] ||
    ! latest=$(call getLatestBlockhash '[{"commitment":"confirmed"}]') ||
    ! read -r blockhash last slot < <(printf '%s' "$latest" | json_of latest) ||
    [ "$last" -lt "$floor" ] || [ "$last" -gt $((floor + 1000)) ]; then
    later "The faucet could not reach devnet to send to \`$address\`. Nothing was sent, and this request does not count toward your one request a day."
  fi
  key=$(solana address --keypair "$keypair")
  scan "$key" time "$created" ""
  if [ "${#scan_hits[@]}" -gt 0 ]; then
    deliver "${scan_hits[0]}" "$address"
  fi
  if [ "$scan_state" != covered ]; then
    later "The faucet could not read its devnet history to check that nothing was sent for this request yet. Nothing was sent, and this request does not count toward your one request a day."
  fi
  signed=$(solana transfer --url "$url" --keypair "$keypair" --sign-only --blockhash "$blockhash" --with-memo "$memo" --allow-unfunded-recipient --output json "$address" "$amount_sol" | json_of signer)
  read -r payer signature <<< "$signed"
  if [ "$payer" != "$key" ]; then
    echo "the transfer was signed by $payer, not the faucet wallet $key" >&2
    exit 1
  fi
  text="Sending $amount_sol devnet SOL to \`$address\` from \`$payer\` in transaction $signature, signed after slot $slot and valid until block height $last. The faucet checks this transaction before it sends again."
  before=" "
  for entry in "${records[@]}"; do
    before+="${entry%% *} "
  done
  gh issue comment "$issue" --body "$text" > /dev/null
  sleep "$settle_secs"
  load
  first=""
  copies=0
  for entry in "${records[@]}"; do
    if [[ "$before" != *" ${entry%% *} "* ]]; then
      first="${first:-${entry%% *}}"
      if [ "${entry%% *}" = "$first" ]; then
        copies=$((copies + 1))
      fi
    fi
  done
  if [ "$first" != "$signature" ] || [ "$copies" -ne 1 ]; then
    echo "Deferred: another faucet run is sending for request $issue."
    exit 10
  fi
  gh label create faucet-pending --color FBCA04 --description "faucet transfer sent, outcome not yet checked" --force > /dev/null
  gh issue edit "$issue" --add-label faucet-pending > /dev/null
  total=$(busy)
  if [ "$total" -gt "$daily" ]; then
    gh issue edit "$issue" --remove-label faucet-pending > /dev/null
    echo "Deferred: request $issue waits, as other runs reached the daily limit."
    exit 10
  fi
  gh issue comment "$issue" --body "Transaction $signature is on its way." > /dev/null
  if ! timeout "$send_secs" solana transfer --url "$url" --keypair "$keypair" --blockhash "$blockhash" --from "$payer" --fee-payer "$payer" --signer "$payer=$signature" --with-memo "$memo" --allow-unfunded-recipient --output json "$address" "$amount_sol" > /dev/null; then
    echo "request $issue: the transfer ended without a confirmation; the faucet checks transaction $signature instead" >&2
  fi
  while :; do
    if status=$(solana confirm --url "$url" --commitment finalized --output json "$signature" 2> /dev/null) &&
      [ "$(printf '%s' "$status" | json_of status)" = landed ]; then
      deliver "$signature" "$address"
    fi
    if [ "$waited" -ge "$finalize_secs" ]; then
      break
    fi
    sleep 5
    waited=$((waited + 5))
  done
  echo "Pending: request $issue waits for transaction $signature to finalize or for devnet to show it can no longer land."
  exit 10
}

serve() {
  settle "$1"
  read -r parks until < <(printf '%s' "$view" | inspect parks)
  if [ -n "$until" ] && [ "$now" -lt "$(date -u -d "$until" +%s)" ]; then
    echo "Parked: request $issue waits until $until."
    exit 0
  fi
  author=$(gh issue view "$issue" --json author --jq .author.login)
  body=$(gh issue view "$issue" --json body --jq .body)
  if ! [[ "$author" =~ ^[A-Za-z0-9-]{1,39}$ ]]; then
    answer "Refused: this GitHub account name is not one the faucet can check." "not planned"
  fi
  mapfile -t addresses < <(printf '%s\n' "$body" | tr -d '\r' | grep -Ex "[[:space:]]*$base58{32,44}[[:space:]]*" | sed 's/[[:space:]]//g' | sort -u)
  if [ "${#addresses[@]}" -ne 1 ]; then
    answer "Refused: put exactly one wallet address in the request, as \`solana address\` prints it." "not planned"
  fi
  address="${addresses[0]}"
  if [ "$(key_bytes "$address")" != 32 ]; then
    answer "Refused: \`$address\` is not a valid wallet address." "not planned"
  fi
  created_at=$(gh api "users/$author" --jq .created_at)
  if [ $((now - $(date -u -d "$created_at" +%s))) -lt "$min_age" ]; then
    answer "Refused: the faucet serves GitHub accounts at least 7 days old. Request devnet SOL at https://faucet.solana.com instead." "not planned"
  fi
  earlier=$(gh issue list --author "$author" --label faucet --state all --limit 100 --json number,createdAt --jq "[.[] | select(.number < $issue and .createdAt >= \"$day_ago\")] | length")
  earlier=$(count "$earlier")
  if [ "$earlier" -gt 0 ]; then
    answer "Refused: one request per GitHub account per day. Try again tomorrow." "not planned"
  fi
  total=$(busy)
  if [ "$total" -ge "$daily" ]; then
    answer "Refused: the faucet sent its daily limit. Try again tomorrow, or request devnet SOL at https://faucet.solana.com." "not planned"
  fi
  if ! held=$(solana balance "$address" --url "$url" --lamports 2> /dev/null); then
    later "The faucet could not reach devnet to check \`$address\`. Nothing was sent, and this request does not count toward your one request a day."
  fi
  if [ "${held%% *}" -ge "$funded" ]; then
    answer "Refused: \`$address\` already holds 1 devnet SOL or more." "not planned"
  fi
  left=$(solana balance --keypair "$keypair" --url "$url" --lamports)
  if [ "${left%% *}" -lt $((amount + reserve)) ]; then
    answer "Refused: the faucet is running low. Request devnet SOL at https://faucet.solana.com instead." "not planned"
  fi
  send
}

isolated() {
  trap - ERR
  set +e
  (
    set -eE
    trap 'exit 1' ERR
    "$@"
  )
  code=$?
  set -e
  trap 'exit 1' ERR
}

others=$(gh run list --workflow faucet.yml --status in_progress --limit 100 --json databaseId --jq '.[].databaseId')
for other in $others; do
  if [ "$other" != "$run_id" ]; then
    echo "Deferred: faucet run $other is in progress, so this run sends nothing."
    exit 3
  fi
done
untagged=$(gh issue list --state open --limit 100 --search 'in:title "Devnet SOL" -label:faucet' --json number,title --jq '.[] | select(.title == "Devnet SOL") | .number')
for issue in $(printf '%s\n' "$untagged" | grep -Ex '[0-9]+'); do
  gh issue edit "$issue" --add-label faucet > /dev/null
done
waiting=$(gh issue list --label faucet --state open --limit 100 --json number,labels --jq '.[] | select(all(.labels[]; .name != "faucet-sent")) | .number')
pending=$(gh issue list --label faucet-pending --state all --limit 1000 --json number --jq '.[].number')
mapfile -t open < <(printf '%s\n%s\n' "$waiting" "$untagged" | grep -Ex '[0-9]+' | sort -nu)
mapfile -t held_issues < <(printf '%s\n' "$pending" | grep -Ex '[0-9]+' | sort -nu)
failed=0
held_back=0
declare -A handled=()
for issue in "${held_issues[@]}"; do
  isolated settle_only "$issue"
  case "$code" in
    11) ;;
    10) handled[$issue]=1 held_back=1 ;;
    0) handled[$issue]=1 ;;
    *)
      handled[$issue]=1 failed=1
      echo "request $issue failed" >&2
      ;;
  esac
done
for issue in "${open[@]}"; do
  if [ -n "${handled[$issue]:-}" ]; then
    continue
  fi
  isolated serve "$issue"
  case "$code" in
    0) ;;
    10) held_back=1 ;;
    *)
      failed=1
      echo "request $issue failed" >&2
      ;;
  esac
done
if [ "$failed" -ne 0 ]; then
  exit 1
fi
if [ "$held_back" -ne 0 ]; then
  exit 3
fi
exit 0
