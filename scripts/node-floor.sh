#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
guard_temps
floor="$(sed -n 's/^ *node-version: \([0-9]*\.[0-9]*\.[0-9]*\)$/\1/p' .github/workflows/ci.yml | sort -u)"
if [[ ! "$floor" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "the ci workflow pins no single exact node-version: ${floor:-none}" >&2
  exit 1
fi
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) platform=linux-x64 ;;
  Linux-aarch64) platform=linux-arm64 ;;
  *) echo "no Node build for $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac
name="node-v$floor-$platform"
dir="${XDG_CACHE_HOME:-$HOME/.cache}/solive-node/$name"
if [[ ! -x "$dir/bin/node" ]]; then
  make_temp work -d
  curl -fsSL -o "$work/$name.tar.xz" "https://nodejs.org/dist/v$floor/$name.tar.xz"
  curl -fsSL -o "$work/SHASUMS256.txt" "https://nodejs.org/dist/v$floor/SHASUMS256.txt"
  (cd "$work" && grep " $name.tar.xz$" SHASUMS256.txt | sha256sum -c --status -)
  mkdir -p "$work/node"
  tar -xJf "$work/$name.tar.xz" -C "$work/node" --strip-components=1
  mkdir -p "$(dirname "$dir")"
  rm -rf "$dir"
  mv "$work/node" "$dir"
fi
test "$("$dir/bin/node" --version)" = "v$floor"
for package in core client solver cli; do
  pnpm --filter "@intent-engine/$package" build > /dev/null
done
if [[ -z "${1:-}" ]]; then
  set -- judge verdict viper draw host-judge container-check sandbox-doctor
fi
cd packages/cli
echo "node $("$dir/bin/node" --version)"
PATH="$dir/bin:$PATH" node_modules/.bin/vitest run --config ./vitest.setup.ts "$@"
