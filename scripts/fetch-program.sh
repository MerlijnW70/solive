#!/usr/bin/env bash
set -euo pipefail
if [[ -z "${4:-}" || -n "${5:-}" ]]; then
  echo "usage: fetch-program.sh <program> <sha256> <file name> <rpc url>" >&2
  exit 2
fi
program="$1"
expected="$2"
rpc="$4"
dir="${XDG_CACHE_HOME:-$HOME/.cache}/solive-fixtures"
out="$dir/$3"
digest() { sha256sum "$1" | cut -c1-64; }
if [[ -f "$out" && "$(digest "$out")" == "$expected" ]]; then
  echo "$out"
  exit 0
fi
mkdir -p "$dir"
partial="$(mktemp "$dir/fixture.XXXXXX")"
trap 'rm -f "$partial"' EXIT
node - "$rpc" "$program" "$partial" <<'JS'
const [rpc, program, out] = process.argv.slice(2);
const bs58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const encode = (bytes) => {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let text = "";
  while (n > 0n) {
    text = bs58[Number(n % 58n)] + text;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    text = "1" + text;
  }
  return text;
};
const account = async (address) => {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [address, { encoding: "base64" }] }),
      });
      const body = await response.json();
      const value = body.result && body.result.value;
      if (!value) throw new Error(`${address} not found at ${rpc}`);
      return Buffer.from(value.data[0], "base64");
    } catch (error) {
      if (attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
};
const programAccount = await account(program);
if (programAccount.readUInt32LE(0) !== 2) throw new Error(`${program} is not an upgradeable program`);
const programData = await account(encode(programAccount.subarray(4, 36)));
if (programData.readUInt32LE(0) !== 3) throw new Error(`${program} has no program data`);
await (await import("node:fs/promises")).writeFile(out, programData.subarray(45));
JS
actual="$(digest "$partial")"
if [[ "$actual" != "$expected" ]]; then
  echo "refusing: program $program fetched from $rpc hashes to $actual, not the pinned $expected" >&2
  exit 1
fi
chmod 644 "$partial"
mv "$partial" "$out"
trap - EXIT
echo "$out"
