import { describe, expect, it } from "vitest";
import { feeBpsFor, maxFeeBpsFor, MAX_FEE_BPS, MAX_ATTESTED_FEE_BPS, IntentStatus, findAssociatedTokenAddress, IntentCoreError, Kind } from "../src/index.js";
import {
  encodePartner,
  nextEpoch,
  remainingOf,
  U64_MAX,
  buildCancelIntent,
  buildCloseIntent,
  buildCreateIntent,
  buildExpireIntent,
  buildFillIntent,
  buildFlashFill,
  getBeginFillInstructionDataDecoder,
  getCreateIntentInstructionDataDecoder,
  getEndFillInstructionDataDecoder,
  getFillIntentInstructionDataDecoder,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  validateIxAgainstIdl,
  MAX_CRANK_BOUNTY,
  MAX_CREATE_FEE,
} from "../src/internal.js";
import { InvalidInput } from "../src/errors.js";
import { feeRecipient, idl, inputMint, meta, outputMint, owner, ownerSigner, solver, swap, TOKEN } from "./builder-fixtures.js";

describe("foundation fields", () => {
  const create = {
    owner: ownerSigner,
    treasury: feeRecipient,
    maxCreateFee: MAX_CREATE_FEE,
    maxBounty: MAX_CRANK_BOUNTY,
    nonce: 42n,
    params: swap,
    expiresAt: 1_700_003_600n,
    inputMint,
    outputMint,
    inputTokenProgram: TOKEN,
    outputTokenProgram: TOKEN,
  };
  const fill = {
    solver,
    owner,
    nonce: 42n,
    inputMint,
    outputMint,
    inputTokenProgram: TOKEN,
    outputTokenProgram: TOKEN,
    receiver: owner,
    solverOutput: solver.address,
    solverInput: solver.address,
    amountIn: 400n,
    amountOut: 300n,
    maxFeeBps: 100,
  };
  const ref = { owner, nonce: 42n, inputMint, tokenProgram: TOKEN };
  const unknown = new IntentCoreError("ExtUnknown");
  const ext = new Uint8Array([1, 0, 0]);

  it("refuse flags and extensions the program would reject before anything is signed", async () => {
    await expect(buildCreateIntent({ ...create, flags: 1 })).rejects.toThrow(new IntentCoreError("FlagsUnknown"));
    await expect(buildCreateIntent({ ...create, flags: 0x10000 })).rejects.toThrow(InvalidInput);
    await expect(buildCreateIntent({ ...create, ext: new Uint8Array([2, 0, 0]) })).rejects.toThrow(unknown);
    await expect(buildCreateIntent({ ...create, ext })).rejects.toThrow(new IntentCoreError("ExtMalformed"));
    const partner = { key: feeRecipient, bps: 30 };
    await expect(buildCreateIntent({ ...create, ext: encodePartner(partner), partner })).rejects.toThrow(
      "pass either raw extension bytes or a partner, not both",
    );
    const widest = encodePartner({ ...partner, bps: 100 });
    const accepted = await buildCreateIntent({ ...create, ext: widest });
    expect(accepted.programAddress).toBe(INTENT_ENGINE_PROGRAM_ADDRESS);
    expect(Array.from(getCreateIntentInstructionDataDecoder().decode(accepted.data ?? new Uint8Array()).args.ext)).toEqual(Array.from(widest));
    await expect(buildCreateIntent({ ...create, ext: new Uint8Array(513) })).rejects.toThrow(
      new IntentCoreError("ExtTooLong"),
    );
    await expect(buildFillIntent({ ...fill, ext })).rejects.toThrow(unknown);
    await expect(buildFlashFill({ ...fill, beginExt: ext })).rejects.toThrow(unknown);
    await expect(buildFlashFill({ ...fill, endExt: ext })).rejects.toThrow(unknown);
    await expect(buildCancelIntent({ ...ref, owner: ownerSigner, ext })).rejects.toThrow(unknown);
    await expect(buildExpireIntent({ ...ref, cranker: solver, ext })).rejects.toThrow(unknown);
    await expect(buildCloseIntent({ ...ref, cranker: solver, ext })).rejects.toThrow(unknown);
  });

  it("carry a partner from create to every fill path", async () => {
    const partner = { key: feeRecipient, bps: 30 };
    const created = getCreateIntentInstructionDataDecoder().decode(
      (await buildCreateIntent({ ...create, partner })).data ?? new Uint8Array(),
    );
    expect(Array.from(created.args.ext)).toEqual(Array.from(encodePartner(partner)));
    const partnerTo = await findAssociatedTokenAddress({ owner: feeRecipient, mint: inputMint, tokenProgram: TOKEN });
    const at = (name: string, account: string) =>
      idl.instructions.find((x) => x.name === name)?.accounts.findIndex((a) => a.name === account) ?? -1;
    const direct = await buildFillIntent({ ...fill, partner: feeRecipient });
    expect(meta(direct, at("fill_intent", "partner_to")).address).toBe(partnerTo);
    expect(meta(await buildFillIntent(fill), at("fill_intent", "partner_to")).address).toBe(
      INTENT_ENGINE_PROGRAM_ADDRESS,
    );
    const [begin] = await buildFlashFill({ ...fill, partner: feeRecipient });
    expect(meta(begin ?? direct, at("begin_fill", "partner_to")).address).toBe(partnerTo);
    for (const ix of [direct, begin ?? direct]) {
      expect(validateIxAgainstIdl(ix, idl)).toEqual([]);
    }
  });

  it("encode the taken amount, zero flags and empty extensions", async () => {
    const created = getCreateIntentInstructionDataDecoder().decode((await buildCreateIntent(create)).data ?? new Uint8Array());
    expect(created.args.flags).toBe(0);
    expect(created.args.ext).toHaveLength(0);
    const filled = getFillIntentInstructionDataDecoder().decode((await buildFillIntent(fill)).data ?? new Uint8Array());
    expect(filled).toMatchObject({ amountIn: 400n, amountOut: 300n, maxFeeBps: 100 });
    expect(filled.ext).toHaveLength(0);
    const [begin, end] = await buildFlashFill(fill);
    const begun = getBeginFillInstructionDataDecoder().decode(begin?.data ?? new Uint8Array());
    expect(begun).toMatchObject({ amountIn: 400n, endIndex: 1, maxFeeBps: 100 });
    expect(getEndFillInstructionDataDecoder().decode(end?.data ?? new Uint8Array()).ext).toHaveLength(0);
  });
});

