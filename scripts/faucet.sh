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

inspect() {
  BOT="$bot" node -e '
let text = "";
process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
  const view = JSON.parse(text);
  const [mode, arg] = process.argv.slice(1);
  const mine = (view.comments ?? []).filter((c) => c.author?.login === process.env.BOT).map((c) => String(c.body ?? ""));
  if (mode === "records") {
    for (const body of mine) {
      const found = /^Sending \S+ devnet SOL to `([1-9A-HJ-NP-Za-km-z]{32,44})` in transaction ([1-9A-HJ-NP-Za-km-z]{64,88}), valid until block height (\d{1,15})\./.exec(body);
      if (found) console.log(found[2] + " " + found[1] + " " + found[3]);
    }
  } else if (mode === "parks") {
    const marks = [];
    for (const body of mine) {
      const found = /Retry after: (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)/.exec(body);
      if (found && Number.isFinite(Date.parse(found[1]))) marks.push(found[1]);
    }
    console.log(marks.length + " " + (marks.at(-1) ?? ""));
  } else if (mode === "labelled") {
    console.log((view.labels ?? []).some((label) => label.name === arg) ? "yes" : "no");
  } else if (mode === "said") {
    console.log(mine.some((body) => body.trim() === arg) ? "yes" : "no");
  } else {
    process.exit(1);
  }
});
' "$@"
}

status_of() {
  node -e '
let text = "";
process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
  let status;
  try { status = JSON.parse(text); } catch { console.log("unknown"); return; }
  const level = status?.confirmationStatus;
  const failed = status?.err !== undefined && status?.err !== null;
  if (level === null && !failed && "confirmationStatus" in status) console.log("none");
  else if ((level === "confirmed" || level === "finalized") && !failed) console.log("landed");
  else if (level === "finalized" && failed) console.log("failed");
  else console.log("unknown");
});
'
}

latest_of() {
  node -e '
let text = "";
process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
  const value = JSON.parse(text).result?.value;
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(value?.blockhash)) || !Number.isSafeInteger(value?.lastValidBlockHeight) || value.lastValidBlockHeight < 0) process.exit(1);
  console.log(value.blockhash + " " + value.lastValidBlockHeight);
});
'
}

signer_of() {
  node -e '
let text = "";
process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
  const signers = JSON.parse(text).signers;
  const found = Array.isArray(signers) && signers.length === 1 ? /^([1-9A-HJ-NP-Za-km-z]{32,44})=([1-9A-HJ-NP-Za-km-z]{64,88})$/.exec(signers[0]) : null;
  if (!found) process.exit(1);
  console.log(found[1] + " " + found[2]);
});
'
}

key_bytes() {
  node -e '
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
let value = 0n;
for (const c of process.argv[1]) value = value * 58n + BigInt(alphabet.indexOf(c));
let bytes = 0;
for (; value > 0n; value >>= 8n) bytes += 1;
for (const c of process.argv[1]) { if (c !== "1") break; bytes += 1; }
console.log(bytes);
' "$1"
}

count() {
  if [[ ! "$1" =~ ^[0-9]+$ ]]; then
    echo "gh printed \"$1\" where a count belongs" >&2
    exit 1
  fi
  echo "$1"
}

busy() {
  local closed open
  closed=$(gh issue list --label faucet-sent --state closed --limit 200 --json closedAt --jq "[.[] | select(.closedAt >= \"$day_ago\")] | length")
  closed=$(count "$closed")
  open=$(gh issue list --state open --label faucet --limit 100 --json labels --jq '[.[] | select(any(.labels[]; .name == "faucet-sent" or .name == "faucet-pending"))] | length')
  open=$(count "$open")
  echo $((closed + open))
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
  said=$(printf '%s' "$view" | inspect said "$text")
  if [ "$said" != yes ]; then
    gh issue comment "$issue" --body "$text" > /dev/null
  fi
  gh issue edit "$issue" --add-label faucet-sent --remove-label faucet-pending > /dev/null
  gh issue close "$issue" --reason completed > /dev/null
  echo "$text"
  exit 0
}

resolve() {
  local height entry sig to last status waiting=""
  height=$(solana block-height --url "$url" --commitment finalized 2> /dev/null) || height=""
  [[ "$height" =~ ^[0-9]+$ ]] || height=""
  outcome=dead
  for entry in "${records[@]}"; do
    read -r sig to last <<< "$entry"
    if status=$(solana confirm --url "$url" --commitment confirmed --output json "$sig" 2> /dev/null); then
      status=$(printf '%s' "$status" | status_of)
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
      none)
        if [ -z "$height" ] || [ "$height" -le $((last + expiry_margin)) ]; then
          waiting="$sig"
        fi
        ;;
      *) waiting="$sig" ;;
    esac
  done
  if [ -n "$waiting" ]; then
    outcome=undecided
    waiting_sig="$waiting"
  fi
}

