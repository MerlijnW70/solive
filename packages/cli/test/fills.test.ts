import { type Address, generateKeyPairSigner } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { EVENT_IX_TAG, findIntentPda, getIntentCreatedEventEncoder, getIntentFilledEventEncoder } from "@intent-engine/core/internal";
import type { EngineTransaction } from "@intent-engine/client";
import { bestOf, type Fill, medianOf, openingAsk, recentFills } from "../src/agent/wallet/fills.js";
import { EXIT_OK } from "../src/main.js";
import { cli, ESCROW, h, NOW, transport, type World, world } from "./harness.js";

const tagged = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);

const created = (intent: Address, inputMint: Address, outputMint: Address) =>
  tagged(
    getIntentCreatedEventEncoder().encode({
      intent,
      owner: intent,
      nonce: 0n,
      kind: 1,
      inputMint,
      outputMint,
      receiver: intent,
      escrowed: 0n,
      expiresAt: 0n,
      rentPayer: intent,
      flags: 0,
      bounty: 0,
      createFee: 0,
    }),
  );

const filled = (intent: Address, amountIn: bigint, delivered: bigint) =>
  tagged(
    getIntentFilledEventEncoder().encode({
      intent,
      owner: intent,
      solver: intent,
      receiver: intent,
      solverInput: intent,
      amountIn,
      delivered,
      required: delivered,
      fee: 0n,
      net: delivered,
      filled: amountIn,
      remaining: 0n,
      partnerFee: 0n,
    }),
  );

const tx = (signature: string, emitted: Uint8Array[]): EngineTransaction => ({ signature, slot: 1n, blockTime: null, failed: false, emitted });

const fill = (intent: string, amountIn: bigint, delivered: bigint): Fill => ({ intent: intent as Address, amountIn, delivered, signature: intent, blockTime: null });

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) {
    return [[...items]];
  }
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

describe("recent fills of a pair", () => {
  let w: World;

  beforeEach(async () => {
    w = await world();
  });

  it("reads the pair of an intent created before the scanned history from its account, and skips other pairs and empty fills", async () => {
    const swap = await cli(
      ["create", "swap", "--keypair", "owner.json", "--nonce", "1", "--input-mint", w.inputMint, "--output-mint", w.outputMint, "--expires-at", String(NOW + 3_600n), "--amount-in", ESCROW.toString(), "--min-out", "1", "--units", "raw", "--yes"],
      { "owner.json": w.owner },
    );
    expect(swap.code).toBe(EXIT_OK);
    const [older] = await findIntentPda({ owner: w.owner.address, nonce: 1n });
    const other = (await generateKeyPairSigner()).address;
    const empty = (await generateKeyPairSigner()).address;
    h.engineLog = [
      tx("older", [filled(older, 5n, 7n)]),
      tx("other", [created(other, w.outputMint, w.inputMint), filled(other, 3n, 4n)]),
      tx("empty", [created(empty, w.inputMint, w.outputMint), filled(empty, 0n, 0n)]),
    ];
    expect((await recentFills(transport, w.inputMint, w.outputMint)).map(({ intent, amountIn, delivered }) => [intent, amountIn, delivered])).toEqual([[older, 5n, 7n]]);
  });
});

describe("ranking fills by rate", () => {
  const high = fill("high", 2n, 3n);
  const mid = fill("mid", 4n, 5n);
  const even = fill("even", 3n, 3n);
  const same = fill("same", 5n, 5n);

  it("takes the best rate as best and the lower middle as median, keeping equal rates in the order given", () => {
    for (const order of permutations([high, mid, even, same])) {
      const later = order.indexOf(even) < order.indexOf(same) ? same : even;
      expect([order.map((f) => f.intent).join(" "), bestOf(order)?.intent, medianOf(order)?.intent]).toEqual([order.map((f) => f.intent).join(" "), "high", later.intent]);
    }
  });

  it("compares rates exactly, not by whole-number division", () => {
    for (const order of permutations([fill("a", 3n, 4n), fill("b", 4n, 5n), fill("c", 5n, 6n)])) {
      expect([bestOf(order)?.intent, medianOf(order)?.intent]).toEqual(["a", "b"]);
    }
  });
});

describe("opening ask of a swap", () => {
  it("asks the blind markup without fills, the seen rate with headroom above it, and never more than the cap", () => {
    expect(openingAsk([], 1_000n, 1_000n)).toBe(1_250n);
    expect(openingAsk([fill("low", 10n, 11n)], 1_000n, 1_000n)).toBe(1_250n);
    expect(openingAsk([fill("seen", 10n, 15n)], 1_000n, 1_000n)).toBe(1_530n);
    expect(openingAsk([fill("rich", 10n, 30n)], 1_000n, 1_000n)).toBe(2_000n);
  });
});
