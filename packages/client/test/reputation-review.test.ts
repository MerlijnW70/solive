import { createHash, randomBytes } from "node:crypto";
import { AccountRole, type Address, generateKeyPairSigner, getAddressEncoder, type KeyPairSigner, lamports, none, type Signature } from "@solana/kit";
import { getCreateAccountInstruction, getTransferSolInstruction } from "@solana-program/system";
import {
  getCloseAccountInstruction,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintEncoder,
  getMintSize,
  getMintToInstruction,
  getSyncNativeInstruction,
} from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { deliveryMemo, findAssociatedTokenAddress, findIntentPda, Kind, NATIVE_MINT, sealDelivery, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import {
  commitmentOf,
  createClient,
  deliverySalt,
  FUNDING_READS,
  memoInstruction,
  NOTIFIED_WALLETS,
  openingInstructions,
  RECORD_READS,
  reputationOf,
  RESTART,
  saltCheckOf,
  solTransfersOf,
  SYSTEM_PROGRAM_ADDRESS,
  type Transport,
  TRUST_PAYER_READS,
  trustOf,
} from "../src/index.js";
import { INTENT_HISTORY_PAGES } from "../src/release-reads.js";
import { svmTransport } from "../src/svm.js";
import { world } from "./svm.js";

const LOCAL = "http://127.0.0.1:8899";
const SOL = 1_000_000_000n;
const SPEC = new Uint8Array(createHash("sha256").update("the review spec").digest());
const PAY = 1_000_000n;
const WORK_URL = "https://" + "example.org/work";

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
  const escrow = async (owner: KeyPairSigner, judge: KeyPairSigner, inputMint: Address = NATIVE_MINT, amountIn: bigint = PAY) => {
    const { nonce } = await client.createIntent({
      signer: owner,
      params: { kind: Kind.AttestedResult, amountIn, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: SPEC, judgeFee: 0n },
      inputMint,
      outputMint: w.outputMint,
    });
    const [intent] = await findIntentPda({ owner: owner.address, nonce });
    return { nonce, intent };
  };
  const release = async (owner: KeyPairSigner, judge: KeyPairSigner, worker: KeyPairSigner, nonce: bigint, intent: Address, sha256: string) =>
    client.settleProof({ judge, owner: owner.address, nonce, payTo: worker.address, result: 1n, deliveredSha256: sha256, deliveredSalt: await deliverySalt(worker, intent, sha256) });
  const job = async (owner: KeyPairSigner, judge: KeyPairSigner, worker: KeyPairSigner, sha256: string, inputMint: Address = NATIVE_MINT, amountIn: bigint = PAY) => {
    const { nonce, intent } = await escrow(owner, judge, inputMint, amountIn);
    await client.deliver({ worker, intent, sha256, url: WORK_URL });
    await release(owner, judge, worker, nonce, intent, sha256);
    return intent;
  };
  const announce = async (worker: KeyPairSigner, judge: Address, intent: Address, sha256: string, salt: string) => {
    const blob = await sealDelivery({ salt, url: WORK_URL }, [judge], intent);
    const memo = deliveryMemo({ intent, commitment: commitmentOf(intent, worker.address, salt, sha256), check: saltCheckOf(salt), blob });
    return (await transport.send([memoInstruction(worker, memo), getTransferSolInstruction({ source: worker, destination: judge, amount: 0n })], worker)) as Signature;
  };
  const selfOpened = async (worker: KeyPairSigner, judge: Address, intent: Address, sha256: string) => {
    const salt = randomBytes(16).toString("hex");
    const announcement = await announce(worker, judge, intent, sha256, salt);
    await transport.send(openingInstructions(worker, judge, { intent, announcement, salt }), worker);
    return announcement;
  };
  const pad = async (from: KeyPairSigner, to: Address, count: number) => {
    for (let i = 0; i < count; i++) {
      await transport.send([getTransferSolInstruction({ source: from, destination: to, amount: 0n })], from);
    }
  };
  return { w, client, transport, fresh, escrow, release, job, announce, selfOpened, pad };
}

const marks = (records: readonly { intent: Address; fundedByWorker?: string }[]) => Object.fromEntries(records.map((r) => [r.intent, r.fundedByWorker]));

