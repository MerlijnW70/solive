import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEVNET_GENESIS_HASH } from "@intent-engine/client";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const SCRIPTS = join(ROOT, "scripts");
const FAUCET = "CrYx7JA1TRwGtpn9T6C2mVsRgMP7XztGRwZdasV9XSLS";
const FUNDER = "4JUfAhAtwAccPT4T8cmsxQBpBwNiaUJgwWt5c5bsvKAo";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const SIGNATURE = "5topUpSig";

function stubs(dir: string, programs: Record<string, string>): void {
  for (const [name, body] of Object.entries(programs)) {
    writeFileSync(join(dir, name), `#!/usr/bin/env bash\necho "${name} $*" >> "$STUB_LOG"\n${body}`);
    chmodSync(join(dir, name), 0o755);
  }
}

const SOLANA = `case "$1" in
  genesis-hash) echo "$STUB_GENESIS" ;;
  balance) echo "$STUB_HELD lamports" ;;
  address) echo "${FUNDER}" ;;
  transfer) echo '{"signature": "${SIGNATURE}"}' ;;
esac
`;

function topUp(args: string[], stub: { genesis?: string; held: bigint }, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "topup-"));
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  stubs(dir, { solana: SOLANA });
  const run = spawnSync("bash", [join(SCRIPTS, "faucet-topup.sh"), ...args], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: `${dir}:${process.env["PATH"] ?? ""}`,
      TOPUP_KEYPAIR: join(dir, "funder.json"),
      STUB_LOG: log,
      STUB_GENESIS: stub.genesis ?? DEVNET_GENESIS_HASH,
      STUB_HELD: String(stub.held),
      ...env,
    },
  });
  const calls = readFileSync(log, "utf8").trim().split("\n");
  return { code: run.status, out: run.stdout.trim(), err: run.stderr.trim(), calls, transfers: calls.filter((c) => c.startsWith("solana transfer")) };
}

const SOL = 1_000_000_000n;

describe("the faucet top-up", () => {
  it("refuses a cluster other than devnet and sends nothing, even with --yes", () => {
    const run = topUp(["--yes"], { genesis: MAINNET_GENESIS, held: 0n }, { TOPUP_URL: "mainnet-beta" });
    expect(run.code).toBe(1);
    expect(run.err).toBe(`refusing: mainnet-beta is not devnet, its genesis hash is ${MAINNET_GENESIS}; the top-up sends devnet SOL only`);
    expect(run.calls).toEqual(["solana genesis-hash --url mainnet-beta"]);
    expect(run.transfers).toEqual([]);
  });

  it("previews the top-up without --yes and sends nothing", () => {
    const run = topUp([], { held: (3n * SOL) / 2n });
    expect(run.code).toBe(0);
    expect(run.out).toBe(`would send 8.5 SOL from ${FUNDER} to the faucet ${FAUCET}, which holds 1.5 SOL, to reach 10 SOL; run again with --yes to send`);
    expect(run.transfers).toEqual([]);
  });

  it("with --yes sends the faucet up to the target and prints what it sent", () => {
    const run = topUp(["--yes"], { held: 1_250_000_001n }, { TOPUP_FLOOR: "2", TOPUP_TARGET: "4.5" });
    expect(run.code).toBe(0);
    expect(run.transfers).toHaveLength(1);
    expect(run.transfers[0]).toMatch(new RegExp(`^solana transfer --url devnet --keypair \\S+funder\\.json --allow-unfunded-recipient --output json ${FAUCET} 3\\.249999999$`));
    expect(run.out).toBe(`sent 3.249999999 SOL from ${FUNDER} to the faucet ${FAUCET}: ` + "https://" + "explorer.solana.com/tx/" + SIGNATURE + "?cluster=devnet");
  });

  it("sends nothing while the faucet holds the floor or more", () => {
    const run = topUp(["--yes"], { held: 5n * SOL });
    expect(run.code).toBe(0);
    expect(run.out).toBe(`the faucet ${FAUCET} holds 5 SOL, at least the floor of 5 SOL; nothing sent`);
    expect(run.transfers).toEqual([]);
  });

  it("refuses amounts it cannot read and a target below the floor", () => {
    for (const [floor, target] of [["five", "10"], ["5", "1.0000000001"], ["5", "4"]] as const) {
      const run = topUp(["--yes"], { held: 0n }, { TOPUP_FLOOR: floor, TOPUP_TARGET: target });
      expect(run.code).toBe(2);
      expect(run.transfers).toEqual([]);
    }
    expect(topUp(["--send"], { held: 0n }).code).toBe(2);
  });
});

