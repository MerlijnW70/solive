import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const MAINNET = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const DEVNET = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const PROGRAM = "GHFB9q4fhhqRyCoycoivdxMhFkp1aLHJk5VvroUsgrJU";
const MULTISIG = "D2DffpdbegJMjTvsvtcQa61D1m5HLQvp5mFwUmeaHC6d";
const VAULT = "DxF6mApa3rnN7QgdqjtBvgyDesvKhVTYQ14Giike4Urv";
const OTHER = "11111111111111111111111111111112";
const HASH = "a".repeat(64);
const MAINNET_URL = "https://" + "api.mainnet-beta.solana.com";
const DEVNET_URL = "https://" + "api.devnet.solana.com";

const STUBS: Record<string, string> = {
  solana: `#!/usr/bin/env bash
echo "solana $*" >> "$STUB_LOG"
case "$1 $2" in
  "genesis-hash --url") echo "$STUB_GENESIS" ;;
  "program show")
    case "$STUB_PROGRAM" in
      missing) echo "Error: Unable to find the account $3" >&2; exit 1 ;;
      down) echo "Error: error sending request for url" >&2; exit 1 ;;
      *) echo "{\\"programId\\":\\"$3\\",\\"authority\\":\\"$STUB_PROGRAM\\"}" ;;
    esac ;;
esac
`,
  "solana-verify": `#!/usr/bin/env bash
echo "solana-verify $*" >> "$STUB_LOG"
echo "${"b".repeat(64)}"
`,
  git: `#!/usr/bin/env bash
echo "git $*" >> "$STUB_LOG"
[[ "$1" == rev-parse ]] && echo 0000000000000000000000000000000000000000
exit 0
`,
  pnpm: `#!/usr/bin/env bash
echo "pnpm $*" >> "$STUB_LOG"
`,
  npx: `#!/usr/bin/env bash
echo "npx $*" >> "$STUB_LOG"
exit 1
`,
  node: `#!/usr/bin/env bash
if [[ "$1" == packages/multisig/dist/bin.js ]]; then
  echo "node $*" >> "$STUB_LOG"
  printf '%s\\n' "$STUB_VAULT"
  exit 0
fi
exec "$REAL_NODE" "$@"
`,
};

type Stub = { genesis: string; program: string; vault?: { threshold: number; timeLock: number } };

