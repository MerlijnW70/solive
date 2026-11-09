#!/usr/bin/env bash
set -euo pipefail
refuse() {
  echo "refusing: $1" >&2
  exit 2
}
setting() {
  if [[ ! "$2" =~ $3 ]]; then
    refuse "$1 is $4, not \"$2\""
  fi
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
setting FAUCET_NOW "$now" '^[0-9]+$' "a whole number of seconds since 1970"
settle_secs="${FAUCET_SETTLE:-5}"
setting FAUCET_SETTLE "$settle_secs" '^[0-9]{1,3}$' "a whole number of seconds below 1000"
finalize_secs="${FAUCET_FINALIZE:-60}"
setting FAUCET_FINALIZE "$finalize_secs" '^[0-9]{1,3}$' "a whole number of seconds below 1000"
scan_pages="${FAUCET_SCAN_PAGES:-100}"
setting FAUCET_SCAN_PAGES "$scan_pages" '^[1-9][0-9]{0,3}$' "a whole number of history pages from 1 to 9999"
run_id="${GITHUB_RUN_ID:-}"
setting GITHUB_RUN_ID "$run_id" '^[0-9A-Za-z_-]{1,40}$' "the id of the faucet workflow run, as only .github/workflows/faucet.yml runs the faucet, one run at a time"
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
check_secs=$((2 * 3600))
pending_secs=$((7 * 86400))
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
    answer "Refused: $2 after $max_parks tries. Nothing was sent. File a new request to try again." "not planned"
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
  local tag sig more
  scan_state=error
  scan_hits=()
  scan_seen=" "
  scan_over=0
  while read -r tag sig more; do
    case "$tag" in
      state) scan_state="$sig" ;;
      over) scan_over="$sig" ;;
      seen) scan_seen+="$sig:$more " ;;
      hit) scan_hits+=("$sig $more") ;;
    esac
  done < <(FAUCET_RPC="$rpc" FAUCET_SCAN_PAGES="$scan_pages" parse scan "$@")
}

source "$here/faucet-settle.sh"

busy() {
  local closed open marked
  closed=$(gh issue list --label faucet-sent --state closed --limit 1000 --json closedAt --jq "[.[] | select(.closedAt >= \"$day_ago\")] | length")
  closed=$(count "$closed")
  open=$(gh issue list --label faucet-sent --state open --limit 1000 --json number --jq length)
  open=$(count "$open")
  marked=$(gh issue list --label faucet-pending --state all --limit 1000 --json updatedAt --jq "[.[] | select(.updatedAt >= \"$day_ago\")] | length")
  marked=$(count "$marked")
  echo $((closed + open + marked))
}

send() {
  local floor latest blockhash last slot payer key anchor signed signature text before first copies entry total lost memo="faucet request $issue" waited=0 unread="the faucet could not read its devnet history to check that nothing was sent for this request"
  if ! floor=$(solana block-height --url "$url" --commitment finalized 2> /dev/null) || [[ ! "$floor" =~ ^[0-9]+$ ]] ||
    ! latest=$(call getLatestBlockhash '[{"commitment":"confirmed"}]') ||
    ! read -r blockhash last slot < <(printf '%s' "$latest" | parse latest) ||
    [ "$last" -lt "$floor" ] || [ "$last" -gt $((floor + 1000)) ]; then
    later "The faucet could not reach devnet to send to \`$address\`. Nothing was sent, and this request does not count toward your one request a day." "the faucet could not reach devnet to send to \`$address\`"
  fi
  key=$(solana address --keypair "$keypair")
  scan "$key" - "$created" - "$memo" "$amount" -
  if [ "${#scan_hits[@]}" -gt 0 ]; then
    deliver "${scan_hits[0]%% *}" "${scan_hits[0]#* }"
  fi
  if [ "$scan_state" != covered ] || ! anchor=$(FAUCET_RPC="$rpc" parse newest "$key"); then
    later "The faucet could not read its devnet history to check that nothing was sent for this request yet. Nothing was sent, and this request does not count toward your one request a day." "$unread"
  fi
  lost=$(unrecorded)
  if [ "$scan_over" -gt 0 ] && [ -n "$lost" ]; then
    later "The faucet lost its record of transaction $lost for this request, and more transfers to its wallet carry this request's memo than it verifies, so it cannot prove that transaction never landed. Nothing was sent, and this request does not count toward your one request a day." "the faucet lost its record of transaction $lost for this request and could not prove it never landed"
  fi
  if [ "$scan_over" -gt 0 ]; then
    echo "request $issue: $scan_over entries with its memo were not verified; its own records list every faucet transfer for it" >&2
  fi
  signed=$(solana transfer --url "$url" --keypair "$keypair" --sign-only --blockhash "$blockhash" --with-memo "$memo" --allow-unfunded-recipient --output json "$address" "$amount_sol" | parse signer)
  read -r payer signature <<< "$signed"
  if [ "$payer" != "$key" ]; then
    echo "the transfer was signed by $payer, not the faucet wallet $key" >&2
    exit 1
  fi
  text="Sending $amount_sol devnet SOL to \`$address\` from \`$payer\` in transaction $signature, signed at $(date -u -d "@$now" +%Y-%m-%dT%H:%M:%SZ) after slot $slot and wallet transaction $anchor, valid until block height $last. The faucet checks this transaction before it sends again."
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
      [ "$(printf '%s' "$status" | parse status)" = landed ]; then
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

body_address() {
  local text found=()
  text=$(gh issue view "$issue" --json body --jq .body)
  mapfile -t found < <(printf '%s\n' "$text" | tr -d '\r' | grep -Ex "[[:space:]]*$base58{32,44}[[:space:]]*" | sed 's/[[:space:]]//g' | sort -u)
  if [ "${#found[@]}" -eq 1 ]; then
    echo "${found[0]}"
  fi
}

serve() {
  settle "$1"
  read -r parks until < <(printf '%s' "$view" | parse parks)
  if [ -n "$until" ] && [ "$now" -lt "$(date -u -d "$until" +%s)" ]; then
    echo "Parked: request $issue waits until $until."
    exit 0
  fi
  author=$(gh issue view "$issue" --json author --jq .author.login)
  if ! [[ "$author" =~ ^[A-Za-z0-9-]{1,39}$ ]]; then
    answer "Refused: this GitHub account name is not one the faucet can check." "not planned"
  fi
  address=$(body_address)
  if [ -z "$address" ]; then
    answer "Refused: put exactly one wallet address in the request, as \`solana address\` prints it." "not planned"
  fi
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
    later "The faucet could not reach devnet to check \`$address\`. Nothing was sent, and this request does not count toward your one request a day." "the faucet could not reach devnet to check \`$address\`"
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
undecided=0
declare -A handled=()
tally() {
  case "$code" in
    0 | 11) ;;
    10) held_back=1 ;;
    12) undecided=1 ;;
    *)
      failed=1
      echo "request $issue failed" >&2
      ;;
  esac
}
for issue in "${held_issues[@]}"; do
  isolated settle_only "$issue"
  tally
  if [ "$code" != 11 ]; then
    handled[$issue]=1
  fi
done
for issue in "${open[@]}"; do
  if [ -z "${handled[$issue]:-}" ]; then
    isolated serve "$issue"
    tally
  fi
done
if [ "$failed" -ne 0 ]; then
  exit 1
fi
if [ "$undecided" -ne 0 ]; then
  exit 4
fi
if [ "$held_back" -ne 0 ]; then
  exit 3
fi
exit 0