describe("reputation that counts each release once", () => {
  it("adds nothing for repeated self-opened announcements after a release", async () => {
    const { client, transport, fresh, job, selfOpened } = await setup();
    const [worker, honest, owner, judge] = await Promise.all([fresh(), fresh(), fresh(), fresh()]);
    const sha256 = "a1".repeat(32);
    const intent = await job(owner, judge, worker, sha256);
    await job(owner, judge, honest, "b2".repeat(32));
    const once = await client.reputation(worker.address);
    const trusted = (await trustOf(transport, owner.address, worker.address)).score;
    expect(once).toMatchObject({ complete: true, announced: 1, paid: 1, payers: 1 });
    expect(trusted).toBeCloseTo((RESTART * (1 - RESTART)) / 2, 12);
    for (let i = 0; i < 3; i++) {
      await selfOpened(worker, judge.address, intent, sha256);
    }
    const again = await client.reputation(worker.address);
    expect(again).toMatchObject({ complete: true, announced: 1, paid: 1, payers: 1, earned: once.earned, backed: once.backed, backedSol: once.backedSol });
    expect(again.records.map((r) => [r.announced, r.outcome])).toEqual([[once.records[0]?.announced, "paid"]]);
    expect((await trustOf(transport, owner.address, worker.address)).score).toBeCloseTo(trusted, 12);
  });

  it("does not count an announcement that landed after the release", async () => {
    const { w, client, fresh, escrow, release, announce } = await setup();
    const [worker, owner, judge] = await Promise.all([fresh(), fresh(), fresh()]);
    const sha256 = "c3".repeat(32);
    const same = await escrow(owner, judge);
    await release(owner, judge, worker, same.nonce, same.intent, sha256);
    await announce(worker, judge.address, same.intent, sha256, await deliverySalt(worker, same.intent, sha256));
    const later = await escrow(owner, judge);
    await release(owner, judge, worker, later.nonce, later.intent, sha256);
    w.chain.svm.warpToSlot(w.chain.svm.getClock().slot + 1n);
    await announce(worker, judge.address, later.intent, sha256, await deliverySalt(worker, later.intent, sha256));
    const rep = await client.reputation(worker.address);
    expect(rep).toMatchObject({ complete: true, announced: 2, paid: 0, earned: [], backedSol: "0" });
    expect(rep.records.map((r) => r.outcome)).toEqual(["paid-other", "paid-other"]);
  });

  it("says it is incomplete when a refutation read fails", async () => {
    const { transport, fresh, job, selfOpened } = await setup();
    const [worker, owner, judge] = await Promise.all([fresh(), fresh(), fresh()]);
    const sha256 = "d4".repeat(32);
    const intent = await job(owner, judge, worker, sha256);
    await selfOpened(worker, judge.address, intent, sha256);
    expect(await reputationOf(transport, worker.address)).toMatchObject({ complete: true, paid: 1 });
    const failing: Transport = {
      ...transport,
      transactionOf: async () => {
        throw new Error("rpc failed");
      },
    };
    expect(await reputationOf(failing, worker.address)).toMatchObject({ complete: false, paid: 1 });
  });

  it("counts a refuted release as refuted, never as funded by the worker", async () => {
    const { w, client, fresh, escrow, release } = await setup();
    const [first, later, owner, judge] = await Promise.all([fresh(), fresh(), fresh(), fresh()]);
    const sha256 = "e5".repeat(32);
    const { nonce, intent } = await escrow(owner, judge);
    const before = await client.deliver({ worker: first, intent, sha256, url: WORK_URL });
    w.chain.svm.warpToSlot(w.chain.svm.getClock().slot + 1n);
    await client.deliver({ worker: later, intent, sha256, url: WORK_URL });
    await release(owner, judge, later, nonce, intent, sha256);
    await client.openDelivery({ worker: first, intent, attestor: judge.address, sha256, announcement: before });
    const rep = await client.reputation(later.address);
    expect(rep).toMatchObject({ paid: 0, refuted: 1, fundedByWorker: 0, fundingUnknown: 0 });
    expect(marks(rep.records)).toEqual({ [intent]: "no" });
  });
});

