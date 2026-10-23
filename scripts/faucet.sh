#!/usr/bin/env bash
set -euo pipefail
keypair="${FAUCET_KEYPAIR:?}"
url="${FAUCET_URL:-devnet}"
now="${FAUCET_NOW:-$(date -u +%s)}"
amount_sol=0.5
amount=500000000
funded=1000000000
reserve=1000000000
min_age=$((7 * 86400))
daily=50
day_ago=$(date -u -d "@$((now - 86400))" +%Y-%m-%dT%H:%M:%SZ)

answer() {
  gh issue comment "$issue" --body "$1" > /dev/null
  gh issue close "$issue" --reason "$2" > /dev/null
  echo "$1"
  exit 0
}

later() {
  gh issue comment "$issue" --body "$1" > /dev/null
  gh issue edit "$issue" --remove-label faucet > /dev/null
  echo "$1"
  exit 0
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

serve() {
  issue="$1"
  author=$(gh issue view "$issue" --json author --jq .author.login)
  body=$(gh issue view "$issue" --json body --jq .body)
  if ! [[ "$author" =~ ^[A-Za-z0-9-]{1,39}$ ]]; then
    answer "Refused: this GitHub account name is not one the faucet can check." "not planned"
  fi
  mapfile -t addresses < <(printf '%s\n' "$body" | tr -d '\r' | grep -Ex '[[:space:]]*[1-9A-HJ-NP-Za-km-z]{32,44}[[:space:]]*' | sed 's/[[:space:]]//g' | sort -u)
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
  if [ "$earlier" -gt 0 ]; then
    answer "Refused: one request per GitHub account per day. Try again tomorrow." "not planned"
  fi
  sent=$(gh issue list --label faucet-sent --state closed --limit 200 --json closedAt --jq "[.[] | select(.closedAt >= \"$day_ago\")] | length")
  if [ "$sent" -ge "$daily" ]; then
    answer "Refused: the faucet sent its daily limit. Try again tomorrow, or request devnet SOL at https://faucet.solana.com." "not planned"
  fi
  if ! held=$(solana balance "$address" --url "$url" --lamports 2> /dev/null); then
    later "The faucet could not reach devnet to check \`$address\`. Nothing was sent, and this request does not count toward your one request a day. Open a new request later."
  fi
  if [ "${held%% *}" -ge "$funded" ]; then
    answer "Refused: \`$address\` already holds 1 devnet SOL or more." "not planned"
  fi
  left=$(solana balance --keypair "$keypair" --url "$url" --lamports)
  if [ "${left%% *}" -lt $((amount + reserve)) ]; then
    answer "Refused: the faucet is running low. Request devnet SOL at https://faucet.solana.com instead." "not planned"
  fi
  signature=$(solana transfer --url "$url" --keypair "$keypair" --allow-unfunded-recipient --output json "$address" "$amount_sol" | sed -n 's/.*"signature": *"\([1-9A-HJ-NP-Za-km-z]*\)".*/\1/p')
  if [ -z "$signature" ]; then
    echo "the transfer printed no signature" >&2
    exit 1
  fi
  gh issue edit "$issue" --add-label faucet-sent > /dev/null
  answer "Sent $amount_sol devnet SOL to \`$address\`: https://explorer.solana.com/tx/$signature?cluster=devnet" completed
}

untagged=$(gh issue list --state open --limit 100 --search 'in:title "Devnet SOL" -label:faucet' --json number,title --jq '.[] | select(.title == "Devnet SOL") | .number')
for issue in $(printf '%s\n' "$untagged" | grep -Ex '[0-9]+'); do
  gh issue edit "$issue" --add-label faucet > /dev/null
done
waiting=$(gh issue list --label faucet --state open --limit 100 --json number,labels --jq '.[] | select(all(.labels[]; .name != "faucet-sent")) | .number')
mapfile -t open < <(printf '%s\n%s\n' "$waiting" "$untagged" | grep -Ex '[0-9]+' | sort -nu)
status=0
for issue in "${open[@]}"; do
  set +e
  (
    set -e
    serve "$issue"
  )
  code=$?
  set -e
  if [ "$code" -ne 0 ]; then
    echo "request $issue failed" >&2
    status=1
  fi
done
exit "$status"