const PNPM = `if [ "$1" = pack ]; then touch "$3/$(basename "$PWD").tgz"; fi
`;

const NPM = `case "$1" in
  init) echo '{}' > package.json ;;
  install)
    mkdir -p node_modules/.bin
    printf '#!/usr/bin/env bash\\necho "intent-engine $*" >> "$STUB_LOG"\\nif [ "$1" = version ]; then echo "{\\\\"version\\\\": \\\\"$STUB_INSTALLED\\\\"}"; exit 0; fi\\nexit 1\\n' > node_modules/.bin/intent-engine
    chmod +x node_modules/.bin/intent-engine ;;
  view) if [ -n "$STUB_PUBLISHED" ]; then echo "$STUB_PUBLISHED"; else exit 1; fi ;;
esac
`;

function install(published: string) {
  const dir = mkdtempSync(join(tmpdir(), "filler-install-"));
  const repo = join(dir, "repo");
  const bin = join(dir, "bin");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(bin);
  for (const name of ["filler-install.sh", "env.sh", "filler.sh", "faucet-topup.sh"]) {
    copyFileSync(join(SCRIPTS, name), join(repo, "scripts", name));
  }
  for (const name of ["core", "client", "solver", "cli"]) {
    mkdirSync(join(repo, "packages", name), { recursive: true });
  }
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  stubs(bin, { pnpm: PNPM, npm: NPM });
  const home = join(dir, "home");
  const env = { PATH: `${bin}:${process.env["PATH"] ?? ""}`, HOME: home, STUB_LOG: log, STUB_INSTALLED: "0.1.53", STUB_PUBLISHED: published };
  const run = spawnSync("bash", [join(repo, "scripts", "filler-install.sh")], { cwd: dir, encoding: "utf8", env });
  return { run, home, log, env };
}

describe("the filler install", () => {
  it("installs the filler script next to the cli it installs, which that copy then runs", () => {
    const { run, home, log, env } = install("0.1.53");
    expect(run.status).toBe(0);
    const target = join(home, "solive-filler");
    expect(run.stdout.trim().split("\n")).toEqual([`filler: ${target}/filler.sh`, "installed cli 0.1.53, published cli 0.1.53"]);
    expect(run.stderr).toBe("");
    for (const name of ["filler.sh", "faucet-topup.sh"]) {
      expect(readFileSync(join(target, name), "utf8")).toBe(readFileSync(join(SCRIPTS, name), "utf8"));
      expect(statSync(join(target, name)).mode & 0o111).not.toBe(0);
    }
    const filler = spawnSync("bash", [join(target, "filler.sh")], { cwd: home, encoding: "utf8", env: { ...env, FILLER_KEYPAIR: "filler.json" } });
    expect(filler.status).toBe(1);
    expect(filler.stderr).toContain("treasury --create failed; not starting the filler");
    expect(readFileSync(log, "utf8")).toContain("intent-engine treasury --url devnet --create");
  });

  it("prints the installed cli's version beside the published one and says when they differ", () => {
    const newer = install("0.1.54");
    expect(newer.run.status).toBe(0);
    expect(newer.run.stdout).toContain("installed cli 0.1.53, published cli 0.1.54");
    expect(newer.run.stderr.trim()).toBe("the installed cli 0.1.53 is not the published 0.1.54; check out v0.1.54 and install again");
    const offline = install("");
    expect(offline.run.status).toBe(0);
    expect(offline.run.stdout).toContain("installed cli 0.1.53, published cli unknown");
    expect(offline.run.stderr.trim()).toBe("npm did not answer, so the published version is unknown");
  });

  it("refuses to install under /mnt", () => {
    const run = spawnSync("bash", [join(SCRIPTS, "filler-install.sh")], { encoding: "utf8", env: { ...process.env, FILLER_HOME: "/mnt/c/filler" } });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("refusing: install the filler on the WSL filesystem, not under /mnt");
  });
});