describe("reputation reading every way history can hide", () => {
  it("finds a payer the worker funded by creating its account", async () => {
    const { client, transport, fresh, job } = await setup();
    const [worker, judge] = await Promise.all([fresh(), fresh()]);
    const payer = await generateKeyPairSigner();
    await transport.send([getCreateAccountInstruction({ payer: worker, newAccount: payer, lamports: 3n * SOL, space: 0, programAddress: SYSTEM_PROGRAM_ADDRESS })], worker);
    const intent = await job(payer, judge, worker, "f6".repeat(32));
    const rep = await client.reputation(worker.address);
    expect(rep).toMatchObject({ complete: true, paid: 0, fundedByWorker: 1 });
    expect(marks(rep.records)).toEqual({ [intent]: "yes" });
  });

  it("finds a payer the worker funded by closing a token account into it", async () => {
    const { client, transport, fresh, job } = await setup();
    const [worker, judge, stranger] = await Promise.all([fresh(), fresh(), fresh()]);
    const payer = await generateKeyPairSigner();
    const wrapped = await findAssociatedTokenAddress({ owner: worker.address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    await transport.send(
      [
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: worker, owner: worker.address, mint: NATIVE_MINT }),
        getTransferSolInstruction({ source: worker, destination: wrapped, amount: 3n * SOL }),
        getSyncNativeInstruction({ account: wrapped }),
      ],
      worker,
    );
    await transport.send([getCloseAccountInstruction({ account: wrapped, destination: payer.address, owner: worker })], stranger);
    const intent = await job(payer, judge, worker, "07".repeat(32));
    const rep = await client.reputation(worker.address);
    expect(rep).toMatchObject({ complete: true, paid: 0, fundedByWorker: 1 });
    expect(marks(rep.records)).toEqual({ [intent]: "yes" });
  });

  it("finds the funder behind more zero-lamport transfers than it reads", async () => {
    const { client, transport, fresh, job, pad } = await setup();
    const [worker, judge, padder] = await Promise.all([fresh(), fresh(), fresh()]);
    const payer = await generateKeyPairSigner();
    await pad(padder, payer.address, FUNDING_READS + 4);
    await transport.send([getTransferSolInstruction({ source: worker, destination: payer.address, amount: 3n * SOL })], worker);
    const intent = await job(payer, judge, worker, "18".repeat(32));
    const rep = await client.reputation(worker.address);
    expect(rep).toMatchObject({ complete: true, paid: 0, fundedByWorker: 1, fundingUnknown: 0 });
    expect(marks(rep.records)).toEqual({ [intent]: "yes" });
  });

  it("still counts an honest worker's release whose payer's funding cannot be checked, under funding_unknown", async () => {
    const { client, transport, fresh, job } = await setup();
    const [worker, judge, stranger] = await Promise.all([fresh(), fresh(), fresh()]);
    const payer = await generateKeyPairSigner();
    for (let i = 0; i < FUNDING_READS + 4; i++) {
      const touch = getTransferSolInstruction({ source: stranger, destination: stranger.address, amount: 0n });
      await transport.send([{ ...touch, accounts: [...touch.accounts, { address: payer.address, role: AccountRole.READONLY }] }], stranger);
    }
    await transport.send([getTransferSolInstruction({ source: stranger, destination: payer.address, amount: 3n * SOL })], stranger);
    const padded = await job(payer, judge, worker, "6a".repeat(32));
    const owner = await fresh();
    const clean = await job(owner, judge, worker, "7a".repeat(32));
    const rep = await client.reputation(worker.address);
    expect(rep).toMatchObject({ complete: false, paid: 2, paidVerified: 1, fundedByWorker: 0, fundingUnknown: 1, payers: 2 });
    expect(marks(rep.records)).toEqual({ [padded]: "unknown", [clean]: "no" });
    const pruned = await reputationOf({ ...transport, firstAvailableSlot: async () => 5n }, worker.address);
    expect(pruned).toMatchObject({ complete: false, paid: 2, paidVerified: 0, fundedByWorker: 0, fundingUnknown: 2, backedSol: rep.backedSol });
  });

  it("finds a payer the worker funded by withdrawing a stake account into it", async () => {
    const { client, transport, fresh, job } = await setup();
    const [worker, judge] = await Promise.all([fresh(), fresh()]);
    const [payer, stake] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
    const STAKE = "Stake11111111111111111111111111111111111111" as Address;
    const pubkey = (address: Address) => [...getAddressEncoder().encode(address)];
    const u32 = (value: number) => [...new Uint8Array(Uint32Array.of(value).buffer)];
    const u64 = (value: bigint) => [...new Uint8Array(BigUint64Array.of(value).buffer)];
    const initialize = {
      programAddress: STAKE,
      accounts: [
        { address: stake.address, role: AccountRole.WRITABLE },
        { address: "SysvarRent111111111111111111111111111111111" as Address, role: AccountRole.READONLY },
      ],
      data: Uint8Array.from([...u32(0), ...pubkey(worker.address), ...pubkey(worker.address), ...u64(0n), ...u64(0n), ...new Array<number>(32).fill(0)]),
    };
    await transport.send([getCreateAccountInstruction({ payer: worker, newAccount: stake, lamports: 3n * SOL, space: 200, programAddress: STAKE }), initialize], worker);
    const withdraw = {
      programAddress: STAKE,
      accounts: [
        { address: stake.address, role: AccountRole.WRITABLE },
        { address: payer.address, role: AccountRole.WRITABLE },
        { address: "SysvarC1ock11111111111111111111111111111111" as Address, role: AccountRole.READONLY },
        { address: "SysvarStakeHistory1111111111111111111111111" as Address, role: AccountRole.READONLY },
        { address: worker.address, role: AccountRole.READONLY_SIGNER, signer: worker },
      ],
      data: Uint8Array.from([...u32(4), ...u64(3n * SOL)]),
    };
    await transport.send([withdraw], worker);
    const intent = await job(payer, judge, worker, "8a".repeat(32));
    const rep = await client.reputation(worker.address);
    expect(rep).toMatchObject({ complete: true, paid: 0, fundedByWorker: 1 });
    expect(marks(rep.records)).toEqual({ [intent]: "yes" });
  });

  it("reads a release beyond the newest page of the escrow's signatures", async () => {
    const { transport, fresh, job, pad } = await setup();
    const [worker, owner, judge, padder] = await Promise.all([fresh(), fresh(), fresh(), fresh()]);
    const intent = await job(owner, judge, worker, "29".repeat(32));
    await pad(padder, intent, 6);
    const rep = await reputationOf(transport, worker.address, { history: 4 });
    expect(rep).toMatchObject({ complete: true, paid: 1 });
    expect(rep.records.map((r) => r.outcome)).toEqual(["paid"]);
    const bare: Transport = { ...transport };
    delete bare.signaturesOf;
    delete bare.transactionsOf;
    expect(await reputationOf(bare, worker.address, { history: 4 })).toMatchObject({ complete: false, paid: 1 });
  });

  it("finds a release buried past the pages it reads through the judge's history", async () => {
    const { transport, fresh, job, pad } = await setup();
    const [worker, owner, judge, padder] = await Promise.all([fresh(), fresh(), fresh(), fresh()]);
    const intent = await job(owner, judge, worker, "3a".repeat(32));
    await pad(padder, intent, INTENT_HISTORY_PAGES + 2);
    const rep = await reputationOf(transport, worker.address, { history: 1 });
    expect(rep).toMatchObject({ complete: false, paid: 1 });
    expect(rep.records).toMatchObject([{ intent, outcome: "paid", attestor: judge.address }]);
    expect(rep.records[0]?.earned).toBeGreaterThan(0n);
  });

  it("looks for a buried release in at most two wallets its first announcement notified, and only at release memos", async () => {
    const { client, transport, fresh, escrow, release, pad } = await setup();
    const [worker, owner, judge, padder] = await Promise.all([fresh(), fresh(), fresh(), fresh()]);
    const busy = await Promise.all(Array.from({ length: 5 }, () => fresh()));
    const padding = new Set<string>();
    for (const wallet of busy) {
      for (let i = 0; i < 3; i++) {
        padding.add(await transport.send([getTransferSolInstruction({ source: padder, destination: wallet.address, amount: 1n })], padder));
      }
    }
    const sha256 = "9a".repeat(32);
    const { nonce, intent } = await escrow(owner, judge);
    const salt = await deliverySalt(worker, intent, sha256);
    const blob = await sealDelivery({ salt, url: WORK_URL }, [judge.address], intent);
    const memo = deliveryMemo({ intent, commitment: commitmentOf(intent, worker.address, salt, sha256), check: saltCheckOf(salt), blob });
    const notices = [...busy.map(({ address }) => address), judge.address].map((destination) => getTransferSolInstruction({ source: worker, destination, amount: 0n }));
    await transport.send([memoInstruction(worker, memo), ...notices], worker);
    await release(owner, judge, worker, nonce, intent, sha256);
    await pad(padder, intent, INTENT_HISTORY_PAGES + 2);
    expect(await client.reputation(worker.address)).toMatchObject({ announced: 1 });
    const listed = new Set<Address>();
    const fetched: string[] = [];
    const list = transport.signaturesOf as NonNullable<Transport["signaturesOf"]>;
    const fetch = transport.transactionsOf as NonNullable<Transport["transactionsOf"]>;
    const counting: Transport = {
      ...transport,
      signaturesOf: async (of, limit, before) => {
        listed.add(of);
        return list(of, limit, before);
      },
      transactionsOf: async (wanted) => {
        fetched.push(...wanted.map(({ signature }) => signature));
        return fetch(wanted);
      },
    };
    const rep = await reputationOf(counting, worker.address, { history: 1 });
    expect(rep).toMatchObject({ complete: false, paid: 0 });
    expect(busy.filter(({ address }) => listed.has(address))).toHaveLength(NOTIFIED_WALLETS);
    expect(listed.has(judge.address)).toBe(false);
    expect(fetched.filter((signature) => padding.has(signature))).toEqual([]);
  });

  it("reads on past a short page of signatures in the middle of a history", async () => {
    const { transport, fresh, job, pad } = await setup();
    const [worker, owner, judge, padder] = await Promise.all([fresh(), fresh(), fresh(), fresh()]);
    await job(owner, judge, worker, "4a".repeat(32));
    const intent = await job(owner, judge, worker, "5a".repeat(32));
    await pad(padder, intent, 6);
    const list = transport.signaturesOf as NonNullable<Transport["signaturesOf"]>;
    const short: Transport = { ...transport, signaturesOf: async (of, limit, before) => (await list(of, limit, before)).slice(0, 2) };
    expect(await reputationOf(short, worker.address, { history: 4 })).toMatchObject({ complete: true, paid: 2 });
  });
});

