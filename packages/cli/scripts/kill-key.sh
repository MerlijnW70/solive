#!/usr/bin/env bash
set -euo pipefail
cd "$1"
{ cat pnpm-lock.yaml; find packages/core/src packages/client/src packages/solver/src -type f | LC_ALL=C sort | xargs cat; } | sha256sum | cut -c1-64
