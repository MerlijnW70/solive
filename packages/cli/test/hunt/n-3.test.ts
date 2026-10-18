import { type Address, generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { EVENT_IX_TAG, getIntentCreatedEventEncoder, getIntentFilledEventEncoder } from "@intent-engine/core";
import type { EngineTransaction } from "@intent-engine/client";
import { EXIT_OK, main } from "../../src/main.js";
import { cli, h, NOW, runtime, world } from "../harness.js";

const BASELINE = "/srv/hunt-n/rate-baseline.json";
const RECENT = NOW + 1_000n;

type Alert = { kind: string } & Record<string, unknown>;

const advance = () => h.svm.warpToSlot(h.svm.getClock().slot + 1n);

function event(bytes: ArrayLike<number>): Uint8Array {
  return new Uint8Array([...EVENT_IX_TAG, ...Array.from(bytes)]);
}

function created(intent: Address): Uint8Array {
  return event(
    getIntentCreatedEventEncoder().encode({
      intent,
      owner: intent,
      nonce: 0n,
      kind: 1,
      inputMint: intent,
      outputMint: intent,
      receiver: intent,
      escrowed: 0n,
      expiresAt: 0n,
      rentPayer: intent,
      flags: 0,
      bounty: 0,
      createFee: 0,
    }),
  );
}

function filled(intent: Address, amountIn: bigint): Uint8Array {
  return event(
    getIntentFilledEventEncoder().encode({
      intent,
      owner: intent,
      solver: intent,
      receiver: intent,
      solverInput: intent,
      amountIn,
      delivered: amountIn,
      required: amountIn,
      fee: 0n,
      net: amountIn,
      filled: amountIn,
      remaining: 0n,
      partnerFee: 0n,
    }),
  );
}

async function fillTx(signature: string, slot: bigint): Promise<EngineTransaction> {
  const intent = (await generateKeyPairSigner()).address;
  return { signature, slot, blockTime: RECENT, failed: false, emitted: [created(intent), filled(intent, 1n)] };
}

async function burst(prefix: string, count: number, base: bigint): Promise<EngineTransaction[]> {
  const transactions: EngineTransaction[] = [];
  for (let i = 0; i < count; i++) {
    transactions.push(await fillTx(`${prefix}-${i}`, base + BigInt(i)));
  }
  return transactions;
}

async function watch(argv: string[], polls: number, between: (poll: number) => void | Promise<void>) {
  const rt = runtime({});
  let poll = 0;
  rt.sleep = async (seconds) => {
    h.sleeps.push(seconds);
    poll++;
    await between(poll);
    return poll < polls;
  };
  const out: string[] = [];
  const code = await main(argv, rt, { out: (t) => out.push(t), err: () => undefined });
  return { code, alerts: out.map((o) => JSON.parse(o) as Alert) };
}

describe("hunt N operations monitor rate dedup", () => {
  it("N-3: a second distinct burst of fills after the first goes unreported", async () => {
    await world();
    const written = await cli(["monitor", "--write-baseline", BASELINE], {});
    expect(written.code).toBe(EXIT_OK);

    h.engineLog = await burst("first", 4, 40n);
    const run = await watch(["monitor", "--expect", BASELINE, "--interval", "5", "--max-fills", "3"], 2, async (poll) => {
      advance();
      if (poll === 1) {
        h.engineLog = await burst("second", 5, 60n);
      }
    });

    const rateAlerts = run.alerts.filter((alert) => alert.kind === "fill-rate");
    expect(rateAlerts.length).toBe(2);
  });
});