describe("trust that keeps its budget and its shares honest", () => {
  it("does not renormalise a payer's shares over a wallet it did not keep", async () => {
    const { transport, fresh, job } = await setup();
    const [reader, a, b, judge] = await Promise.all([fresh(), fresh(), fresh(), fresh()]);
    await job(reader, judge, a, "4b".repeat(32));
    await job(reader, judge, b, "5c".repeat(32));
    const full = [await trustOf(transport, reader.address, a.address), await trustOf(transport, reader.address, b.address)];
    expect(full.map(({ score }) => score)).toEqual([expect.closeTo((RESTART * (1 - RESTART)) / 2, 12), expect.closeTo((RESTART * (1 - RESTART)) / 2, 12)]);
    const cut = [await trustOf(transport, reader.address, a.address, { maxWallets: 2 }), await trustOf(transport, reader.address, b.address, { maxWallets: 2 })];
    expect(cut.map(({ complete }) => complete)).toEqual([false, false]);
    expect(cut[0]?.wallets).toBe(2);
    expect((cut[0]?.score ?? 0) + (cut[1]?.score ?? 0)).toBeCloseTo((RESTART * (1 - RESTART)) / 2, 12);
  });

  it("spends no wallet budget on a wallet it gives no weight", async () => {
    const { w, transport, fresh, job } = await setup();
    const [reader, solWorker, tokenWorker, judge] = await Promise.all([fresh(), fresh(), fresh(), fresh()]);
    const account = await findAssociatedTokenAddress({ owner: reader.address, mint: w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    await transport.send(
      [
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: w.authority, owner: reader.address, mint: w.inputMint }),
        getMintToInstruction({ mint: w.inputMint, token: account, mintAuthority: w.authority, amount: PAY }),
      ],
      w.authority,
    );
    await job(reader, judge, solWorker, "6d".repeat(32));
    await job(reader, judge, tokenWorker, "7e".repeat(32), w.inputMint);
    const trust = await trustOf(transport, reader.address, solWorker.address, { maxWallets: 2 });
    expect(trust).toMatchObject({ complete: true, wallets: 2 });
    expect(trust.score).toBeCloseTo(RESTART * (1 - RESTART), 12);
  });

  it("reads a bounded number of a payer's payees, however many it paid", async () => {
    const { transport, fresh, job } = await setup();
    const [reader, judge] = await Promise.all([fresh(), fresh()]);
    const payees = await Promise.all(Array.from({ length: TRUST_PAYER_READS + 3 }, () => fresh()));
    for (const [i, payee] of payees.entries()) {
      await job(reader, judge, payee, i.toString(16).padStart(64, "b"));
    }
    const listed: Address[] = [];
    const list = transport.signaturesOf as NonNullable<Transport["signaturesOf"]>;
    const counting: Transport = {
      ...transport,
      signaturesOf: async (of, limit, before) => {
        listed.push(of);
        return list(of, limit, before);
      },
    };
    const trust = await trustOf(counting, reader.address, judge.address);
    expect(trust.complete).toBe(false);
    expect(new Set(listed.filter((of) => payees.some(({ address }) => address === of))).size).toBe(TRUST_PAYER_READS);
  });

  it("reads a worker's escrows a few at a time", async () => {
    const { transport, fresh, job } = await setup();
    const [worker, owner, judge] = await Promise.all([fresh(), fresh(), fresh()]);
    for (let i = 0; i < RECORD_READS + 3; i++) {
      await job(owner, judge, worker, i.toString(16).padStart(64, "c"));
    }
    let active = 0;
    let most = 0;
    const slow: Transport = {
      ...transport,
      transactionsOf: async (listed) => {
        active++;
        most = Math.max(most, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active--;
        return (transport.transactionsOf as NonNullable<Transport["transactionsOf"]>)(listed);
      },
    };
    expect(await reputationOf(slow, worker.address)).toMatchObject({ complete: true, paid: RECORD_READS + 3 });
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(RECORD_READS);
  });

  it("keeps the reader and only as many seeds as the budget holds", async () => {
    const { transport, fresh, job } = await setup();
    const [reader, a, b, c, worker, judge] = await Promise.all([fresh(), fresh(), fresh(), fresh(), fresh(), fresh()]);
    await job(a, judge, worker, "8f".repeat(32));
    const trust = await trustOf(transport, reader.address, worker.address, { seeds: [a.address, b.address, c.address], maxWallets: 2 });
    expect(trust).toMatchObject({ seeds: [reader.address, a.address], complete: false });
    expect(trust.wallets).toBeLessThanOrEqual(2);
  });
});

describe("SOL moved into a wallet", () => {
  const keys = ["Payer", "Funder", "Into", "Base", "Authority", SYSTEM_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS] as Address[];
  const u32 = (value: number) => [...new Uint8Array(Uint32Array.of(value).buffer)];
  const u64 = (value: bigint) => [...new Uint8Array(BigUint64Array.of(value).buffer)];
  const system = (accounts: number[], bytes: number[]) => ({ program: SYSTEM_PROGRAM_ADDRESS, accounts, data: Uint8Array.from(bytes) });
  const seed = [...new TextEncoder().encode("seed")];
  const base = Array.from({ length: 32 }, () => 7);
  const owner = Array.from({ length: 32 }, () => 9);

  it("reads every system instruction that moves SOL, from the wallet that controls it", () => {
    const withSeed = system([1, 2, 3], [...u32(3), ...base, ...u64(4n), ...seed, ...u64(500n), ...u64(0n), ...owner]);
    const transferWithSeed = system([2, 3, 1], [...u32(11), ...u64(700n), ...u64(4n), ...seed, ...owner]);
    const nonce = system([0, 2, 5, 5, 4], [...u32(5), ...u64(900n)]);
    const created = system([1, 2], [...u32(0), ...u64(300n), ...u64(0n), ...owner]);
    const empty = system([1, 2], [...u32(2), ...u64(0n)]);
    expect(solTransfersOf(keys, [withSeed, transferWithSeed, nonce, created, empty])).toEqual([
      { from: "Funder", to: "Into", lamports: 500n },
      { from: "Base", to: "Funder", lamports: 700n },
      { from: "Authority", to: "Into", lamports: 900n },
      { from: "Funder", to: "Into", lamports: 300n },
      { from: "Funder", to: "Into", lamports: 0n },
    ]);
  });

  it("reads a closed token account and any other rise in a named wallet's balance", () => {
    const close = { program: TOKEN_PROGRAM_ADDRESS, accounts: [3, 2, 4], data: Uint8Array.from([9]) };
    const other = { program: TOKEN_PROGRAM_ADDRESS, accounts: [1], data: Uint8Array.from([17]) };
    const balances = { before: [10n, 5n, 0n, 2_039_280n, 1n, 1n, 1n], after: [5n, 45n, 2_039_280n, 0n, 1n, 1n, 1n] };
    expect(solTransfersOf(keys, [close, other], balances)).toEqual([
      { from: "Authority", to: "Into", lamports: 2_039_280n },
      { from: "Payer", to: "Funder", lamports: 40n },
    ]);
    expect(solTransfersOf(keys, [close, other])).toEqual([]);
  });
});
