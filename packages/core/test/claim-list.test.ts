import { createNoopSigner, generateKeyPairSigner, type Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  buildClaimJob,
  buildClaimsWithList,
  buildExtendClaimants,
  buildSettleClaims,
  buildStandBy,
  checkClaimants,
  checkListed,
  CLAIM_LIST_CHUNK,
  claimantChunks,
  claimListAddress,
  findClaimListPda,
  IntentCoreError,
  MAX_CLAIMANTS,
} from "../src/index.js";

const NONE = "11111111111111111111111111111111" as Address;

async function wallets(count: number): Promise<Address[]> {
  return Promise.all(Array.from({ length: count }, async () => (await generateKeyPairSigner()).address));
}

const code = (run: () => void): string | undefined => {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof IntentCoreError ? error.code : String(error);
  }
};

describe("claim lists", () => {
  it("names 1 to 32 distinct wallets, never the empty address, and never more than its size", async () => {
    const [a, b] = await wallets(2);
    expect(MAX_CLAIMANTS).toBe(32);
    expect(code(() => checkClaimants(1, [a as Address]))).toBeUndefined();
    expect(code(() => checkClaimants(32, []))).toBeUndefined();
    for (const [size, workers] of [
      [0, []],
      [33, [a]],
      [1, [a, b]],
      [2, [a, a]],
      [1, [NONE]],
      [1.5, [a]],
    ] as [number, Address[]][]) {
      expect(code(() => checkClaimants(size, workers)), `${size} ${workers.length}`).toBe("ClaimListInvalid");
    }
  });

  it("admits only a listed wallet, and only once the list is complete", async () => {
    const [a, b] = (await wallets(2)) as [Address, Address];
    expect(code(() => checkListed({ size: 2, workers: [a] }, a))).toBe("ClaimListIncomplete");
    expect(code(() => checkListed({ size: 2, workers: [a, b] }, b))).toBeUndefined();
    expect(code(() => checkListed({ size: 1, workers: [a] }, b))).toBe("NotListed");
  });

  it("splits a list into parts of at most one transaction's worth, the first in the instruction that opens claims", async () => {
    const workers = await wallets(MAX_CLAIMANTS);
    expect(claimantChunks(workers).map((part) => part.length)).toEqual([CLAIM_LIST_CHUNK, MAX_CLAIMANTS - CLAIM_LIST_CHUNK]);
    expect(claimantChunks([])).toEqual([[]]);
    expect(claimantChunks(workers.slice(0, 4), 2)).toEqual([workers.slice(0, 2), workers.slice(2, 4)]);
    const owner = createNoopSigner((await generateKeyPairSigner()).address);
    const intent = (await generateKeyPairSigner()).address;
    const sends = await buildClaimsWithList({ owner, intent, maxSecs: 600, stake: 1n, workers });
    expect(sends.map((ixs) => ixs.length)).toEqual([1, 1]);
    await expect(buildExtendClaimants({ owner, intent, workers: [] })).rejects.toThrow(IntentCoreError);
    await expect(buildExtendClaimants({ owner, intent, workers })).resolves.toBeDefined();
    await expect(buildExtendClaimants({ owner, intent, workers: [...workers, intent] })).rejects.toThrow(IntentCoreError);
    await expect(buildClaimsWithList({ owner, intent, maxSecs: 600, stake: 1n, workers: [] })).rejects.toThrow(IntentCoreError);
  });

  it("passes the list account to a claim, a stand-by and a settle only when given, at the address its escrow derives", async () => {
    const worker = createNoopSigner((await generateKeyPairSigner()).address);
    const [intent, owner] = (await wallets(2)) as [Address, Address];
    const claimList = await claimListAddress(intent);
    expect(claimList).toBe((await findClaimListPda({ intent }))[0]);
    const listed = (ix: { accounts: readonly { address: Address }[] }) => ix.accounts.some((meta) => meta.address === claimList);
    expect(listed(await buildClaimJob({ worker, intent, owner, secs: 60, claimList }))).toBe(true);
    expect(listed(await buildClaimJob({ worker, intent, owner, secs: 60 }))).toBe(false);
    expect(listed(await buildStandBy({ worker, intent, seq: 0, secs: 60, claimList }))).toBe(true);
    expect(listed(await buildStandBy({ worker, intent, seq: 0, secs: 60 }))).toBe(false);
    expect(listed(await buildSettleClaims({ intent, owner, claimList }))).toBe(true);
    expect(listed(await buildSettleClaims({ intent, owner }))).toBe(false);
  });
});
