import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import {
  claimBoardAddress,
  findIntentPda,
  buildClaimJob,
  buildDropClaim,
  buildLeave,
  buildOpenClaims,
  buildStandBy,
  checkClaimant,
  IntentStatus,
  Kind,
  NATIVE_MINT,
  stakeReceiverOnCancel,
  stakeReceiverOnRelease,
  stakeReceiverOnSettle,
  standbyAddress,
  TOKEN_PROGRAM_ADDRESS,
} from "@intent-engine/core";
import { ClaimHeldBy, createClient, FirstOpeningRefused, jobClaimOf, lineHandover, loadClaimsOf, loadLine, NotDeliverable, NotSettleable, type Transport } from "../src/index.js";
import { svmTransport } from "../src/svm.js";
import { world } from "./svm.js";
import { announced, type Delivered, keyed, sha } from "./work.js";

const LOCAL = "http://127.0.0.1:8899";
const SOL = 1_000_000_000n;
const SPEC = new Uint8Array(createHash("sha256").update("the claims spec").digest());
const STAKE = 50_000_000n;
const NONE = "11111111111111111111111111111111" as Address;
const WORK = sha("the claimed work");

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
  const [owner, worker, rival] = await Promise.all([fresh(), fresh(), fresh()]);
  const { signer: judge, keypair } = await keyed(w);
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
  const settle = (delivered: Delivered) => client.settleProof({ judge, intent: { owner: owner.address, nonce }, ...delivered, result: 1n });
  const announce = (who: KeyPairSigner) => announced(client, who, intent, WORK);
  const balance = (address: Address) => w.chain.svm.getBalance(address) ?? 0n;
  return { w, transport, client, owner, judge, keypair, worker, rival, intent, nonce, claim, settle, announce, balance };
}

