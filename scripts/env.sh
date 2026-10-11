export PATH="$HOME/.cargo/bin:$HOME/.avm/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [[ "$PWD" =~ -prober-[0-9]+-([0-9]+)$ ]]; then
  export CARGO_TARGET_DIR="$HOME/.cache/solive-target/prober-${BASH_REMATCH[1]}"
elif [[ "$PWD" == /mnt/* ]]; then
  export CARGO_TARGET_DIR="$HOME/.cache/solive-target/$(printf '%s' "$PWD" | sha256sum | cut -c1-16)"
fi
