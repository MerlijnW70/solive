#!/usr/bin/env bash
set -euo pipefail
tag="${1:?usage: bash scripts/release.sh v<version> <pack directory>}"
out="$(mkdir -p "${2:?usage: bash scripts/release.sh v<version> <pack directory>}" && cd "$2" && pwd)"
packages=(core client solver cli)
version="${tag#v}"
if [[ "$tag" != "v$version" || ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "a release tag looks like v1.2.3, not $tag" >&2
  exit 1
fi
for p in "${packages[@]}"; do
  have="$(node -p "require('./packages/$p/package.json').version")"
  if [[ "$have" != "$version" ]]; then
    echo "packages/$p is at $have, not the tagged $version" >&2
    exit 1
  fi
done
if ! grep -qxF "export const VERSION = \"$version\";" packages/cli/src/version.ts; then
  echo "packages/cli/src/version.ts is not at the tagged $version" >&2
  exit 1
fi
for p in "${packages[@]}"; do
  pnpm --filter "@intent-engine/$p" build
  (cd "packages/$p" && pnpm pack --pack-destination "$out" > /dev/null)
  if [[ ! -f "$out/intent-engine-$p-$version.tgz" ]]; then
    echo "pnpm pack did not write intent-engine-$p-$version.tgz" >&2
    exit 1
  fi
done
for p in "${packages[@]}"; do
  if npm view "@intent-engine/$p@$version" version > /dev/null 2>&1; then
    echo "@intent-engine/$p@$version is already published"
    continue
  fi
  npm publish "$out/intent-engine-$p-$version.tgz" --access public --provenance --loglevel verbose
done
