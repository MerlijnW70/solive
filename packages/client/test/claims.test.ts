import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import {
  claimBoardAddress,
  findIntentPda,
  buildClaimJob,
  buildDropClaim,
  buildOpenClaims,
  checkClaimant,
  IntentStatus,
  Kind,
  NATIVE_MINT,
  stakeReceiverOnCancel,
  stakeReceiverOnRelease,
  stakeReceiverOnSettle,
  TOKEN_PROGRAM_ADDRESS,
} from "@intent-engine/core";
import { createClient, NotSettleable } from "../src/index.js";
import { svmTransport } from "../src/svm.js";
import { world } from "./svm.js";

const LOCAL = "http://127.0.0.1:8899";
const SOL = 1_000_000_000n;
const SPEC = new Uint8Array(createHash("sha256").update("the claims spec").digest());
const STAKE = 50_000_000n;
const NONE = "11111111111111111111111111111111" as Address;

async function setup() {
  const w = await world();
  const space = BigInt(getMintSize());
  w.chain.svm.setAccount({
    address: NATIVE_MINT,
    data: Uint8Array.from(
      getMintEncoder().encode({ mintAuthority: none(), supply: 0n, decimals: 9, isInitialized: true, freezeAuthority: none() }),
    ),
    executable: false,
    lamports: lamports(w.chain.svm.minimumBalanceForRentExemption(space)),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space,
  });
  const transport = svmTransport(w.chain.svm);
  const client = createClient({ url: LOCAL, transport });
  const fresh = async () => {
    const signer = await generateKeyPairSigner();
    w.chain.svm.airdrop(signer.address, lamports(10n * SOL));
    return signer;
  };
  const [owner, judge, worker, rival] = await Promise.all([fresh(), fresh(), fresh(), fresh()]);
  const { nonce } = await client.createIntent({
    signer: owner,
    params: { kind: Kind.AttestedResult, amountIn: 1_000_000n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: SPEC, judgeFee: 0n },
    inputMint: NATIVE_MINT,
    outputMint: w.outputMint,
  });
  const [intent] = await findIntentPda({ owner: owner.address, nonce });
  await client.send([await buildOpenClaims({ owner, intent, maxSecs: 3_600, stake: STAKE })], owner);
  const claim = async (who: KeyPairSigner) =>
    client.send([await buildClaimJob({ worker: who, intent, owner: owner.address, secs: 600 })], who);
  const settle = (payTo: Address) => client.settleProof({ judge, owner: owner.address, nonce, payTo, result: 1n });
  const balance = (address: Address) => w.chain.svm.getBalance(address) ?? 0n;
  return { w, client, owner, judge, worker, rival, intent, nonce, claim, settle, balance };
}

