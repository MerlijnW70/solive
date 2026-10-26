#!/usr/bin/env bash
set -euo pipefail
exec bash "$(dirname "$0")/fetch-program.sh" ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S 3d0c0f7504c01b1f6996d30a5c3dc2cccb8b65dedba80d6fceb60a7cada093e0 program_metadata.so "${PROGRAM_METADATA_RPC:-https://api.mainnet-beta.solana.com}"
