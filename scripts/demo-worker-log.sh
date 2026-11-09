#!/usr/bin/env bash
set -euo pipefail
log="${1:?name the log file of the demo worker}"
now() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }
[[ -f "$log" ]] || exit 0
if [[ ! -w "$log" ]]; then
  printf '{"at":"%s","round":"log","detail":"%s is not writable by this user, so NUL bytes an unclean stop left in it stay"}\n' "$(now)" "$log"
  exit 0
fi
nuls="$(tr -cd '\000' < "$log" | wc -c)"
if (( nuls > 0 )); then
  clean="$(mktemp "$log.XXXXXX")"
  trap 'rm -f "$clean"' EXIT
  tr -d '\000' < "$log" > "$clean"
  cat "$clean" > "$log"
  printf '{"at":"%s","round":"log","detail":"removed %d NUL bytes that an unclean stop left in %s"}\n' "$(now)" "$nuls" "$log"
fi