describe("claimed escrows", () => {
  it("pay only the claimant while the claim holds, and hand its stake back with the release", async () => {
    const s = await setup();
    await s.claim(s.worker);
    await expect(s.settle(s.rival.address)).rejects.toThrow(NotSettleable);
    const before = s.balance(s.worker.address);
    await s.settle(s.worker.address);
    expect(s.balance(s.worker.address) - before).toBe(STAKE);
    expect((await s.client.intent(s.owner.address, s.nonce))?.intent.status).toBe(IntentStatus.Filled);
  });

  it("let anyone be paid once the claim lapses, sending the stake to the owner", async () => {
    const s = await setup();
    await s.claim(s.worker);
    const clock = s.w.chain.svm.getClock();
    clock.unixTimestamp += 601n;
    s.w.chain.svm.setClock(clock);
    const before = s.balance(s.owner.address);
    await s.settle(s.rival.address);
    expect(s.balance(s.owner.address) - before).toBe(STAKE);
    expect(s.w.chain.svm.getAccount(await claimBoardAddress(s.intent)).exists).toBe(true);
  });

  it("client.claims reports free, held and lapsed from the chain's clock", async () => {
    const s = await setup();
    const board = await claimBoardAddress(s.intent);
    const terms = { board, stake: STAKE, maxSecs: 3_600, owner: s.owner.address, cooldown: null };
    expect(await s.client.claims(s.owner.address, s.nonce)).toEqual({ ...terms, state: "free", worker: null, until: 0n, secondsLeft: 0n });
    await s.claim(s.worker);
    const now = s.w.chain.svm.getClock().unixTimestamp;
    expect(await s.client.claims(s.owner.address, s.nonce)).toEqual({ ...terms, state: "held", worker: s.worker.address, until: now + 600n, secondsLeft: 600n });
    const clock = s.w.chain.svm.getClock();
    clock.unixTimestamp += 250n;
    s.w.chain.svm.setClock(clock);
    expect(await s.client.claims(s.owner.address, s.nonce)).toMatchObject({ state: "held", secondsLeft: 350n });
    clock.unixTimestamp += 350n;
    s.w.chain.svm.setClock(clock);
    expect(await s.client.claims(s.owner.address, s.nonce)).toEqual({ ...terms, state: "lapsed", worker: s.worker.address, until: now + 600n, secondsLeft: 0n });
    const { nonce } = await s.client.createIntent({
      signer: s.owner,
      params: { kind: Kind.AttestedResult, amountIn: 1_000_000n, minResult: 1n, maxResult: 1n, attestor: s.judge.address, specHash: SPEC, judgeFee: 0n },
      inputMint: NATIVE_MINT,
      outputMint: s.w.outputMint,
    });
    expect(await s.client.claims(s.owner.address, nonce)).toBeNull();
  });

  it("decide the stake's receiver exactly as the program does", () => {
    const worker = "So11111111111111111111111111111111111111112" as Address;
    const owner = "Sysvar1111111111111111111111111111111111111" as Address;
    const other = "Vote111111111111111111111111111111111111111" as Address;
    const board = { owner, worker, until: 100n, held: STAKE };
    expect(stakeReceiverOnRelease(board, 99n, [worker])).toBe(worker);
    expect(() => stakeReceiverOnRelease(board, 99n, [other])).toThrow("ClaimHeld");
    expect(stakeReceiverOnRelease(board, 100n, [other])).toBe(owner);
    expect(stakeReceiverOnRelease(board, 100n, [worker])).toBe(worker);
    expect(stakeReceiverOnRelease({ ...board, worker: "11111111111111111111111111111111" as Address }, 0n, [other])).toBeNull();
    expect(() => stakeReceiverOnSettle(board, 99n, true)).toThrow("ClaimHeld");
    expect(stakeReceiverOnSettle(board, 99n, false)).toBe(worker);
    expect(stakeReceiverOnSettle(board, 100n, true)).toBe(owner);
    expect(stakeReceiverOnCancel(board, 99n)).toBe(worker);
    expect(stakeReceiverOnCancel(board, 100n)).toBe(owner);
    expect(stakeReceiverOnCancel({ ...board, worker: NONE }, 0n)).toBeNull();
    const dropped = { worker: NONE, until: 100n, droppedBy: worker };
    expect(() => checkClaimant(dropped, worker, 99n)).toThrow("ClaimCooldown");
    expect(() => checkClaimant(dropped, worker, 100n)).not.toThrow();
    expect(() => checkClaimant(dropped, other, 0n)).not.toThrow();
    expect(() => checkClaimant(board, other, 99n)).toThrow("ClaimHeld");
    expect(() => checkClaimant(board, other, 100n)).not.toThrow();
  });

  it("a cancel under a held claim hands the worker its stake at once, so the owner cannot wait for the claim to lapse", async () => {
    const s = await setup();
    await s.claim(s.worker);
    const clock = s.w.chain.svm.getClock();
    clock.unixTimestamp += 599n;
    s.w.chain.svm.setClock(clock);
    const before = s.balance(s.worker.address);
    await s.client.cancel(s.owner, s.nonce);
    expect(s.balance(s.worker.address) - before).toBe(STAKE);
    expect(await s.client.claims(s.owner.address, s.nonce)).toMatchObject({ state: "free", worker: null, cooldown: null });
  });

  it("a worker that drops a claim cannot take it again before that claim would have ended, while a rival can at once", async () => {
    const s = await setup();
    await s.claim(s.worker);
    const until = (await s.client.claims(s.owner.address, s.nonce))?.until ?? 0n;
    await s.client.send([await buildDropClaim({ worker: s.worker, intent: s.intent })], s.worker);
    expect(await s.client.claims(s.owner.address, s.nonce)).toMatchObject({ state: "free", worker: null, until: 0n, cooldown: { worker: s.worker.address, until } });
    await expect(s.claim(s.worker)).rejects.toThrow("ClaimCooldown");
    await s.claim(s.rival);
    expect(await s.client.claims(s.owner.address, s.nonce)).toMatchObject({ state: "held", worker: s.rival.address, cooldown: null });
  });
});
