import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner, type KeyPairSigner, lamports } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { Kind, NATIVE_MINT } from "@intent-engine/core";
import { buildCreateProfile, buildUpdateProfile, encryptionKeyText, findIntentPda, profileAddress } from "@intent-engine/core/internal";
import { createClient, type EngineTransaction, type Transport } from "../src/index.js";
import { svmTransport } from "../src/svm.js";
import { testSignature } from "../src/testing.js";
import { deviceJudgeReady, escrowsJudgedBy, keylessJudges, NoKeyAtCreation, ProfileHistoryIncomplete } from "../src/unopened.js";
import { comparatorsUsedBy, verdicts } from "./kill-client-trust-work-sort.js";
import { world } from "./svm.js";
import { LOCAL, nativeMint, nextSlot } from "./work.js";

const SOL = 1_000_000_000n;
const SPEC = new Uint8Array(createHash("sha256").update("the unopened spec").digest());
const KEY = encryptionKeyText(Uint8Array.from({ length: 32 }, (_, i) => i + 2));
const FAR = 20n;

async function setup() {
  const w = await world();
  nativeMint(w);
  w.chain.svm.warpToSlot(FAR);
  const transport = svmTransport(w.chain.svm);
  const client = createClient({ url: LOCAL, transport });
  const fresh = async () => {
    const signer = await generateKeyPairSigner();
    w.chain.svm.airdrop(signer.address, lamports(10n * SOL));
    return signer;
  };
  const escrow = async (owner: KeyPairSigner, attestor: Address) => {
    const { nonce } = await client.createIntent({
      signer: owner,
      params: { kind: Kind.AttestedResult, amountIn: 1_000_000n, minResult: 1n, maxResult: 1n, attestor, specHash: SPEC, judgeFee: 0n },
      inputMint: NATIVE_MINT,
      outputMint: w.outputMint,
    });
    const [intent] = await findIntentPda({ owner: owner.address, nonce });
    return intent;
  };
  const profile = { skills: ["rust"], endpoint: "https://" + "judge.example/jobs" };
  const publish = async (wallet: KeyPairSigner, key?: string) => {
    await client.send([await buildCreateProfile({ wallet, ...profile, ...(key === undefined ? {} : { encryptionKey: key }) })], wallet);
  };
  const clearKey = async (wallet: KeyPairSigner) => {
    await client.send([await buildUpdateProfile({ wallet, ...profile })], wallet);
  };
  const slot = () => w.chain.svm.getClock().slot;
  return { w, transport, client, fresh, escrow, publish, clearKey, slot, next: () => nextSlot(w) };
}

const failure = async (run: Promise<unknown>) => run.then(() => null, (error: unknown) => error);

const atFirst = (base: Transport, first: bigint): Transport => ({ ...base, firstAvailableSlot: async () => first });

const hiding = (base: Transport, address: Address): Transport => ({
  ...base,
  signaturesOf: async (of, limit, before) => (of === address ? [] : (base.signaturesOf?.call(base, of, limit, before) ?? [])),
});

function withNoise(base: Transport, address: Address, first: bigint): Transport {
  const signature = testSignature("noise");
  const noise: EngineTransaction = { signature, slot: 1n, blockTime: null, failed: false, emitted: [] };
  return {
    ...base,
    firstAvailableSlot: async () => first,
    signaturesOf: async (of, limit, before) =>
      of === address ? (before === undefined ? [{ signature, slot: 1n, blockTime: null, failed: false, memo: null }] : []) : (base.signaturesOf?.call(base, of, limit, before) ?? []),
    transactionsOf: async (listed) => [...listed.filter((entry) => entry.signature === signature).map(() => noise), ...(await base.transactionsOf?.call(base, listed.filter((entry) => entry.signature !== signature)) ?? [])],
  };
}

