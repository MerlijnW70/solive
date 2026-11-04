import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const FAUCET = read("scripts/faucet.sh");
const TOPUP = read("scripts/faucet-topup.sh");
const RUNBOOK = read("docs/maintainers/operations.md");
const WORKFLOW = read(".github/workflows/faucet.yml");
const MONITOR = read(".github/workflows/monitor.yml");

const assigned = (text: string, name: string) => Number(new RegExp(`^${name}=(\\d+)$`, "m").exec(text)?.[1]);
const sol = (lamports: number) => lamports / 1_000_000_000;
const fallback = (name: string) => Number(new RegExp(`^\\w+="\\$\\{${name}:-(\\d+)\\}"$`, "m").exec(TOPUP)?.[1]);
const cronOf = (workflow: string) => (parseYaml(workflow) as { on: { schedule: { cron: string }[] } }).on.schedule.map((entry) => entry.cron);

describe("the issue faucet's budget", () => {
  const amount = sol(assigned(FAUCET, "amount"));
  const reserve = sol(assigned(FAUCET, "reserve"));
  const daily = assigned(FAUCET, "daily");
  const floor = fallback("TOPUP_FLOOR");
  const target = fallback("TOPUP_TARGET");

  it("is funded by a top-up that covers a full day at the daily cap", () => {
    expect(amount).toBeGreaterThan(0);
    expect(target).toBe(reserve + daily * amount);
    expect(floor).toBeGreaterThanOrEqual(reserve + amount);
    expect(floor).toBeLessThanOrEqual(target);
    expect(floor).toBeGreaterThan(reserve + (daily * amount) / 2);
  });

  it("is explained in the runbook with the arithmetic of these values", () => {
    expect(RUNBOOK).toContain(`sends ${amount} SOL per request, stops after ${daily} requests a day, and keeps ${reserve} SOL in reserve`);
    expect(RUNBOOK).toContain(`A day at the cap costs ${daily} × ${amount} = ${daily * amount} SOL, so the wallet needs ${daily * amount} + ${reserve} = ${target} SOL to serve it.`);
    expect(RUNBOOK).toContain(`\`TOPUP_TARGET\` defaults to ${target} SOL, and \`TOPUP_FLOOR\` to ${floor} SOL`);
    expect(RUNBOOK).toContain(`a week at the cap would cost 7 × ${daily * amount} = ${7 * daily * amount} SOL`);
  });

  it("keeps the monitor's alert floor above the faucet's reserve and one request", () => {
    const alert = Number(/--min-balance CrYx7JA1TRwGtpn9T6C2mVsRgMP7XztGRwZdasV9XSLS=(\d+)/.exec(MONITOR)?.[1]);
    expect(alert).toBeGreaterThan(reserve + amount);
    expect(alert).toBeLessThanOrEqual(floor);
  });
});

describe("the issue faucet's schedule in the runbook", () => {
  it("states the hourly minute the workflow runs at, and the retry delay the script waits", () => {
    const [cron] = cronOf(WORKFLOW);
    expect(cronOf(WORKFLOW)).toHaveLength(1);
    const minute = /^(\d+) \* \* \* \*$/.exec(cron ?? "")?.[1];
    expect(minute).toBeDefined();
    expect(RUNBOOK).toContain(`\`.github/workflows/faucet.yml\` runs once an hour, at minute ${minute}, and again for each request filed`);
    expect(RUNBOOK).not.toContain("faucet.yml` runs several times");
    const hours = Number(/^retry_secs=\$\(\((\d+) \* 3600\)\)$/m.exec(FAUCET)?.[1]);
    expect(hours).toBeGreaterThan(0);
    expect(RUNBOOK).toContain(`with a time ${hours} hours ahead`);
    const tries = assigned(FAUCET, "max_parks");
    expect(RUNBOOK).toContain(`After ${tries} such tries, ${tries * hours} hours in all, the script closes the request`);
  });
});
