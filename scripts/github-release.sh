#!/usr/bin/env bash
set -euo pipefail
tag="${1:?usage: bash scripts/github-release.sh v<version>}"
if [[ ! "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "a release tag looks like v1.2.3, not $tag" >&2
  exit 1
fi
if gh release view "$tag" > /dev/null 2>&1; then
  echo "the GitHub release $tag already exists"
  exit 0
fi
previous="$(git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' "$tag^" 2> /dev/null || true)"
if [[ -n "$previous" ]]; then
  range="$previous..$tag"
else
  range="$tag"
fi
notes="$(git log --no-merges --format='- %s' "$range")"
gh release create "$tag" --verify-tag --title "$tag" --notes "$notes"
