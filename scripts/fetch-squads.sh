#!/usr/bin/env bash
set -euo pipefail
exec bash "$(dirname "$0")/fetch-program.sh" SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf dec8d3e0fae58c7c8f2416e5f67c25e673f047afd6dd2bba4a47e0b29a01d34c squads_multisig.so "${SQUADS_RPC:-https://api.mainnet-beta.solana.com}"
