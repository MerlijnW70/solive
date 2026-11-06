import { type Address, createNoopSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  boardViewArmed,
  buildOpenClaims,
  buildOpenClaimsListed,
  buildRejectDelivery,
  buildRequestCancel,
  claimSlot,
  deliveryBookAddress,
  getOpenClaimsInstructionDataDecoder,
  getRejectDeliveryInstructionDataDecoder,
  IntentCoreError,
  MAX_REVIEW_SECS,
  MIN_REVIEW_SECS,
  REJECT_PREIMAGE_LEN,
  REJECT_TAG,
  rejectDeliveryPreimage,
  stakeReceiverOnCancel,
  stakeReceiverOnSettle,
  takeUntil,
  validateIxAgainstIdl,
} from "../src/internal.js";
import { idl, meta, owner, ownerSigner } from "./builder-fixtures.js";

const intent = "SysvarRent111111111111111111111111111111111" as Address;
const announcement = "SysvarC1ock11111111111111111111111111111111" as Address;
const worker = "Stake11111111111111111111111111111111111111" as Address;
const FLOOR = 890_880n;

const accountNamed = (name: string, account: string) =>
  idl.instructions.find((x) => x.name === name)?.accounts.findIndex((a) => a.name === account) ?? -1;

describe("fair-close builders", () => {
  it("opens claims with review terms and the delivery book the program reads", async () => {
    const ix = await buildOpenClaims({ owner: ownerSigner, intent, maxSecs: 3_600, stake: FLOOR, reviewSecs: MIN_REVIEW_SECS, killFee: FLOOR });
    expect(validateIxAgainstIdl(ix, idl)).toEqual([]);
    const data = getOpenClaimsInstructionDataDecoder().decode(ix.data);
    expect([data.maxSecs, data.stake, data.reviewSecs, data.killFee]).toEqual([3_600, FLOOR, MIN_REVIEW_SECS, FLOOR]);
    expect(meta(ix, accountNamed("open_claims", "book")).address).toBe(await deliveryBookAddress(intent));
    const plain = getOpenClaimsInstructionDataDecoder().decode((await buildOpenClaims({ owner: ownerSigner, intent, maxSecs: 3_600, stake: 0n })).data);
    expect([plain.reviewSecs, plain.killFee]).toEqual([0, 0n]);
  });

  it("refuses review terms the program refuses", async () => {
    const open = (reviewSecs: number, killFee: bigint, stake = FLOOR) =>
      buildOpenClaims({ owner: ownerSigner, intent, maxSecs: 3_600, stake, reviewSecs, killFee });
    for (const [secs, fee, stake] of [
      [MIN_REVIEW_SECS - 1, 0n, FLOOR],
      [MAX_REVIEW_SECS + 1, 0n, FLOOR],
      [0, FLOOR, FLOOR],
      [MIN_REVIEW_SECS, FLOOR, 0n],
      [MIN_REVIEW_SECS, 100_000_000_001n, FLOOR],
    ] as const) {
      await expect(open(secs, fee, stake)).rejects.toEqual(new IntentCoreError("ReviewTerms"));
    }
    await expect(open(MIN_REVIEW_SECS, FLOOR - 1n)).rejects.toThrow(/StakeBelowRent/);
    await expect(buildOpenClaimsListed({ owner: ownerSigner, intent, maxSecs: 3_600, stake: 0n, size: 1, workers: [worker], killFee: FLOOR, reviewSecs: MIN_REVIEW_SECS })).rejects.toEqual(new IntentCoreError("ReviewTerms"));
    expect(validateIxAgainstIdl(await open(MAX_REVIEW_SECS, FLOOR), idl)).toEqual([]);
  });

  it("requests a cancel against the intent's delivery book", async () => {
    const ix = await buildRequestCancel({ owner: ownerSigner, intent });
    expect(validateIxAgainstIdl(ix, idl)).toEqual([]);
    expect(meta(ix, accountNamed("request_cancel", "book")).address).toBe(await deliveryBookAddress(intent));
    expect(meta(ix, accountNamed("request_cancel", "owner")).address).toBe(owner);
  });

  it("rejects through a key judge or a committee mask", async () => {
    const key = await buildRejectDelivery({ intent, announcement, attestor: worker });
    expect(validateIxAgainstIdl(key, idl)).toEqual([]);
    expect(getRejectDeliveryInstructionDataDecoder().decode(key.data).signersMask).toBe(0);
    const committee = await buildRejectDelivery({ intent, announcement, attestor: worker, committee: true, signersMask: 0b101, claims: owner, stakeTo: worker });
    expect(validateIxAgainstIdl(committee, idl)).toEqual([]);
    expect(getRejectDeliveryInstructionDataDecoder().decode(committee.data).signersMask).toBe(0b101);
    expect(meta(committee, accountNamed("reject_delivery", "committee")).address).toBe(worker);
    await expect(buildRejectDelivery({ intent, announcement, attestor: worker, signersMask: 256 })).rejects.toThrow(/signer mask/);
  });

  it("lays out the reject preimage the program signs", () => {
    const p = rejectDeliveryPreimage({ domain: new Uint8Array(32).fill(2), intent, announcement, seq: 0x0102030405060708n });
    expect(p).toHaveLength(REJECT_PREIMAGE_LEN);
    expect(p.slice(0, 16)).toEqual(REJECT_TAG);
    expect(new TextDecoder().decode(REJECT_TAG)).toBe("intent-engine-rj");
    expect(p.slice(48, 80)).toEqual(new Uint8Array(32).fill(2));
    expect([...p.slice(144)]).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
  });

  it("treats an armed review as held until it lapses", () => {
    const board = { owner, worker, until: 10n, held: 5n, reviewUntil: 100n, killFee: 3n };
    expect(boardViewArmed(board)).toBe(true);
    expect(claimSlot(board, 1_000n).state).toBe("held");
    expect(() => stakeReceiverOnCancel(board, 99n)).toThrow(new IntentCoreError("ReviewPending"));
    expect(stakeReceiverOnCancel(board, 100n)).toBe(worker);
    expect(() => stakeReceiverOnSettle(board, 99n, true)).toThrow(new IntentCoreError("ClaimHeld"));
    expect(stakeReceiverOnSettle(board, 100n, true)).toBe(worker);
    expect(stakeReceiverOnSettle(board, 0n, false)).toBe(worker);
    expect(claimSlot({ ...board, reviewUntil: 0n }, 10n).state).toBe("lapsed");
    expect(createNoopSigner(owner).address).toBe(owner);
  });

  it("refuses a claim that leaves no whole review before expiry", () => {
    const free = { owner, worker: "11111111111111111111111111111111" as Address, until: 0n, held: 0n, reviewSecs: 3_600 };
    expect(takeUntil(free, worker, { maxSecs: 600, secs: 600, expiresAt: 4_200n }, 0n)).toBe(600n);
    expect(() => takeUntil(free, worker, { maxSecs: 600, secs: 600, expiresAt: 4_199n }, 0n)).toThrow(new IntentCoreError("ReviewPastExpiry"));
    expect(takeUntil({ ...free, reviewSecs: 0 }, worker, { maxSecs: 600, secs: 600, expiresAt: 600n }, 0n)).toBe(600n);
  });
});
