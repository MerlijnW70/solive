import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const DEVNET = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const PROGRAM = "GHFB9q4fhhqRyCoycoivdxMhFkp1aLHJk5VvroUsgrJU";
const MULTISIG = "D2DffpdbegJMjTvsvtcQa61D1m5HLQvp5mFwUmeaHC6d";
const VAULT = "DxF6mApa3rnN7QgdqjtBvgyDesvKhVTYQ14Giike4Urv";
const BUFFER = "BuFFerAccount1111111111111111111111111111111";
const KEY = "KeyPub1111111111111111111111111111111111111";
const IDL = { address: PROGRAM, version: "0.1.0", instructions: [{ name: "open", discriminator: [1, 2, 3] }, { name: "close", discriminator: [4, 5, 6] }] };

const STUBS: Record<string, string> = {
  solana: `#!/usr/bin/env bash
echo "solana $*" >> "$STUB_LOG"
[[ "$1" == genesis-hash ]] && echo "${DEVNET}"
exit 0
`,
  "solana-keygen": `#!/usr/bin/env bash
echo "${KEY}"
`,
  git: `#!/usr/bin/env bash
[[ "$1" == rev-parse ]] && echo 0000000000000000000000000000000000000000
exit 0
`,
  pnpm: `#!/usr/bin/env bash
exit 0
`,
  npx: `#!/usr/bin/env bash
cmd=""
out=""
rest=""
args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  if [[ -z "$cmd" ]]; then
    case "\${args[i]}" in
      create-buffer|fetch-buffer|close-buffer|set-buffer-authority|update|write|fetch) cmd="\${args[i]}" ;;
    esac
  else
    rest="$rest \${args[i]}"
  fi
  [[ "\${args[i]}" == --output ]] && out="\${args[i+1]}"
done
echo "pmp $cmd$rest" >> "$STUB_LOG"
case "$cmd" in
  create-buffer) echo "buffer: ${BUFFER}" ;;
  fetch-buffer)
    case "$STUB_BUFFER" in
      full) cp "$STUB_FULL" "$out" ;;
      truncated) cp "$STUB_TRUNCATED" "$out" ;;
      *) echo "Error: buffer not found" >&2; exit 1 ;;
    esac ;;
  fetch) cp "$STUB_FULL" "$out" ;;
  close-buffer) [[ "$STUB_CLOSE" == fail ]] && exit 1; exit 0 ;;
  update) printf '[Transaction #1]\\n' ;;
esac
exit 0
`,
  node: `#!/usr/bin/env bash
if [[ "$1" == packages/multisig/dist/bin.js ]]; then
  echo "squads $2" >> "$STUB_LOG"
  [[ "$2" == vault ]] && printf '{"vault":"${VAULT}"}\\n'
  exit 0
fi
if [[ "$1" == scripts/instruction-list.mjs ]]; then
  cat > /dev/null
  echo proposal
  exit 0
fi
exec "$REAL_NODE" "$@"
`,
};

type Buffer = "full" | "truncated" | "missing";
type Result = { code: number; log: string[]; err: string; out: string };

