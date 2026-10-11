#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
image="solanafoundation/solana-verifiable-build@sha256:2e0b78f44ee76612e9260c7c988570c5e14de6fbd93e0ab07115ec7054473b4f"
work="$(mktemp -d)"
git archive HEAD | tar -x -C "$work"
(cd "$work" && solana-verify build --library-name intent_engine --base-image "$image")
docker run --rm -v "$work:/work" --entrypoint chown "$image" -R "$(id -u):$(id -g)" /work
mkdir -p verifiable
cp "$work/target/deploy/intent_engine.so" verifiable/intent_engine.so
rm -rf "$work"
solana-verify get-executable-hash verifiable/intent_engine.so | tee verifiable/intent_engine.hash
