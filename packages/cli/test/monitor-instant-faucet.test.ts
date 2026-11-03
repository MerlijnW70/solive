import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, generateKeyPairSigner, lamports } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { parse } from "../src/args.js";
import { EXIT_ALERTED, EXIT_OK, main } from "../src/main.js";
import { cli, h, runtime, world } from "./harness.js";
import { listing } from "./monitor-transport.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const WORKFLOW = readFileSync(join(ROOT, ".github/workflows/monitor.yml"), "utf8");
const LIMITS = readFileSync(join(ROOT, "services/faucet/src/limits.ts"), "utf8");
const BASELINE = "/srv/monitor/baseline.json";
const SOL = 1_000_000_000n;
const INSTANT_WALLET = "932eKvgQTgn5gCsXyJ8p6cnXNpbvZgY3F1bw96QWhob5";

const watched = () => {
  const run = WORKFLOW.split("\n").find((line) => line.includes("run: npx")) ?? "";
  const argv = run.split(" monitor ")[1]?.split(" ") ?? [];
  return (parse(["monitor", ...argv], {}) as { watch: { minBalance: ReadonlyMap<string, bigint> } }).watch.minBalance;
};

const limit = (pattern: RegExp) => BigInt(pattern.exec(LIMITS)?.[1] ?? "NaN");

async function monitorOnce(wallet: Address, floor: bigint) {
  const out: string[] = [];
  const code = await main(["monitor", "--expect", BASELINE, "--once", "--min-balance", `${wallet}=${floor / SOL}`], runtime({}), { out: (t) => out.push(t), err: () => undefined });
  return { code, alerts: out.map((o) => JSON.parse(o) as Record<string, unknown>) };
}

describe("the monitor on the instant faucet's wallet", () => {
  it("watches the wallet the instant faucet pays from, once", () => {
    expect([...watched().keys()]).toContain(INSTANT_WALLET);
    expect(WORKFLOW.split(INSTANT_WALLET)).toHaveLength(2);
  });

  it("keeps its floor above the service's own floor plus a day of drips", () => {
    const drip = SOL / limit(/DRIP_LAMPORTS = LAMPORTS_PER_SOL \/ (\d+)n/);
    const dayDrips = limit(/DAILY_DRIPS = (\d+);/);
    const serviceFloor = limit(/FLOOR_LAMPORTS = (\d+)n \* LAMPORTS_PER_SOL/) * SOL + drip;
    expect(watched().get(INSTANT_WALLET)).toBeGreaterThanOrEqual(serviceFloor + drip * dayDrips);
  });

  it("covers a day at the daily cap and no more than a SOL over it", () => {
    const drip = SOL / limit(/DRIP_LAMPORTS = LAMPORTS_PER_SOL \/ (\d+)n/);
    const needed = limit(/FLOOR_LAMPORTS = (\d+)n \* LAMPORTS_PER_SOL/) * SOL + drip + drip * limit(/DAILY_DRIPS = (\d+);/);
    const floor = watched().get(INSTANT_WALLET) ?? 0n;
    expect(floor).toBeGreaterThanOrEqual(needed);
    expect(floor - needed).toBeLessThan(SOL);
  });

  it("states its floor and cap in the maintainer guide and its wallet in the faucet readme", () => {
    const readme = readFileSync(join(ROOT, "services/faucet/README.md"), "utf8");
    const operations = readFileSync(join(ROOT, "docs/maintainers/operations.md"), "utf8");
    expect(readme).toContain(`TOPUP_FAUCET=${INSTANT_WALLET}`);
    expect(readme).toContain(`The hourly monitor in \`.github/workflows/monitor.yml\` alerts below ${(watched().get(INSTANT_WALLET) ?? 0n) / SOL} SOL`);
    expect(readme).toContain(`a day at the cap of ${limit(/DAILY_DRIPS = (\d+);/)} drips`);
    expect(operations).toContain(`daily cap of ${limit(/DAILY_DRIPS = (\d+);/)} drips`);
  });

  it("states its floor in the maintainer guide", () => {
    const floor = (watched().get(INSTANT_WALLET) ?? 0n) / SOL;
    expect(readFileSync(join(ROOT, "docs/maintainers/operations.md"), "utf8")).toContain(`The instant faucet's floor is ${floor} SOL`);
  });

  describe("with the chain", () => {
    beforeEach(async () => {
      await world();
      h.through = listing;
      expect((await cli(["monitor", "--write-baseline", BASELINE], {})).code).toBe(EXIT_OK);
    });

    it("alerts below the floor and stays quiet at and above it", async () => {
      const floor = watched().get(INSTANT_WALLET) ?? 0n;
      const [below, at, above] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
      h.svm.airdrop(below.address, lamports(floor - 1n));
      h.svm.airdrop(at.address, lamports(floor));
      h.svm.airdrop(above.address, lamports(floor + SOL));
      const low = await monitorOnce(below.address, floor);
      expect(low.code).toBe(EXIT_ALERTED);
      expect(low.alerts).toHaveLength(1);
      expect(low.alerts[0]).toMatchObject({ kind: "balance", wallet: below.address });
      expect((await monitorOnce(at.address, floor)).code).toBe(EXIT_OK);
      expect((await monitorOnce(above.address, floor)).code).toBe(EXIT_OK);
    });
  });
});