function run(args: string[], buffer: Buffer, close: "ok" | "fail" = "ok"): Result {
  const work = mkdtempSync(join(tmpdir(), "idl-buffer-"));
  const repo = join(work, "repo");
  const bin = join(work, "bin");
  for (const dir of [bin, join(repo, "scripts"), join(repo, "idl"), join(work, "home")]) {
    mkdirSync(dir, { recursive: true });
  }
  for (const file of ["idl.sh", "env.sh"]) {
    copyFileSync(join(ROOT, "scripts", file), join(repo, "scripts", file));
  }
  const compact = JSON.stringify(IDL);
  writeFileSync(join(repo, "idl", "intent_engine.json"), compact);
  const full = join(work, "full.json");
  const truncated = join(work, "truncated.json");
  writeFileSync(full, JSON.stringify(IDL, null, 2));
  writeFileSync(truncated, compact.slice(0, Math.floor(compact.length / 2)));
  for (const [name, text] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  const log = join(work, "log");
  writeFileSync(log, "");
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: join(work, "home"),
    TMPDIR: work,
    REAL_NODE: process.execPath,
    STUB_LOG: log,
    STUB_BUFFER: buffer,
    STUB_CLOSE: close,
    STUB_FULL: full,
    STUB_TRUNCATED: truncated,
  };
  const lines = () => readFileSync(log, "utf8").split("\n").filter((line) => line !== "");
  try {
    const out = execFileSync("bash", [join(repo, "scripts", "idl.sh"), ...args], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
    return { code: 0, log: lines(), err: "", out };
  } catch (error) {
    const failed = error as { status?: number; stderr?: string; stdout?: string };
    return { code: failed.status ?? 1, log: lines(), err: failed.stderr ?? "", out: failed.stdout ?? "" };
  }
}

const commands = (result: Result) => result.log.filter((line) => line.startsWith("pmp ")).map((line) => line.split(" ")[1]);
const multisig = (buffer: Buffer, close: "ok" | "fail" = "ok") => run(["devnet", "--multisig", MULTISIG], buffer, close);
const write = (buffer: Buffer, close: "ok" | "fail" = "ok") => run(["devnet"], buffer, close);
const CLOSE = `pmp close-buffer ${BUFFER} --recipient ${KEY}`;

describe("idl.sh --multisig", () => {
  it("closes a truncated buffer with the local key and refuses before the vault gets any authority", () => {
    const refused = multisig("truncated");
    expect(refused.code).toBe(1);
    expect(commands(refused)).toEqual(["create-buffer", "fetch-buffer", "close-buffer"]);
    expect(refused.log).toContain(CLOSE);
    expect(refused.err).toBe(`refusing: buffer ${BUFFER} does not hold idl/intent_engine.json; it stayed under the local key and was closed\n`);
    expect(refused.log).not.toContain("squads propose-admin");
  });

  it("closes the buffer when it cannot be fetched", () => {
    const refused = multisig("missing");
    expect(refused.code).toBe(1);
    expect(commands(refused)).toEqual(["create-buffer", "fetch-buffer", "close-buffer"]);
  });

  it("says how to close the buffer by hand when the close fails, and still exits non-zero", () => {
    const refused = multisig("truncated", "fail");
    expect(refused.code).toBe(1);
    expect(commands(refused)).toEqual(["create-buffer", "fetch-buffer", "close-buffer"]);
    expect(refused.err).toContain(`it stays under the local key, close it with: npx @solana-program/program-metadata@0.10.0`);
    expect(refused.err).toContain(`close-buffer ${BUFFER} --recipient ${KEY}`);
  });

  it("hands a complete buffer to the vault after fetching and comparing it, formatting aside", () => {
    const passed = multisig("full");
    expect(passed.code).toBe(0);
    expect(commands(passed)).toEqual(["create-buffer", "fetch-buffer", "set-buffer-authority", "update"]);
    expect(passed.log).toContain("squads propose-admin");
    expect(passed.log.some((line) => line.startsWith("pmp close-buffer"))).toBe(false);
  });
});

describe("idl.sh direct write", () => {
  it("closes a truncated buffer and never writes the IDL account from it", () => {
    const refused = write("truncated");
    expect(refused.code).toBe(1);
    expect(commands(refused)).toEqual(["create-buffer", "fetch-buffer", "close-buffer"]);
    expect(refused.log).toContain(CLOSE);
  });

  it("writes the IDL account from a complete buffer, closes that buffer in the same step and checks the account", () => {
    const passed = write("full");
    expect(passed.code).toBe(0);
    expect(commands(passed)).toEqual(["create-buffer", "fetch-buffer", "write", "fetch"]);
    expect(passed.log.some((line) => line.startsWith(`pmp write idl ${PROGRAM} --buffer ${BUFFER} --close-buffer ${KEY}`))).toBe(true);
    expect(passed.out).toContain("on chain matches idl/intent_engine.json");
  });
});

describe("idl.sh --check", () => {
  it("creates no buffer", () => {
    const checked = run(["devnet", "--check"], "full");
    expect(checked.code).toBe(0);
    expect(commands(checked)).toEqual(["fetch"]);
  });
});
