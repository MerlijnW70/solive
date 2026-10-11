#!/usr/bin/env bash
set -euo pipefail
base="$1"
head="$2"
status=0
for commit in $(git rev-list --no-merges "$base..$head"); do
  author="$(git log -1 --format='%an <%ae>' "$commit")"
  if ! git log -1 --format=%B "$commit" | grep -qxF "Signed-off-by: $author"; then
    echo "commit $commit has no Signed-off-by: $author"
    status=1
  fi
done
exit "$status"