describe("claimed escrows", () => {
  it("pay only the claimant while the claim holds, and hand its stake back with the release", async () => {
    const s = await setup();
    const early = await s.announce(s.rival);
    await s.claim(s.worker);
    await expect(s.announce(s.rival)).rejects.toThrow(NotDeliverable);
    const own = await s.announce(s.worker);
    await expect(s.settle(early)).rejects.toThrow(ClaimHeldBy);
    const refused = await s.client.firstOpening({ intent: s.intent, sha256: WORK, keypair: s.keypair }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(FirstOpeningRefused);
    expect(refused).toMatchObject({ reason: "claim-held", announcement: early.announcement, worker: s.rival.address, holder: s.worker.address });
    const before = s.balance(s.worker.address);
    await s.settle(own);
    expect(s.balance(s.worker.address) - before).toBe(STAKE);
    expect((await s.client.intent({ owner: s.owner.address, nonce: s.nonce }))?.intent.status).toBe(IntentStatus.Filled);
  });

  it("let anyone be paid once the claim lapses, sending the stake to the owner", async () => {
    const s = await setup();
    const early = await s.announce(s.rival);
    await s.claim(s.worker);
    const clock = s.w.chain.svm.getClock();
    clock.unixTimestamp += 601n;
    s.w.chain.svm.setClock(clock);
    expect(await s.client.firstOpening({ intent: s.intent, sha256: WORK, keypair: s.keypair })).toMatchObject({ announcement: early.announcement, worker: s.rival.address });
    const before = s.balance(s.owner.address);
    await s.settle(early);
    expect(s.balance(s.owner.address) - before).toBe(STAKE);
    expect(s.w.chain.svm.getAccount(await claimBoardAddress(s.intent)).exists).toBe(true);
  });

  it("client.claims reports free, held and lapsed from the chain's clock", async () => {
    const s = await setup();
    const board = await claimBoardAddress(s.intent);
    const terms = { board, stake: STAKE, maxSecs: 3_600, owner: s.owner.address, cooldown: null, line: { head: 0, tail: 0, waiting: 0 }, list: null };
    expect(await s.client.claims({ owner: s.owner.address, nonce: s.nonce })).toEqual({ ...terms, state: "free", worker: null, until: 0n, secondsLeft: 0n });
    await s.claim(s.worker);
    const now = s.w.chain.svm.getClock().unixTimestamp;
    expect(await s.client.claims({ owner: s.owner.address, nonce: s.nonce })).toEqual({ ...terms, state: "held", worker: s.worker.address, until: now + 600n, secondsLeft: 600n });
    const clock = s.w.chain.svm.getClock();
    clock.unixTimestamp += 250n;
    s.w.chain.svm.setClock(clock);
    expect(await s.client.claims({ owner: s.owner.address, nonce: s.nonce })).toMatchObject({ state: "held", secondsLeft: 350n });
    clock.unixTimestamp += 350n;
    s.w.chain.svm.setClock(clock);
    expect(await s.client.claims({ owner: s.owner.address, nonce: s.nonce })).toEqual({ ...terms, state: "lapsed", worker: s.worker.address, until: now + 600n, secondsLeft: 0n });
    const { nonce } = await s.client.createIntent({
      signer: s.owner,
      params: { kind: Kind.AttestedResult, amountIn: 1_000_000n, minResult: 1n, maxResult: 1n, attestor: s.judge.address, specHash: SPEC, judgeFee: 0n },
      inputMint: NATIVE_MINT,
      outputMint: s.w.outputMint,
    });
    expect(await s.client.claims({ owner: s.owner.address, nonce })).toBeNull();
  });

  it("decide the stake's receiver exactly as the program does", () => {
    const worker = "So11111111111111111111111111111111111111112" as Address;
    const owner = "Sysvar1111111111111111111111111111111111111" as Address;
    const other = "Vote111111111111111111111111111111111111111" as Address;
    const board = { owner, worker, until: 100n, held: STAKE };
    expect(stakeReceiverOnRelease(board, 99n, [worker])).toBe(worker);
    expect(() => stakeReceiverOnRelease(board, 99n, [other])).toThrow("ClaimHeld");
    expect(stakeReceiverOnRelease(board, 100n, [other])).toBe(owner);
    expect(stakeReceiverOnRelease(board, 100n, [worker])).toBe(owner);
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
    await s.client.cancel(s.owner, { owner: s.owner.address, nonce: s.nonce });
    expect(s.balance(s.worker.address) - before).toBe(STAKE);
    expect(await s.client.claims({ owner: s.owner.address, nonce: s.nonce })).toMatchObject({ state: "free", worker: null, cooldown: null });
  });

  it("a worker that drops a claim cannot take it again before that claim would have ended, while a rival can at once", async () => {
    const s = await setup();
    await s.claim(s.worker);
    const until = (await s.client.claims({ owner: s.owner.address, nonce: s.nonce }))?.until ?? 0n;
    await s.client.send([await buildDropClaim({ worker: s.worker, intent: s.intent })], s.worker);
    expect(await s.client.claims({ owner: s.owner.address, nonce: s.nonce })).toMatchObject({ state: "free", worker: null, until: 0n, cooldown: { worker: s.worker.address, until } });
    await expect(s.claim(s.worker)).rejects.toThrow("ClaimCooldown");
    await s.claim(s.rival);
    expect(await s.client.claims({ owner: s.owner.address, nonce: s.nonce })).toMatchObject({ state: "held", worker: s.rival.address, cooldown: null });
  });

  it("loadClaimsOf reads many boards and the clock in one batch, matching client.claims", async () => {
    const s = await setup();
    const { nonce } = await s.client.createIntent({
      signer: s.owner,
      params: { kind: Kind.AttestedResult, amountIn: 1_000_000n, minResult: 1n, maxResult: 1n, attestor: s.judge.address, specHash: SPEC, judgeFee: 0n },
      inputMint: NATIVE_MINT,
      outputMint: s.w.outputMint,
    });
    const [bare] = await findIntentPda({ owner: s.owner.address, nonce });
    await s.claim(s.worker);
    const calls: string[] = [];
    const counted: Transport = {
      ...s.transport,
      getAccount: async (address) => {
        calls.push("one");
        return s.transport.getAccount(address);
      },
      getAccounts: async (addresses) => {
        calls.push("many");
        return s.transport.getAccounts(addresses);
      },
    };
    const views = await loadClaimsOf(counted, [s.intent, bare]);
    expect(calls).toEqual(["many"]);
    expect(views).toEqual([await s.client.claims({ owner: s.owner.address, nonce: s.nonce }), null]);
    expect(views.map(jobClaimOf)).toEqual([{ takesClaims: true, claimedBy: s.worker.address, claimEnds: views[0]?.until, waiting: 0 }, { takesClaims: false, claimedBy: null, claimEnds: null, waiting: 0 }]);
    expect(await loadClaimsOf(counted, [])).toEqual([]);
    expect(calls).toEqual(["many"]);
    const clock = s.w.chain.svm.getClock();
    clock.unixTimestamp += 601n;
    s.w.chain.svm.setClock(clock);
    expect((await loadClaimsOf(counted, [s.intent])).map(jobClaimOf)).toEqual([{ takesClaims: true, claimedBy: null, claimEnds: null, waiting: 0 }]);
  });

  it("reads the line, names the first worker still in it and the holes before it, and a drop hands the job over", async () => {
    const s = await setup();
    await s.claim(s.worker);
    const third = await generateKeyPairSigner();
    s.w.chain.svm.airdrop(third.address, lamports(10n * SOL));
    for (const [seq, who] of [s.rival, third].entries()) {
      await s.client.send([await buildStandBy({ worker: who, intent: s.intent, seq, secs: 300 + seq })], who);
    }
    const view = await s.client.claims({ owner: s.owner.address, nonce: s.nonce });
    expect(view?.line).toEqual({ head: 0, tail: 2, waiting: 2 });
    expect(jobClaimOf(view)).toMatchObject({ claimedBy: s.worker.address, waiting: 2 });
    const [first, second] = await Promise.all([standbyAddress(s.intent, 0), standbyAddress(s.intent, 1)]);
    expect(await loadLine(s.transport, s.intent, { head: 0, tail: 2 })).toEqual([
      { seq: 0, entry: first, worker: s.rival.address, secs: 300 },
      { seq: 1, entry: second, worker: third.address, secs: 301 },
    ]);
    expect(await lineHandover(s.transport, s.intent, { head: 0, tail: 2 })).toEqual({ entries: [first], nextWorker: s.rival.address });
    await s.client.send([await buildLeave({ caller: s.rival, intent: s.intent, seq: 0, worker: s.rival.address })], s.rival);
    expect((await loadLine(s.transport, s.intent, { head: 0, tail: 2 }))[0]).toEqual({ seq: 0, entry: first, worker: null, secs: null });
    const handover = await lineHandover(s.transport, s.intent, { head: 0, tail: 2 });
    expect(handover).toEqual({ entries: [first, second], nextWorker: third.address });
    await expect(s.client.send([await buildDropClaim({ worker: s.worker, intent: s.intent })], s.worker)).rejects.toThrow();
    await s.client.send([await buildDropClaim({ worker: s.worker, intent: s.intent, ...handover })], s.worker);
    expect(await s.client.claims({ owner: s.owner.address, nonce: s.nonce })).toMatchObject({ state: "held", worker: third.address, line: { head: 2, tail: 2, waiting: 0 } });
    expect(await lineHandover(s.transport, s.intent, { head: 2, tail: 2 })).toEqual({ entries: [] });
  });
});