describe("deviceJudgeReady", () => {
  it("accepts a judge whose profile named a key when the escrow was made, whatever the profile says later", async () => {
    const s = await setup();
    const [judge, owner] = await Promise.all([s.fresh(), s.fresh()]);
    await s.publish(judge, KEY);
    s.next();
    const intent = await s.escrow(owner, judge.address);
    s.next();
    await s.clearKey(judge);
    await expect(deviceJudgeReady(s.transport, judge.address, intent)).resolves.toBeUndefined();
  });

  it("orders the profile's key events by slot with a comparator that says less, greater and equal", async () => {
    const s = await setup();
    const [judge, owner] = await Promise.all([s.fresh(), s.fresh()]);
    await s.publish(judge, KEY);
    s.next();
    const intent = await s.escrow(owner, judge.address);
    s.next();
    await s.clearKey(judge);
    const used = await comparatorsUsedBy(() => deviceJudgeReady(s.transport, judge.address, intent), "slot");
    expect(verdicts(used.at(-1), (slot) => ({ slot, key: null }))).toEqual([-1, 1, 0]);
  });

  it("counts a key event in the very slot of the escrow, and reads the latest event at or before the escrow", async () => {
    const s = await setup();
    const [judge, owner] = await Promise.all([s.fresh(), s.fresh()]);
    await s.publish(judge, KEY);
    const intent = await s.escrow(owner, judge.address);
    await expect(deviceJudgeReady(s.transport, judge.address, intent)).resolves.toBeUndefined();
    s.next();
    await s.clearKey(judge);
    await expect(deviceJudgeReady(s.transport, judge.address, intent)).resolves.toBeUndefined();
    const later = await s.escrow(owner, judge.address);
    expect(await failure(deviceJudgeReady(s.transport, judge.address, later))).toBeInstanceOf(NoKeyAtCreation);
  });

  it("refuses a judge whose profile had no key when the escrow was made, and one that published its key only afterwards", async () => {
    const s = await setup();
    const [judge, never, owner] = await Promise.all([s.fresh(), s.fresh(), s.fresh()]);
    const intent = await s.escrow(owner, judge.address);
    expect(await failure(deviceJudgeReady(s.transport, never.address, intent))).toBeInstanceOf(NoKeyAtCreation);
    s.next();
    await s.publish(judge, KEY);
    const error = await failure(deviceJudgeReady(s.transport, judge.address, intent));
    expect(error).toBeInstanceOf(NoKeyAtCreation);
    expect((error as NoKeyAtCreation).intent).toBe(intent);
  });

  it("refuses a key that is all zero as no key", async () => {
    const s = await setup();
    const [judge, owner] = await Promise.all([s.fresh(), s.fresh()]);
    await s.publish(judge);
    s.next();
    const intent = await s.escrow(owner, judge.address);
    expect(await failure(deviceJudgeReady(s.transport, judge.address, intent))).toBeInstanceOf(NoKeyAtCreation);
  });

  it("falls back to the profile as it stands when the node lists no history of it", async () => {
    const s = await setup();
    const [judge, bare, owner] = await Promise.all([s.fresh(), s.fresh(), s.fresh()]);
    await s.publish(judge, KEY);
    await s.publish(bare);
    s.next();
    const intent = await s.escrow(owner, judge.address);
    const blind = hiding(hiding(s.transport, await profileAddress(judge.address)), await profileAddress(bare.address));
    await expect(deviceJudgeReady(blind, judge.address, intent)).resolves.toBeUndefined();
    expect(await failure(deviceJudgeReady(blind, bare.address, intent))).toBeInstanceOf(NoKeyAtCreation);
  });

  it("says the history is incomplete only when the node starts after the escrow and no key event was seen", async () => {
    const s = await setup();
    const [judge, owner] = await Promise.all([s.fresh(), s.fresh()]);
    const intent = await s.escrow(owner, judge.address);
    const bound = s.slot();
    const outcome = async (first: bigint) => failure(deviceJudgeReady(atFirst(s.transport, first), judge.address, intent));
    expect(await outcome(bound + 1n)).toBeInstanceOf(ProfileHistoryIncomplete);
    expect(await outcome(bound)).toBeInstanceOf(NoKeyAtCreation);
    expect(await outcome(bound - 1n)).toBeInstanceOf(NoKeyAtCreation);
  });

  it("needs the whole history once a key event is seen after the escrow, since an earlier one may be missing", async () => {
    const s = await setup();
    const [judge, owner] = await Promise.all([s.fresh(), s.fresh()]);
    const intent = await s.escrow(owner, judge.address);
    s.next();
    await s.publish(judge, KEY);
    const outcome = async (first: bigint) => failure(deviceJudgeReady(atFirst(s.transport, first), judge.address, intent));
    expect(await outcome(5n)).toBeInstanceOf(ProfileHistoryIncomplete);
    expect(await outcome(0n)).toBeInstanceOf(NoKeyAtCreation);
  });

  it("stops reading at the first key event before the escrow, and needs nothing older", async () => {
    const s = await setup();
    const [judge, owner] = await Promise.all([s.fresh(), s.fresh()]);
    await s.publish(judge, KEY);
    s.next();
    const intent = await s.escrow(owner, judge.address);
    s.next();
    await s.clearKey(judge);
    await expect(deviceJudgeReady(atFirst(s.transport, 5n), judge.address, intent)).resolves.toBeUndefined();
  });

  it("stops reading at a key event in the very slot of the escrow, and needs nothing older", async () => {
    const s = await setup();
    const [judge, owner] = await Promise.all([s.fresh(), s.fresh()]);
    await s.publish(judge, KEY);
    const intent = await s.escrow(owner, judge.address);
    await expect(deviceJudgeReady(atFirst(s.transport, 5n), judge.address, intent)).resolves.toBeUndefined();
  });

  it("does not take a transaction that touched the profile without a key event for one", async () => {
    const s = await setup();
    const [judge, owner] = await Promise.all([s.fresh(), s.fresh()]);
    const intent = await s.escrow(owner, judge.address);
    const bound = s.slot();
    const noisy = withNoise(s.transport, await profileAddress(judge.address), bound);
    expect(await failure(deviceJudgeReady(noisy, judge.address, intent))).toBeInstanceOf(NoKeyAtCreation);
  });
});

