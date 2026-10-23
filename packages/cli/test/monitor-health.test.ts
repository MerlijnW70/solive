import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, generateKeyPairSigner, lamports } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEVNET_TEST_MINT,
  encodeParams,
  getIntentDecoder,
  getIntentEncoder,
  getIntentSize,
  type Intent,
  type IntentParams,
  INTENT_VERSION,
  IntentStatus,
  Kind,
  NATIVE_MINT,
} from "@intent-engine/core";
import type { ProgramAccount } from "@intent-engine/client";
import { parse, UsageError } from "../src/args.js";
import { EXIT_ALERTED, EXIT_OK, main } from "../src/main.js";
import { MIN_BALANCE_FORMAT } from "../src/monitor-args.js";
import { FILLER_MAX_FEE_BPS, FILLER_MIN_PROFIT, FILLER_RATE } from "../src/monitor-health.js";
import { cli, h, NOW, runtime, world } from "./harness.js";
import { listing } from "./monitor-transport.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const FILLER = readFileSync(join(ROOT, "scripts/filler.sh"), "utf8");
const BASELINE = "/srv/monitor/baseline.json";
const SOL = 1_000_000_000n;
const TEST = 1_000_000_000n;
const SOLD = SOL / 20n;
const BOUND = 600n;

type Alert = { kind: string; field: string; expected: unknown; observed: unknown; slot: number } & Record<string, unknown>;

const address = async () => (await generateKeyPairSigner()).address;

async function order(params: IntentParams, createdAgo: bigint, change: Partial<Intent> = {}): Promise<ProgramAccount> {
  const owner = await address();
  const intent: Intent = {
    ...getIntentDecoder().decode(new Uint8Array(getIntentSize())),
    owner,
    receiver: owner,
    rentPayer: owner,
    inputMint: NATIVE_MINT,
    outputMint: DEVNET_TEST_MINT,
    escrowed: SOLD,
    createdAt: NOW - createdAgo,
    expiresAt: NOW + 3_600n,
    kind: params.kind,
    status: IntentStatus.Open,
    version: INTENT_VERSION,
    feeBps: 5,
    params: encodeParams(params),
    ...change,
  };
  return { address: await address(), data: Uint8Array.from(getIntentEncoder().encode(intent)) };
}

const swap = (minOut: bigint, createdAgo: bigint, change: Partial<Intent> = {}) =>
  order({ kind: Kind.SwapExactIn, amountIn: SOLD, minOut }, createdAgo, change);

const PAID = ((SOLD * 9_995n) / 10_000n) * FILLER_RATE.out;
const FALL_PER_SECOND = 1_000_000n;
const FILLABLE_AFTER = 2_000n;

const auction = (startedAgo: bigint) => {
  const startOut = PAID - FILLER_MIN_PROFIT + FILLABLE_AFTER * FALL_PER_SECOND;
  const startTs = NOW - startedAgo;
  return order(
    { kind: Kind.DutchAuction, amountIn: SOLD, startOut, endOut: startOut - 2n * FILLABLE_AFTER * FALL_PER_SECOND, startTs, endTs: startTs + 2n * FILLABLE_AFTER },
    startedAgo,
  );
};

function serve(intents: ProgramAccount[]): void {
  h.through = { ...listing, intents: async () => intents };
}

async function monitor(extra: string[], polls = 1) {
  const rt = runtime({});
  let poll = 0;
  rt.sleep = async () => ++poll < polls;
  const out: string[] = [];
  const code = await main(["monitor", "--expect", BASELINE, ...(polls === 1 ? ["--once"] : ["--interval", "5"]), ...extra], rt, {
    out: (t) => out.push(t),
    err: () => undefined,
  });
  return { code, alerts: out.map((o) => JSON.parse(o) as Alert) };
}