function run(script: "deploy.sh" | "idl.sh", args: string[], stub: Stub): { code: number; log: string[]; err: string } {
  const work = mkdtempSync(join(tmpdir(), "deploy-script-"));
  const repo = join(work, "repo");
  const bin = join(work, "bin");
  for (const dir of [bin, join(repo, "scripts"), join(repo, "idl"), join(work, "home")]) {
    mkdirSync(dir, { recursive: true });
  }
  for (const file of ["deploy.sh", "idl.sh", "env.sh"]) {
    copyFileSync(join(ROOT, "scripts", file), join(repo, "scripts", file));
  }
  writeFileSync(join(repo, "idl", "intent_engine.json"), JSON.stringify({ address: PROGRAM }));
  for (const [name, text] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  const log = join(work, "log");
  writeFileSync(log, "");
  const vault = stub.vault === undefined ? "" : JSON.stringify({ multisig: MULTISIG, vault: VAULT, ...stub.vault, members: [], transactionIndex: "15" });
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: join(work, "home"),
    REAL_NODE: process.execPath,
    STUB_LOG: log,
    STUB_GENESIS: stub.genesis,
    STUB_PROGRAM: stub.program,
    STUB_VAULT: vault,
    PROGRAM_ID: PROGRAM,
    VERIFY_FROM_ARTIFACT: "1",
  };
  const lines = () => readFileSync(log, "utf8").split("\n").filter((line) => line !== "");
  try {
    execFileSync("bash", [join(repo, "scripts", script), ...args], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
    return { code: 0, log: lines(), err: "" };
  } catch (error) {
    const failed = error as { status?: number; stderr?: string };
    return { code: failed.status ?? 1, log: lines(), err: failed.stderr ?? "" };
  }
}

const deploy = (cluster: string, stub: Stub, multisig = true) => run("deploy.sh", [cluster, HASH, ...(multisig ? ["--multisig", MULTISIG] : [])], stub);

const MISSING_ARTIFACT = "refusing: VERIFY_FROM_ARTIFACT=1 but verifiable/intent_engine.so is missing\n";
const VAULT_READ = `node packages/multisig/dist/bin.js vault --multisig ${MULTISIG} --url `;

describe("deploy.sh on mainnet", () => {
  it("refuses to upgrade an existing program without --multisig, before it builds anything", () => {
    const refused = deploy("mainnet-beta", { genesis: MAINNET, program: VAULT }, false);
    expect([refused.code, refused.err]).toEqual([1, `refusing: program ${PROGRAM} already exists on mainnet; upgrade it through its multisig with --multisig <multisig>\n`]);
    expect(refused.log.filter((line) => !line.startsWith("git "))).toEqual([`solana genesis-hash --url ${MAINNET_URL}`, `solana program show ${PROGRAM} --url ${MAINNET_URL} --output json`]);
  });

  it("refuses when it cannot tell whether the program exists", () => {
    const refused = deploy("mainnet-beta", { genesis: MAINNET, program: "down" }, false);
    expect([refused.code, refused.err]).toEqual([1, `refusing: could not tell whether program ${PROGRAM} exists on mainnet: Error: error sending request for url\n`]);
  });

  it("lets a first deploy of a program that does not exist yet go on to the build", () => {
    const first = deploy("mainnet-beta", { genesis: MAINNET, program: "missing" }, false);
    expect([first.code, first.err]).toEqual([1, MISSING_ARTIFACT]);
  });

  it("refuses a multisig with a threshold below 2", () => {
    const refused = deploy("mainnet-beta", { genesis: MAINNET, program: VAULT, vault: { threshold: 1, timeLock: 3600 } });
    expect([refused.code, refused.err]).toEqual([1, `refusing: multisig ${MULTISIG} has threshold 1, but a mainnet upgrade needs at least 2\n`]);
    expect(refused.log).toContain(VAULT_READ + MAINNET_URL);
    expect(refused.log.some((line) => line.startsWith("solana program show"))).toBe(false);
  });

  it("refuses a multisig without a time lock", () => {
    const refused = deploy("mainnet-beta", { genesis: MAINNET, program: VAULT, vault: { threshold: 2, timeLock: 0 } });
    expect([refused.code, refused.err]).toEqual([
      1,
      `refusing: multisig ${MULTISIG} has time lock 0, but a mainnet upgrade needs one above 0; raise it with propose-time-lock\n`,
    ]);
  });

  it("accepts a multisig with two approvals and a time lock, then checks the upgrade authority", () => {
    const passed = deploy("mainnet-beta", { genesis: MAINNET, program: VAULT, vault: { threshold: 2, timeLock: 3600 } });
    expect([passed.code, passed.err]).toEqual([1, MISSING_ARTIFACT]);
    const stranger = deploy("mainnet-beta", { genesis: MAINNET, program: OTHER, vault: { threshold: 2, timeLock: 3600 } });
    expect(stranger.err).toContain(`refusing: program ${PROGRAM} is upgraded by ${OTHER}, not the vault ${VAULT} of multisig ${MULTISIG}`);
  });
});

describe("deploy.sh on devnet", () => {
  it("reads the vault with vault, not show, and keeps a threshold of one and no time lock", () => {
    const passed = deploy("devnet", { genesis: DEVNET, program: VAULT, vault: { threshold: 1, timeLock: 0 } });
    expect([passed.code, passed.err]).toEqual([1, MISSING_ARTIFACT]);
    expect(passed.log).toEqual(
      expect.arrayContaining(["pnpm --filter @intent-engine/core build", "pnpm --filter @intent-engine/client build", "pnpm --filter @intent-engine/multisig build", VAULT_READ + DEVNET_URL]),
    );
    expect(passed.log.some((line) => line.includes(" show --multisig"))).toBe(false);
  });

  it("still upgrades an existing program without --multisig", () => {
    const passed = deploy("devnet", { genesis: DEVNET, program: VAULT }, false);
    expect([passed.code, passed.err]).toEqual([1, MISSING_ARTIFACT]);
    expect(passed.log.some((line) => line.startsWith("solana program show"))).toBe(false);
  });
});

describe("idl.sh", () => {
  it("builds core, the client and the multisig tool it imports, then reads the vault with vault", () => {
    const ran = run("idl.sh", ["devnet", "--multisig", MULTISIG], { genesis: DEVNET, program: VAULT, vault: { threshold: 2, timeLock: 0 } });
    expect(ran.code).toBe(1);
    const steps = ran.log.filter((line) => !line.startsWith("git ") && !line.startsWith("solana "));
    expect(steps.slice(0, 4)).toEqual(["pnpm --filter @intent-engine/core build", "pnpm --filter @intent-engine/client build", "pnpm --filter @intent-engine/multisig build", VAULT_READ + DEVNET_URL]);
    expect(steps[4]).toContain(`create-buffer idl/intent_engine.json`);
  });
});
