#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
packages=(core client solver cli)
version="$(node -p "require('./packages/cli/package.json').version")"
litesvm="$(node -p "require('./packages/client/package.json').devDependencies.litesvm")"
kit="$(node -p "require('./packages/client/package.json').devDependencies['@solana/kit']")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/packs" "$work/app"
for p in "${packages[@]}"; do
  pnpm --filter "@intent-engine/$p" build
done
for p in "${packages[@]}"; do
  (cd "packages/$p" && pnpm pack --pack-destination "$work/packs" > /dev/null)
  tarball="$work/packs/intent-engine-$p-$version.tgz"
  [[ -f "$tarball" ]] || { echo "pnpm pack did not write $tarball" >&2; exit 1; }
  tar -tzf "$tarball" | node -e '
const { existsSync, readFileSync } = require("node:fs");
const dir = process.argv[1];
const files = JSON.parse(readFileSync(`${dir}/package.json`, "utf8")).files.filter((f) => !f.startsWith("dist"));
const bad = readFileSync(0, "utf8").trim().split("\n").map((e) => e.replace(/^package\//, "")).filter((path) => {
  if (["package.json", "LICENSE", "README.md"].includes(path)) return false;
  if (files.includes(path)) return !existsSync(`${dir}/${path}`);
  const m = /^dist\/(.+?)(\.d\.ts\.map|\.d\.ts|\.js\.map|\.js)$/.exec(path);
  return m === null || !existsSync(`${dir}/${m[1]}.ts`);
});
if (bad.length > 0) {
  console.error(`${dir} packs files without a source:\n${bad.join("\n")}`);
  process.exit(1);
}
' "packages/$p"
done
client_files="$(tar -tzf "$work/packs/intent-engine-client-$version.tgz")"
for entry in package/program/intent_engine.so package/dist/src/testing.js package/dist/src/testing.d.ts package/dist/src/node.js package/dist/src/internal.js; do
  grep -qxF "$entry" <<< "$client_files" || { echo "the client tarball lacks $entry" >&2; exit 1; }
done
baseline="$PWD/monitoring/devnet.json"
cd "$work/app"
npm init -y > /dev/null
npm install --no-audit --no-fund --loglevel=error \
  "$work/packs/intent-engine-core-$version.tgz" \
  "$work/packs/intent-engine-client-$version.tgz" \
  "$work/packs/intent-engine-solver-$version.tgz" \
  "$work/packs/intent-engine-cli-$version.tgz" \
  "litesvm@$litesvm" \
  "@solana/kit@$kit"
node --input-type=module -e '
await import("@intent-engine/core");
await import("@intent-engine/client");
await import("@intent-engine/client/svm");
await import("@intent-engine/client/node");
await import("@intent-engine/client/internal");
await import("@intent-engine/core/internal");
await import("@intent-engine/solver");
const idl = await import("@intent-engine/core/idl.json", { with: { type: "json" } });
if (typeof idl.default.address !== "string") throw new Error("the IDL has no address");
'
node -e '
for (const name of ["@intent-engine/core", "@intent-engine/client", "@intent-engine/solver"]) {
  if (Object.keys(require(name)).length === 0) throw new Error(`require of ${name} exported nothing`);
}
if (typeof require("@intent-engine/core/idl.json").address !== "string") throw new Error("require of the IDL has no address");
'
env -u INTENT_ENGINE_SO node --input-type=module -e '
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { attestedResult, DEVNET_TEST_MINT, IntentStatus, NATIVE_MINT } from "@intent-engine/core";
const { createTestWorld, shippedProgram, shippedProgramPath } = await import("@intent-engine/client/testing");
if (!shippedProgramPath().startsWith(process.cwd() + "/node_modules/@intent-engine/client/")) throw new Error(`the world loads ${shippedProgramPath()}, not the installed package`);
const bytes = shippedProgram();
let end = bytes.length;
while (end > 0 && bytes[end - 1] === 0) end--;
const hash = createHash("sha256").update(bytes.subarray(0, end)).digest("hex");
const { programHash } = JSON.parse(readFileSync(process.argv[1], "utf8"));
if (hash !== programHash) throw new Error(`the installed program hashes to ${hash}, not the deployed ${programHash}`);
const world = await createTestWorld({ start: 1700000000n });
const [owner, judge] = [await world.wallet(), await world.wallet()];
const params = attestedResult({ amountIn: 1000000n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: new Uint8Array(32).fill(1), judgeFee: 0n });
const job = await world.client.createIntent({ signer: owner, inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT, params, expiresIn: 60n });
world.warp(60);
await world.client.expire(judge, job.intent);
if ((await world.client.intent({ owner: owner.address, nonce: job.nonce }))?.intent.status !== IntentStatus.Expired) throw new Error("the world did not expire the escrow");
' "$baseline"
printed="$(node_modules/.bin/intent-engine --version --output json)"
[[ "$(node -p 'JSON.parse(process.argv[1]).version' "$printed")" == "$version" ]] || { echo "intent-engine --version printed $printed, not $version" >&2; exit 1; }
kits="$(find node_modules -path '*/@solana/kit/package.json' | wc -l)"
[[ "$kits" == 1 ]] || { echo "$kits copies of @solana/kit installed" >&2; find node_modules -path '*/@solana/kit/package.json' >&2; exit 1; }
echo "packed and installed @intent-engine $version next to @solana/kit@$kit: imports, requires, a test world on the shipped program, the binary and one @solana/kit"
