#!/usr/bin/env bash
log="${1:-}"
now() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }
say() { printf '{"at":"%s","round":"log","detail":"%s"}\n' "$(now)" "$1"; }
if [[ -z "$log" || ! -f "$log" || -L "$log" ]]; then
  exit 0
fi
nuls="$(tr -cd '\000' < "$log" 2>/dev/null | wc -c)"
if [[ ! "$nuls" =~ ^[0-9]+$ ]] || (( nuls == 0 )); then
  exit 0
fi
if ! clean="$(mktemp "$log.XXXXXX" 2>/dev/null)"; then
  say "found $nuls NUL bytes in $log but cannot write beside it, so they stay"
  exit 0
fi
if tr -d '\000' < "$log" > "$clean" && say "removed $nuls NUL bytes that an unclean stop left in $log" >> "$clean" && chmod --reference="$log" "$clean" && mv -f "$clean" "$log"; then
  exit 0
fi
rm -f "$clean"
say "found $nuls NUL bytes in $log but could not replace it, so they stay"
exit 0