describe("monitor health checks", () => {
  beforeEach(async () => {
    await world();
    h.through = listing;
    expect((await cli(["monitor", "--write-baseline", BASELINE], {})).code).toBe(EXIT_OK);
  });

  it("alerts when a wallet holds less SOL than its floor, naming the wallet and both amounts, and not when it holds the floor or more", async () => {
    const [low, enough, rich, empty] = await Promise.all([address(), address(), address(), address()]);
    h.svm.airdrop(low, lamports(SOL / 2n));
    h.svm.airdrop(enough, lamports(SOL));
    h.svm.airdrop(rich, lamports(3n * SOL));
    const floors = [low, enough, rich, empty].flatMap((wallet) => ["--min-balance", `${wallet}=1`]);
    const { code, alerts } = await monitor(floors);
    expect(code).toBe(EXIT_ALERTED);
    const slot = Number(h.svm.getClock().slot);
    expect(alerts).toEqual([
      { kind: "balance", field: low, expected: "at least 1 SOL", observed: "0.5 SOL", slot, wallet: low },
      { kind: "balance", field: empty, expected: "at least 1 SOL", observed: "0 SOL", slot, wallet: empty },
    ]);
    expect((await monitor(["--min-balance", `${rich}=2.5`, "--min-balance", `${enough}=1`])).code).toBe(EXIT_OK);
  });

  it("raises a low balance once while it stays low, not on every poll", async () => {
    const low = await address();
    h.svm.airdrop(low, lamports(SOL / 2n));
    let polled = 0;
    const rt = runtime({});
    rt.sleep = async () => {
      polled++;
      h.svm.airdrop(low, lamports(1_000n));
      h.svm.warpToSlot(h.svm.getClock().slot + 1n);
      return polled < 3;
    };
    const out: string[] = [];
    await main(["monitor", "--expect", BASELINE, "--min-balance", `${low}=1`], rt, { out: (t) => out.push(t), err: () => undefined });
    expect(out.map((o) => (JSON.parse(o) as Alert).kind)).toEqual(["balance"]);
  });

  it("alerts on a swap the filler would fill that has waited longer than the bound, naming the intent and the wait", async () => {
    const stale = await swap(5n * TEST, BOUND + 300n);
    const young = await swap(5n * TEST, BOUND - 300n);
    const atBound = await swap(5n * TEST, BOUND);
    const belowPrice = await swap(50n * TEST, BOUND + 300n);
    const otherToken = await swap(5n * TEST, BOUND + 300n, { outputMint: await address() });
    const feeAboveBound = await swap(5n * TEST, BOUND + 300n, { feeBps: FILLER_MAX_FEE_BPS + 1 });
    const filled = await swap(5n * TEST, BOUND + 300n, { status: IntentStatus.Filled });
    const expired = await swap(5n * TEST, BOUND + 300n, { expiresAt: NOW - 1n });
    const lateAuction = await auction(2_700n);
    const freshAuction = await auction(2_100n);
    serve([stale, young, atBound, belowPrice, otherToken, feeAboveBound, filled, expired, lateAuction, freshAuction]);
    const { code, alerts } = await monitor(["--max-swap-wait", String(BOUND)]);
    expect(code).toBe(EXIT_ALERTED);
    const slot = Number(h.svm.getClock().slot);
    const waited = (intent: Address, seconds: number) => ({
      kind: "swap-wait",
      field: "waited",
      expected: `filled within ${BOUND} seconds`,
      observed: `${seconds} seconds`,
      slot,
      intent,
      waited: seconds,
    });
    expect(alerts).toEqual([waited(stale.address, 900), waited(lateAuction.address, 700)]);
  });

  it("raises no swap alert for a fillable swap younger than the bound", async () => {
    serve([await swap(5n * TEST, BOUND - 1n), await auction(2_100n)]);
    expect(await monitor(["--max-swap-wait", String(BOUND)])).toEqual({ code: EXIT_OK, alerts: [] });
    serve([await swap(5n * TEST, BOUND + 1n)]);
    expect((await monitor(["--max-swap-wait", String(BOUND)])).alerts.map((a) => a["waited"])).toEqual([Number(BOUND) + 1]);
  });

  it("prices swaps as the devnet filler does", () => {
    const line = FILLER.split("\n").find((l) => l.trim().startsWith('"${cli[@]}" solve')) ?? "";
    const token = /^test_token=(\S+)$/m.exec(FILLER)?.[1] ?? "";
    const argv = line
      .trim()
      .replace('"${cli[@]}" ', "")
      .replaceAll('"$url"', "devnet")
      .replaceAll('"$keypair"', "filler.json")
      .replaceAll('"$interval"', "5")
      .replaceAll("$wrapped_sol", NATIVE_MINT)
      .replaceAll("$test_token", token)
      .replaceAll('"', "")
      .replace(/ &$/, "")
      .split(" ");
    expect(token).toBe(DEVNET_TEST_MINT);
    expect(parse(argv, {})).toMatchObject({
      name: "solve",
      issue: [{ inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT, out: FILLER_RATE.out, in: FILLER_RATE.in }],
      inventory: [],
      jupiter: undefined,
      minProfit: new Map([[DEVNET_TEST_MINT, FILLER_MIN_PROFIT]]),
      maxFeeBps: FILLER_MAX_FEE_BPS,
    });
  });

  it("reads floors as SOL and the bound as seconds, and refuses them beside --write-baseline", async () => {
    const wallet = await address();
    expect(parse(["monitor", "--expect", BASELINE, "--min-balance", `${wallet}=0.25`, "--max-swap-wait", "90"], {})).toMatchObject({
      watch: { minBalance: new Map([[wallet, SOL / 4n]]), maxSwapWait: 90 },
    });
    expect(parse(["monitor", "--expect", BASELINE], {})).toMatchObject({ watch: { minBalance: new Map(), maxSwapWait: null } });
    for (const bad of [`${wallet}`, `${wallet}=0`, `${wallet}=-1`, `${wallet}=0.0000000001`, `=1`]) {
      expect(() => parse(["monitor", "--expect", BASELINE, "--min-balance", bad], {})).toThrow(MIN_BALANCE_FORMAT);
    }
    expect(() => parse(["monitor", "--expect", BASELINE, "--min-balance", `${wallet}=1`, "--min-balance", `${wallet}=2`], {})).toThrow(UsageError);
    expect(() => parse(["monitor", "--expect", BASELINE, "--max-swap-wait", "0"], {})).toThrow(UsageError);
    expect(() => parse(["monitor", "--write-baseline", BASELINE, "--max-swap-wait", "60"], {})).toThrow(UsageError);
    expect(() => parse(["monitor", "--write-baseline", BASELINE, "--min-balance", `${wallet}=1`], {})).toThrow(UsageError);
  });
});
