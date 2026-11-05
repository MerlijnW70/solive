export PATH="$HOME/.cargo/bin:$HOME/.avm/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [[ "$PWD" == /mnt/* && "$PWD" =~ -prober-[0-9]+-([0-9]+)$ ]]; then
  export CARGO_TARGET_DIR="$HOME/.cache/solive-target/prober-${BASH_REMATCH[1]}"
elif [[ "$PWD" == /mnt/* ]]; then
  export CARGO_TARGET_DIR="$HOME/.cache/solive-target/$(printf '%s' "$PWD" | sha256sum | cut -c1-16)"
fi
temp_paths=()
make_temp() {
  local name="$1" path
  shift
  if ! path="$(mktemp "$@")" || [[ -z "$path" || ! -e "$path" ]]; then
    echo "mktemp failed" >&2
    exit 1
  fi
  temp_paths+=("$path")
  printf -v "$name" '%s' "$path"
}
remove_temps() {
  local path root="${TMPDIR:-/tmp}"
  root="${root%/}"
  for path in ${temp_paths[@]+"${temp_paths[@]}"}; do
    if [[ -n "$path" && "$path" == "$root"/?* && "$path" != *..* ]]; then
      rm -rf -- "$path"
    fi
  done
}
guard_temps() {
  trap remove_temps EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
}
