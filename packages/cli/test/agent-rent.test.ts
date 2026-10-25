import { type Address, generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { getIntentSize } from "@intent-engine/core/internal";
import { type Transport } from "@intent-engine/client";
import { memoized } from "@intent-engine/client/internal";
import {
  createCost,
  MAX_RENT_PER_BYTE,
  MIN_RENT_PER_BYTE,
  rentFor,
  rentRate,
  SIGNATURE_FEE,
  UnsupportedRent,
  unsupportedRent,
  unsupportedThreshold,
  VAULT_BYTES,
} from "../src/agent/budget.js";
import { fundingRent } from "../src/crank.js";
import { parse } from "../src/args.js";
import type { Runtime } from "../src/runtime.js";
import { type SolveCommand, solverOptions } from "../src/solve-commands.js";

const RENT_SYSVAR = "SysvarRent111111111111111111111111111111111";

function rentServing(perByteYear: bigint | null, threshold = 1) {
  const reads = { count: 0 };
  const data = new Uint8Array(17);
  const view = new DataView(data.buffer);
  view.setBigUint64(0, perByteYear ?? 0n, true);
  view.setFloat64(8, threshold, true);
  const transport = {
    getAccount: async (address: Address) => {
      if (address !== RENT_SYSVAR) {
        throw new Error(`unexpected read of ${address}`);
      }
      reads.count += 1;
      return perByteYear === null ? null : { owner: "Sysvar1111111111111111111111111111111111111" as Address, data, lamports: 1n };
    },
  } as unknown as Transport;
  return { transport, reads };
}

const refusalOf = async (transport: Transport): Promise<Error> => {
  const refusal = await rentRate(transport).catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(UnsupportedRent);
  return refusal as Error;
};

describe("live rent", () => {
  it("price rent the way the runtime does and count every lamport a create costs", () => {
    const old = { perByteYear: 3_480n, threshold: 2 };
    expect([VAULT_BYTES, SIGNATURE_FEE]).toEqual([170, 5_000n]);
    expect(rentFor(165, old)).toBe(2_039_280n);
    expect(rentFor(0, old)).toBe(890_880n);
    expect(rentFor(165, { perByteYear: 5_080n, threshold: 1 })).toBe(1_488_440n);
    expect(createCost({ createFee: 7, crankBounty: 11 }, old)).toBe(18n + (BigInt(getIntentSize()) + 128n) * 6_960n + 2_074_080n + 5_000n);
  });

  it("reserve rent for a create at the cluster's live rate, read once however many budgets ask", async () => {
    const { transport, reads } = rentServing(5_080n);
    const rates = await Promise.all([rentRate(transport), rentRate(memoized(transport)), rentRate(transport)]);
    expect(rates).toEqual([1, 2, 3].map(() => ({ perByteYear: 5_080n, threshold: 1 })));
    const costs = [];
    for (const economics of [{ createFee: 0, crankBounty: 0 }, { createFee: 7, crankBounty: 11 }]) {
      costs.push(createCost(economics, await rentRate(memoized(transport))));
    }
    expect(costs).toEqual([
      (BigInt(getIntentSize()) + 128n) * 5_080n + (170n + 128n) * 5_080n + 5_000n,
      18n + (BigInt(getIntentSize()) + 128n) * 5_080n + (170n + 128n) * 5_080n + 5_000n,
    ]);
    expect((170n + 128n) * 5_080n).toBe(1_513_840n);
    expect(reads.count).toBe(1);
  });

  it("round a fractional rate down once over the whole account, as the runtime does", async () => {
    const { transport } = rentServing(3_387n, 1.5);
    const rent = await rentRate(transport);
    expect(rentFor(165, rent)).toBe(1_488_586n);
    expect(rentFor(VAULT_BYTES, rent)).toBe(1_513_989n);
    expect(createCost({ createFee: 7, crankBounty: 11 }, rent)).toBe(
      18n + BigInt(Math.floor((getIntentSize() + 128) * 3_387 * 1.5)) + 1_513_989n + 5_000n,
    );
  });

  it("fund the crank's spare token account with exactly its rent-exempt minimum", async () => {
    expect(await fundingRent(rentServing(5_080n).transport)).toBe(1_488_440n);
    expect(await fundingRent(rentServing(3_387n, 1.5).transport)).toBe(1_488_586n);
    expect(await fundingRent(rentServing(3_480n, 2).transport)).toBe(2_039_280n);
  });

  it("accept rates from the floor to the old constant and refuse any other rate, threshold or a missing sysvar", async () => {
    expect([MIN_RENT_PER_BYTE, MAX_RENT_PER_BYTE]).toEqual([696, 6_960]);
    for (const [perByteYear, threshold] of [
      [696n, 1],
      [6_960n, 1],
      [464n, 1.5],
      [3_480n, 2],
    ] as const) {
      expect(await rentRate(rentServing(perByteYear, threshold).transport)).toEqual({ perByteYear, threshold });
    }
    for (const [perByteYear, threshold, seen] of [
      [695n, 1, "695"],
      [6_961n, 1, "6961"],
      [4_641n, 1.5, "6961.5"],
    ] as const) {
      const { transport, reads } = rentServing(perByteYear, threshold);
      const refusal = await refusalOf(transport);
      expect(refusal.message).toBe(unsupportedRent(Number(seen)));
      expect(refusal.message).toBe(`the cluster charges ${seen} lamports of rent per byte; this client prices rent only from 696 to 6960`);
      await expect(rentRate(transport)).rejects.toThrow(seen);
      expect(reads.count).toBe(2);
    }
    for (const [threshold, seen] of [
      [Number.NaN, "NaN"],
      [Number.POSITIVE_INFINITY, "Infinity"],
      [0, "0"],
      [-2, "-2"],
    ] as const) {
      const refusal = await refusalOf(rentServing(3_480n, threshold).transport);
      expect(refusal.message).toBe(unsupportedThreshold(threshold));
      expect(refusal.message).toBe(
        `the cluster's rent sysvar reports an exemption threshold of ${seen}; this client prices rent only with a positive finite threshold`,
      );
    }
    await expect(rentRate(rentServing(null).transport)).rejects.toThrow("the rent sysvar is missing");
  });

  it("hand the solver the cluster's rent sysvar through the same bounds", async () => {
    const signer = await generateKeyPairSigner();
    const runtime = { loadSigner: async () => signer, env: {}, fetch: async () => new Response("{}"), entropy: () => 0 } as unknown as Runtime;
    const command = parse(["solve", "--keypair", "k", "--jupiter", "https://" + "q.example", "--min-profit", "So11111111111111111111111111111111111111112=10"], {}) as SolveCommand;
    const live = rentServing(5_080n);
    const { chain } = await solverOptions(command, runtime, live.transport);
    expect(await chain.rent?.()).toEqual({ perByteYear: 5_080n, threshold: 1 });
    expect(await chain.rent?.()).toEqual({ perByteYear: 5_080n, threshold: 1 });
    expect(live.reads.count).toBe(1);
    const strange = await solverOptions(command, runtime, rentServing(6_961n).transport);
    await expect(strange.chain.rent?.()).rejects.toThrow(unsupportedRent(6_961));
  });
});
