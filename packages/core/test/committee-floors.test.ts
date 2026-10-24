import { AccountRole, type Address, createNoopSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  buildCreateIntent,
  buildCreateIntentSigned,
  buildSetCommitteeFloor,
  committeeFloorOf,
  committeeFloors,
  countsAsCommittee,
  FLOOR_THRESHOLD,
  getConfigSize,
  getSetCommitteeFloorInstructionDataDecoder,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  Kind,
  MAX_COMMITTEE_FLOORS,
  needsCommittee,
  TOKEN_PROGRAM_ADDRESS,
  U64_MAX,
} from "../src/index.js";
import { InvalidInput } from "../src/errors.js";

const MINT = "So11111111111111111111111111111111111111112" as Address;
const OUT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" as Address;
const EMPTY = "11111111111111111111111111111111" as Address;
const COMMITTEE = "11111111111111111111111111111113" as Address;

const table = (entries: [Address, bigint][]) => {
  const floorMints: Address[] = Array.from({ length: MAX_COMMITTEE_FLOORS }, () => EMPTY);
  const floorAmounts: bigint[] = Array.from({ length: MAX_COMMITTEE_FLOORS }, () => 0n);
  entries.forEach(([mint, floor], i) => {
    floorMints[i] = mint;
    floorAmounts[i] = floor;
  });
  return { floorMints, floorAmounts };
};

describe("committee floors", () => {
  it("read the floor of each mint from the config table, zero meaning none", () => {
    expect(getConfigSize()).toBe(536);
    expect(committeeFloors(table([]))).toEqual([]);
    const config = table([[OUT, 0n], [MINT, 500n]]);
    expect(committeeFloors(config)).toEqual([{ mint: MINT, floor: 500n }]);
    expect(committeeFloorOf(config, MINT)).toBe(500n);
    expect(committeeFloorOf(config, OUT)).toBe(0n);
    expect(committeeFloorOf(table([]), MINT)).toBe(0n);
  });

  it("need a committee at or above the floor and count only a threshold of two or more", () => {
    expect(FLOOR_THRESHOLD).toBe(2);
    expect(needsCommittee(500n, 499n)).toBe(false);
    expect(needsCommittee(500n, 500n)).toBe(true);
    expect(needsCommittee(500n, 501n)).toBe(true);
    expect(needsCommittee(0n, 1n << 63n)).toBe(false);
    expect(countsAsCommittee(null)).toBe(false);
    expect(countsAsCommittee({ threshold: 1 })).toBe(false);
    expect(countsAsCommittee({ threshold: 2 })).toBe(true);
  });

  it("set committee floor carries the mint and floor and refuses an amount out of range", async () => {
    const admin = createNoopSigner("11111111111111111111111111111112" as Address);
    const ix = await buildSetCommitteeFloor({ admin, mint: MINT, floor: 500n });
    expect(getSetCommitteeFloorInstructionDataDecoder().decode(ix.data ?? new Uint8Array()).floor).toBe(500n);
    expect(ix.accounts).toContainEqual({ address: MINT, role: AccountRole.READONLY });
    await expect(buildSetCommitteeFloor({ admin, mint: MINT, floor: -1n })).rejects.toThrow(InvalidInput);
    await expect(buildSetCommitteeFloor({ admin, mint: MINT, floor: 1n << 64n })).rejects.toThrow(InvalidInput);
    for (const floor of [0n, U64_MAX]) {
      const edge = await buildSetCommitteeFloor({ admin, mint: MINT, floor });
      expect(getSetCommitteeFloorInstructionDataDecoder().decode(edge.data ?? new Uint8Array()).floor).toBe(floor);
    }
  });

  it("a create names the committee when given and the program id in its place when not", async () => {
    const owner = createNoopSigner("11111111111111111111111111111112" as Address);
    const spec = {
      owner,
      treasury: owner.address,
      maxCreateFee: 0,
      maxBounty: 0,
      nonce: 0n,
      params: { kind: Kind.AttestedResult, amountIn: 10n, minResult: 1n, maxResult: 1n, attestor: COMMITTEE, specHash: new Uint8Array(32), judgeFee: 0n },
      expiresAt: 2_000_000_000n,
      inputMint: MINT,
      outputMint: OUT,
      inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
    } as const;
    const without = await buildCreateIntent(spec);
    const judged = await buildCreateIntent({ ...spec, committee: COMMITTEE });
    expect(without.accounts.length).toBe(judged.accounts.length);
    expect(without.accounts.at(-4)).toEqual({ address: INTENT_ENGINE_PROGRAM_ADDRESS, role: AccountRole.READONLY });
    expect(judged.accounts.at(-4)).toEqual({ address: COMMITTEE, role: AccountRole.READONLY });
    expect(without.accounts.slice(0, -4)).toEqual(judged.accounts.slice(0, -4));
    const signed = { ...spec, payer: owner, owner: owner.address, submitBy: 2_000_000_000n };
    const signedWithout = await buildCreateIntentSigned(signed);
    const signedJudged = await buildCreateIntentSigned({ ...signed, committee: COMMITTEE });
    expect(signedWithout.accounts.at(-4)).toEqual({ address: INTENT_ENGINE_PROGRAM_ADDRESS, role: AccountRole.READONLY });
    expect(signedJudged.accounts.at(-4)).toEqual({ address: COMMITTEE, role: AccountRole.READONLY });
  });
});