describe("escrowsJudgedBy", () => {
  it("lists the open escrows a wallet judges alone or as a committee member, and none for anyone else", async () => {
    const s = await setup();
    const [judge, owner, a, b, stranger] = await Promise.all([s.fresh(), s.fresh(), s.fresh(), s.fresh(), s.fresh()]);
    const alone = await s.escrow(owner, judge.address);
    const { committee } = await s.client.createCommittee({ payer: owner, members: [a.address, b.address], threshold: 2, feeWallet: owner.address });
    const shared = await s.escrow(owner, committee);
    expect(await escrowsJudgedBy(s.transport, judge.address)).toEqual([alone]);
    expect(await escrowsJudgedBy(s.transport, a.address)).toEqual([shared]);
    expect(await escrowsJudgedBy(s.transport, b.address)).toEqual([shared]);
    expect(await escrowsJudgedBy(s.transport, stranger.address)).toEqual([]);
  });
});

describe("keylessJudges", () => {
  it("names the members of a committee whose profile has no key, and the lone judge when it has none", async () => {
    const s = await setup();
    const [owner, keyed, bare, lone] = await Promise.all([s.fresh(), s.fresh(), s.fresh(), s.fresh()]);
    await s.publish(keyed, KEY);
    const { committee } = await s.client.createCommittee({ payer: owner, members: [keyed.address, bare.address], threshold: 2, feeWallet: owner.address });
    expect(await keylessJudges(s.transport, committee)).toEqual([bare.address]);
    expect(await keylessJudges(s.transport, lone.address)).toEqual([lone.address]);
    expect(await keylessJudges(s.transport, keyed.address)).toEqual([]);
  });
});