load() {
  local found
  view=$(gh issue view "$issue" --json comments,labels)
  found=$(printf '%s' "$view" | inspect records)
  records=()
  if [ -n "$found" ]; then
    mapfile -t records <<< "$found"
  fi
}

settle() {
  issue="$1"
  load
  if [ "${#records[@]}" -eq 0 ]; then
    return 0
  fi
  resolve
  case "$outcome" in
    landed) deliver "$landed_sig" "$landed_to" ;;
    undecided)
      echo "Pending: request $issue waits for transaction $waiting_sig to land or expire."
      exit 10
      ;;
  esac
  unpend
  if [ "${#records[@]}" -ge "$max_sends" ]; then
    read -r _ to _ <<< "${records[-1]}"
    answer "Refused: the faucet tried $max_sends times to send to \`$to\` and no transfer landed. Nothing was sent. File a new request to try again." "not planned"
  fi
}

settle_only() {
  settle "$1"
  exit 11
}

send() {
  local floor latest blockhash last signed payer signature text before first copies entry memo="faucet request $issue"
  if ! floor=$(solana block-height --url "$url" --commitment finalized 2> /dev/null) || [[ ! "$floor" =~ ^[0-9]+$ ]] ||
    ! latest=$(curl -sS --max-time 30 -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getLatestBlockhash","params":[{"commitment":"confirmed"}]}' "$rpc" 2> /dev/null) ||
    ! read -r blockhash last < <(printf '%s' "$latest" | latest_of) ||
    [ "$last" -lt "$floor" ] || [ "$last" -gt $((floor + 1000)) ]; then
    later "The faucet could not reach devnet to send to \`$address\`. Nothing was sent, and this request does not count toward your one request a day."
  fi
  signed=$(solana transfer --url "$url" --keypair "$keypair" --sign-only --blockhash "$blockhash" --with-memo "$memo" --allow-unfunded-recipient --output json "$address" "$amount_sol" | signer_of)
  read -r payer signature <<< "$signed"
  text="Sending $amount_sol devnet SOL to \`$address\` in transaction $signature, valid until block height $last. The faucet checks this transaction before it sends again."
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
  if ! timeout "$send_secs" solana transfer --url "$url" --keypair "$keypair" --blockhash "$blockhash" --from "$payer" --fee-payer "$payer" --signer "$payer=$signature" --with-memo "$memo" --allow-unfunded-recipient --output json "$address" "$amount_sol" > /dev/null; then
    echo "request $issue: the transfer ended without a confirmation; the faucet checks transaction $signature instead" >&2
  fi
  resolve
  if [ "$outcome" = landed ]; then
    deliver "$landed_sig" "$landed_to"
  fi
  echo "Pending: request $issue waits for transaction $signature to land or expire."
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
  created=$(gh api "users/$author" --jq .created_at)
  if [ $((now - $(date -u -d "$created" +%s))) -lt "$min_age" ]; then
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
  set +e
  (
    set -eE
    trap 'exit 1' ERR
    "$@"
  )
  code=$?
  set -e
}

untagged=$(gh issue list --state open --limit 100 --search 'in:title "Devnet SOL" -label:faucet' --json number,title --jq '.[] | select(.title == "Devnet SOL") | .number')
for issue in $(printf '%s\n' "$untagged" | grep -Ex '[0-9]+'); do
  gh issue edit "$issue" --add-label faucet > /dev/null
done
waiting=$(gh issue list --label faucet --state open --limit 100 --json number,labels --jq '.[] | select(all(.labels[]; .name != "faucet-sent")) | .number')
mapfile -t open < <(printf '%s\n%s\n' "$waiting" "$untagged" | grep -Ex '[0-9]+' | sort -nu)
pending=""
if [ "${#open[@]}" -gt 0 ]; then
  pending=" $(gh issue list --label faucet-pending --state open --limit 100 --json number --jq '.[].number' | tr '\n' ' ')"
fi
failed=0
held_back=0
declare -A handled=()
for issue in "${open[@]}"; do
  if [[ "$pending" == *" $issue "* ]]; then
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
  fi
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