describe("epoch advancement", () => {
  it("jumps by an unpredictable amount drawn from 48 bits of entropy", () => {
    expect(nextEpoch(5n, new Uint8Array(6))).toBe(6n);
    expect(nextEpoch(5n, new Uint8Array([0, 0, 0, 0, 1, 0]))).toBe(5n + 257n);
    expect(nextEpoch(0n, new Uint8Array(6).fill(0xff))).toBe(2n ** 48n);
    expect(nextEpoch(U64_MAX - 1n, new Uint8Array(6).fill(0xff))).toBe(U64_MAX);
    expect(nextEpoch(U64_MAX - 3n, new Uint8Array([0, 0, 0, 0, 0, 2]))).toBe(U64_MAX);
    expect(nextEpoch(U64_MAX - 3n, new Uint8Array([0, 0, 0, 0, 0, 3]))).toBe(U64_MAX - 2n);
    expect(nextEpoch(U64_MAX - 3n, new Uint8Array([0, 0, 0, 0, 0, 4]))).toBe(U64_MAX - 1n);
    const drawn = new Set(Array.from({ length: 64 }, () => nextEpoch(0n)));
    expect(drawn.size).toBeGreaterThan(60);
    for (const e of drawn) {
      expect(e > 0n && e <= 2n ** 48n).toBe(true);
    }
  });

  it("refuses an epoch with no successor or the wrong amount of entropy", () => {
    expect(() => nextEpoch(U64_MAX)).toThrow(`no epoch follows ${U64_MAX}`);
    expect(() => nextEpoch(-1n)).toThrow(InvalidInput);
    expect(() => nextEpoch(1n, new Uint8Array(5))).toThrow("epoch entropy must be 6 bytes");
    expect(() => nextEpoch(1n, new Uint8Array(7))).toThrow(InvalidInput);
  });
});

describe("remaining escrow", () => {
  it("is what was escrowed minus what was filled, and never negative", () => {
    expect(remainingOf({ escrowed: 400n, filled: 0n })).toBe(400n);
    expect(remainingOf({ escrowed: 400n, filled: 150n })).toBe(250n);
    expect(remainingOf({ escrowed: 400n, filled: 400n })).toBe(0n);
    expect(() => remainingOf({ escrowed: 400n, filled: 401n })).toThrow("an intent cannot have filled 401 of 400");
  });
});

describe("fee resolution", () => {
  const config = { feeBps: 5, kindFeeMask: 0b1_0010, kindFeeBps: [7, 8, 9, 0] };

  it("uses a kind's own fee only where the mask names that kind, exactly as the program does", () => {
    expect(feeBpsFor(config, Kind.SwapExactIn)).toBe(7);
    expect(feeBpsFor(config, Kind.LimitOrder)).toBe(5);
    expect(feeBpsFor(config, Kind.DutchAuction)).toBe(5);
    expect(feeBpsFor(config, Kind.AttestedResult)).toBe(0);
    expect(feeBpsFor({ ...config, kindFeeMask: 0 }, Kind.SwapExactIn)).toBe(5);
    expect(feeBpsFor({ ...config, kindFeeMask: 0b0_1100 }, Kind.DutchAuction)).toBe(9);
    expect(feeBpsFor({ ...config, kindFeeMask: 0b0_1100 }, Kind.LimitOrder)).toBe(8);
  });

  it("caps the attested fee at 300 bps and every other kind at 100, as the program does", () => {
    expect([MAX_FEE_BPS, MAX_ATTESTED_FEE_BPS]).toEqual([100, 300]);
    expect([Kind.SwapExactIn, Kind.LimitOrder, Kind.DutchAuction, Kind.AttestedResult].map(maxFeeBpsFor)).toEqual([100, 100, 100, 300]);
  });

  it("refuses a table that does not cover the kind", () => {
    expect(() => feeBpsFor({ ...config, kindFeeBps: [7] }, Kind.AttestedResult)).toThrow(
      "no fee is configured for kind 4",
    );
    expect(IntentStatus).toEqual({ Open: 0, Filled: 1, Cancelled: 2, Expired: 3, Filling: 4 });
  });
});
