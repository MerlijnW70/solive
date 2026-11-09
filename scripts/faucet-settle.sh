#!/usr/bin/env bash
load() {
  local found facts
  view=$(gh issue view "$issue" --json comments,labels,state,createdAt)
  facts=$(printf '%s' "$view" | parse facts)
  read -r state created <<< "$facts"
  found=$(printf '%s' "$view" | parse records)
  records=()
  if [ -n "$found" ]; then
    mapfile -t records <<< "$found"
  fi
  markers=" $(printf '%s' "$view" | parse markers) "
}

unpend() {
  local labelled
  labelled=$(printf '%s' "$view" | parse labelled faucet-pending)
  if [ "$labelled" = yes ]; then
    gh issue edit "$issue" --remove-label faucet-pending > /dev/null
  fi
}

deliver() {
  local text="Sent $amount_sol devnet SOL to \`$2\`: https://explorer.solana.com/tx/$1?cluster=devnet" said
  said=$(printf '%s' "$view" | parse said "$text")
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

unrecorded() {
  local sig entry known=" "
  for entry in "${records[@]}"; do
    known+="${entry%% *} "
  done
  for sig in $markers; do
    if [[ "$known" != *" $sig "* ]]; then
      echo "$sig"
      return 0
    fi
  done
}

doubted() {
  local sig checked line check_sig check_at newest=0 done=" "
  checked=$(printf '%s' "$view" | parse checks)
  for sig in "$@"; do
    if [[ "$done" == *" $sig "* ]]; then
      continue
    fi
    done+="$sig "
    check_at=""
    while read -r check_sig line; do
      if [ "$check_sig" = "$sig" ]; then
        check_at="${check_at:-$line}"
      fi
    done <<< "$checked"
    if [ -z "$check_at" ]; then
      gh issue comment "$issue" --body "No transfer from transaction $sig has landed as of $(date -u -d "@$now" +%Y-%m-%dT%H:%M:%SZ). The faucet checks again at least 2 hours later before it sends anything new." > /dev/null
      check_at="$now"
    fi
    if [ "$check_at" -gt "$newest" ]; then
      newest="$check_at"
    fi
  done
  [ $((now - newest)) -ge "$check_secs" ]
}

scan_wallet() {
  local wallet="$1" entry sig to payer slot last anchor at lowest="" oldest="" wanted=""
  for entry in "${open_entries[@]}"; do
    read -r sig to payer slot last anchor at <<< "$entry"
    if [ "$payer" = "$wallet" ]; then
      wanted+="$sig,"
      if [ -z "$lowest" ] || [ "$slot" -lt "$lowest" ]; then
        lowest="$slot"
        oldest="$anchor"
      fi
    fi
  done
  scan "$wallet" "$oldest" - "$final_slot" "faucet request $issue" "$amount" "${wanted%,}"
}

resolve() {
  local entry sig to payer slot last anchor at status latest final_valid final_slot height wallet lost seen=" " wallets=" " open_entries=() absent=()
  outcome=dead
  waiting_sig=""
  waiting_why="to finalize or for devnet to show it can no longer land"
  for entry in "${records[@]}"; do
    read -r sig to payer slot last anchor at <<< "$entry"
    if status=$(solana confirm --url "$url" --commitment finalized --output json "$sig" 2> /dev/null); then
      status=$(printf '%s' "$status" | parse status)
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
        if [[ "$wallets" != *" $payer "* ]]; then
          wallets+="$payer "
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
  read -r _ final_valid final_slot < <(printf '%s' "$latest" | parse latest) || return 0
  height=$((final_valid - 150))
  lost=$(unrecorded)
  for wallet in $wallets; do
    scan_wallet "$wallet"
    if [ "${#scan_hits[@]}" -gt 0 ]; then
      outcome=landed
      read -r landed_sig landed_to <<< "${scan_hits[0]}"
      return 0
    fi
    if [ "$scan_state" != covered ]; then
      return 0
    fi
    if [ "$scan_over" -gt 0 ] && [ -n "$lost" ]; then
      waiting_sig="$lost"
      waiting_why="whose record is gone, while more entries carry its memo than the faucet verifies"
      return 0
    fi
    seen+="${scan_seen# }"
  done
  outcome=dead
  for entry in "${open_entries[@]}"; do
    read -r sig to payer slot last anchor at <<< "$entry"
    if [[ "$seen" == *" $sig:0 "* ]]; then
      outcome=landed
      landed_sig="$sig"
      landed_to="$to"
      return 0
    fi
    if [[ "$seen" == *" $sig:1 "* ]]; then
      continue
    fi
    if [ "$height" -le $((last + expiry_margin)) ]; then
      outcome=undecided
      waiting_sig="$sig"
    else
      absent+=("$sig")
    fi
  done
  if [ "$outcome" = dead ] && [ "${#absent[@]}" -gt 0 ] && ! doubted "${absent[@]}"; then
    outcome=undecided
    waiting_sig="${absent[0]}"
  fi
}

orphan() {
  local payer proven
  payer=$(solana address --keypair "$keypair")
  scan "$payer" - "$created" - "faucet request $issue" "$amount" -
  if [ "${#scan_hits[@]}" -gt 0 ]; then
    deliver "${scan_hits[0]%% *}" "${scan_hits[0]#* }"
  fi
  if [ "$scan_state" != covered ]; then
    proven="the faucet could not read the history of \`$payer\` back to the request's creation"
  elif [ "$scan_over" -gt 0 ]; then
    proven="more entries in the history of \`$payer\` carry its memo than the faucet verifies"
  else
    proven="the history of \`$payer\` back to the request's creation shows no landed transfer from it with the memo"
  fi
  if [ $((now - created)) -ge "$pending_secs" ]; then
    unpend
    gh issue comment "$issue" --body "Closed undecided: the faucet lost the record of its transfer for this request and could not prove within 7 days whether one landed, so it never sends again for this request. A maintainer can look for the memo \`faucet request $issue\` in the faucet wallet's history." > /dev/null
    if [ "$state" = open ]; then
      gh issue close "$issue" --reason "not planned" > /dev/null
    fi
    echo "Closed undecided: request $issue has no transfer record, and $proven."
    exit 12
  fi
  echo "Pending: request $issue carries faucet-pending but no transfer record, and $proven; it closes undecided 7 days after it was filed."
  exit 10
}

settle() {
  local labelled at
  issue="$1"
  load
  if [ "${#records[@]}" -eq 0 ]; then
    labelled=$(printf '%s' "$view" | parse labelled faucet-pending)
    if [ "$labelled" = yes ]; then
      orphan
    fi
    return 0
  fi
  resolve
  case "$outcome" in
    landed) deliver "$landed_sig" "$landed_to" ;;
    undecided)
      read -r _ _ _ _ _ _ at <<< "${records[-1]}"
      if [ $((now - at)) -ge "$pending_secs" ]; then
        unpend
        gh issue comment "$issue" --body "Closed undecided: the faucet could not prove within 7 days whether transaction $waiting_sig landed, so it never sends again for this request. A maintainer can check it at https://explorer.solana.com/tx/$waiting_sig?cluster=devnet." > /dev/null
        if [ "$state" = open ]; then
          gh issue close "$issue" --reason "not planned" > /dev/null
        fi
        echo "Closed undecided: request $issue, transaction $waiting_sig."
        exit 12
      fi
      echo "Pending: request $issue waits for transaction $waiting_sig $waiting_why."
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
