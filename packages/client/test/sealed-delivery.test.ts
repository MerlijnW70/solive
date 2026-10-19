import { createHash, generateKeyPairSync } from "node:crypto";
import { type Address, createKeyPairSignerFromBytes, createNoopSigner, type KeyPairSigner, lamports, type Signature } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { describe, expect, it } from "vitest";
import {
  deliveryCommitment,
  DELIVERY_MEMO_PREFIX,
  Kind,
  MAX_COMMITTEE_MEMBERS,
  maxSealedUrl,
  MAX_DELIVERY_MEMO,
  MAX_OPENED_SALTS,
  OPENING_MEMO_PREFIX,
  openingMemo,
  parseDeliveryMemo,
  parseOpeningMemo,
  parseRelease,
  PRODUCT_SLUG,
  saltMessage,
  sealDelivery,
  sealedUrlTooLong,
} from "@intent-engine/core";
import {
  announces,
  commitmentOf,
  createClient,
  type Delivery,
  deliveryInstructions,
  deliveryRecord,
  deliverySalt,
  firstDelivery,
  BadSaltSignature,
  judgeOpenings,
  openingsOf,
  releaseStandingAt,
  unitedSalts,
  MEMO_PROGRAM_ADDRESS,
  memoInstruction,
  NoMessageSigner,
  openingInstructions,
  opensWith,
  PACKET_DATA_SIZE,
  recordedStanding,
  releaseStanding,
  saltCheckOf,
  transactionBytes,
  withWork,
} from "../src/index.js";
import { funded, world, type World } from "./svm.js";

const LOCAL = "http://127.0.0.1:8899";
const SPEC = new Uint8Array(createHash("sha256").update("the spec").digest());
const WORK = createHash("sha256").update("the work").digest("hex");
const YES = createHash("sha256").update("yes").digest("hex");
const NO = createHash("sha256").update("no").digest("hex");
const WORK_URL = "https://example.org/work.tar";
const urlOf = (length: number) => "https://example.org/" + "a".repeat(length - "https://example.org/".length);

async function keyed(w: World): Promise<{ signer: KeyPairSigner; keypair: Uint8Array }> {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const keypair = Uint8Array.from([...Buffer.from(jwk.d ?? "", "base64url"), ...Buffer.from(jwk.x ?? "", "base64url")]);
  const signer = await createKeyPairSignerFromBytes(keypair);
  w.chain.svm.airdrop(signer.address, lamports(10_000_000_000n));
  return { signer, keypair };
}

async function escrow(attestor?: Address) {
  const w = await world();
  const client = createClient({ url: LOCAL, transport: w.chain.transport });
  const judge = await keyed(w);
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: attestor ?? judge.signer.address, specHash: SPEC, judgeFee: 0n } as const;
  const job = await client.createIntent({ signer: w.owner, inputMint: w.inputMint, outputMint: w.outputMint, params });
  return { w, client, judge, job };
}

function memoOf(instructions: readonly { programAddress: Address; data?: ArrayLike<number> }[]): string {
  const memo = instructions.find(({ programAddress }) => programAddress === MEMO_PROGRAM_ADDRESS);
  return new TextDecoder().decode(Uint8Array.from(memo?.data ?? []));
}

async function landed(w: World, payer: KeyPairSigner, to: Address, memo: string) {
  return w.chain.transport.send([memoInstruction(payer, memo), getTransferSolInstruction({ source: payer, destination: to, amount: 0n })], payer);
}

async function memosOf(w: World, of: Address, signature: string): Promise<string[]> {
  return (await w.chain.transport.engineTransactions(20, of)).find((transaction) => transaction.signature === signature)?.memos ?? [];
}

const nextSlot = (w: World) => w.chain.svm.warpToSlot(w.chain.svm.getClock().slot + 1n);

describe("sealed deliveries", () => {
  it("pay the honest worker when a copier lands the same memo text in an earlier slot", async () => {
    const { w, client, judge, job } = await escrow();
    const worker = await funded(w.chain);
    const copier = await funded(w.chain);
    const plan = await deliveryInstructions(w.chain.transport, { worker, intent: job.intent, sha256: WORK, url: WORK_URL });
    const text = memoOf(plan.instructions);
    expect(text.startsWith(DELIVERY_MEMO_PREFIX)).toBe(true);
    expect(plan.salt).toBe(await deliverySalt(worker, job.intent, WORK));
    expect(plan.commitment).toBe(await deliveryCommitment({ intent: job.intent, worker: worker.address, salt: plan.salt, sha256: WORK }));
    expect(plan.check).toBe(saltCheckOf(plan.salt));
    expect(plan.sealedTo).toEqual([judge.signer.address]);
    const copied = await landed(w, copier, judge.signer.address, text);
    nextSlot(w);
    const honest = await w.chain.transport.send(plan.instructions, worker);

    const record = await deliveryRecord(w.chain.transport, judge.signer.address, job.intent, undefined, judge.keypair);
    expect(record.deliveries.map(({ worker: by, signature }) => [by, signature])).toEqual([
      [worker.address, honest],
      [copier.address, copied],
    ]);
    const first = firstDelivery(record.deliveries, WORK);
    expect(first).toMatchObject({ worker: worker.address, signature: honest, sha256: WORK, salt: plan.salt });
    expect(record.deliveries.filter((d) => announces(d, WORK)).map(({ worker: by }) => by)).toEqual([worker.address]);
    expect(firstDelivery(record.deliveries, "cd".repeat(32))).toBeNull();
    const settled = { judge: judge.signer, owner: w.owner.address, nonce: job.nonce, payTo: worker.address, result: 1n, deliveredSha256: WORK, deliveredSalt: plan.salt };
    await expect(client.settleProof(settled)).resolves.toBeTypeOf("string");
  });

  it("pay the honest worker when copies land in the same slot with smaller signatures", async () => {
    const { w, judge, job } = await escrow();
    let found: { worker: KeyPairSigner; honest: string; work: string; copies: string[] } | undefined;
    for (let round = 0; round < 8 && found === undefined; round++) {
      nextSlot(w);
      const worker = await funded(w.chain);
      const work = createHash("sha256").update(`the work ${round}`).digest("hex");
      const plan = await deliveryInstructions(w.chain.transport, { worker, intent: job.intent, sha256: work, url: WORK_URL });
      const honest = await w.chain.transport.send(plan.instructions, worker);
      const copies: string[] = [];
      for (let i = 0; i < 16 && !copies.some((s) => s < honest); i++) {
        copies.push(await landed(w, await funded(w.chain), judge.signer.address, memoOf(plan.instructions)));
      }
      found = copies.some((s) => s < honest) ? { worker, honest, work, copies } : undefined;
    }
    if (found === undefined) {
      throw new Error("no copy signed below the honest announcement");
    }
    const { worker, honest, work, copies } = found;
    const record = await deliveryRecord(w.chain.transport, judge.signer.address, job.intent, undefined, judge.keypair);
    const round = record.deliveries.filter(({ signature }) => signature === honest || copies.includes(signature));
    expect(new Set(round.map(({ slot }) => slot)).size).toBe(1);
    expect(round.some(({ signature }) => signature < honest)).toBe(true);
    expect(firstDelivery(record.deliveries, work)).toMatchObject({ worker: worker.address, signature: honest });
    expect(round.flatMap((d) => withWork(d, work) ?? []).map(({ worker: by, sha256 }) => [by, sha256])).toEqual([[worker.address, work]]);
  });

  it("leave a copier who knows a two-value candidate set unable to match the honest commitment before it is opened", async () => {
    const { w, judge, job } = await escrow();
    const worker = await funded(w.chain);
    const copier = await funded(w.chain);
    const plan = await deliveryInstructions(w.chain.transport, { worker, intent: job.intent, sha256: YES, url: WORK_URL });
    await w.chain.transport.send(plan.instructions, worker);
    const seen = await deliveryRecord(w.chain.transport, judge.signer.address, job.intent);
    const [honest] = seen.deliveries;
    if (honest === undefined) {
      throw new Error("the honest announcement did not land");
    }
    expect(honest.salt).toBe("");
    for (const candidate of [YES, NO]) {
      expect(announces(honest, candidate)).toBe(false);
      expect(honest.commitment).not.toBe(commitmentOf(job.intent, worker.address, await deliverySalt(copier, job.intent, candidate), candidate));
      expect(opensWith(honest, "00".repeat(16), candidate)).toBe(false);
    }
    const parsed = parseDeliveryMemo(memoOf(plan.instructions));
    expect(parsed).toMatchObject({ commitment: plan.commitment, check: plan.check });
    expect(memoOf(plan.instructions)).not.toContain(plan.salt);
    nextSlot(w);
    for (const candidate of [YES, NO]) {
      await w.chain.transport.send((await deliveryInstructions(w.chain.transport, { worker: copier, intent: job.intent, sha256: candidate, url: WORK_URL })).instructions, copier);
    }
    const record = await deliveryRecord(w.chain.transport, judge.signer.address, job.intent, undefined, judge.keypair);
    expect(firstDelivery(record.deliveries, YES)?.worker).toBe(worker.address);
    expect(firstDelivery(record.deliveries, NO)?.worker).toBe(copier.address);
  });

  it("pay the honest earliest announcer and record its salt, so a third party reads the release as valid", async () => {
    const { w, client, judge, job } = await escrow();
    const worker = await funded(w.chain);
    const copier = await funded(w.chain);
    const plan = await deliveryInstructions(w.chain.transport, { worker, intent: job.intent, sha256: WORK, url: WORK_URL });
    await landed(w, copier, judge.signer.address, memoOf(plan.instructions));
    nextSlot(w);
    await w.chain.transport.send(plan.instructions, worker);
    const judged = await deliveryRecord(w.chain.transport, judge.signer.address, job.intent, undefined, judge.keypair);
    const first = firstDelivery(judged.deliveries, WORK);
    expect(first?.worker).toBe(worker.address);
    await client.settleProof({ judge: judge.signer, owner: w.owner.address, nonce: job.nonce, payTo: worker.address, result: 1n, deliveredSha256: WORK, deliveredSalt: first?.salt ?? "" });

    const auditor = createClient({ url: LOCAL, transport: w.chain.transport });
    const released = (await auditor.history(job.intent)).find(({ name }) => name === "IntentAttested");
    expect(released).toMatchObject({ deliveredSha256: WORK, deliveredSalt: plan.salt });
    const record = await auditor.deliveryRecord({ judge: judge.signer.address, intent: job.intent });
    expect(record.deliveries.every(({ salt }) => salt === "")).toBe(true);
    const standing = await recordedStanding(w.chain.transport, job.intent, record);
    expect(standing).toMatchObject({ sha256: WORK, salt: plan.salt, valid: true, refutedBy: null });
    expect(record.deliveries.map((d: Delivery) => opensWith(d, plan.salt, WORK))).toEqual([true, false]);
  });

  it("read a release as refuted when an earlier announcement of the same hash publishes its opening", async () => {
    const { w, client, judge, job } = await escrow();
    const first = await funded(w.chain);
    const later = await funded(w.chain);
    const before = await client.deliver({ worker: first, intent: job.intent, sha256: WORK, url: WORK_URL });
    nextSlot(w);
    await client.deliver({ worker: later, intent: job.intent, sha256: WORK, url: WORK_URL });
    const salt = await deliverySalt(later, job.intent, WORK);
    await client.settleProof({ judge: judge.signer, owner: w.owner.address, nonce: job.nonce, payTo: later.address, result: 1n, deliveredSha256: WORK, deliveredSalt: salt });
    const record = await deliveryRecord(w.chain.transport, judge.signer.address, job.intent);
    expect(await recordedStanding(w.chain.transport, job.intent, record)).toMatchObject({ valid: true, refutedBy: null });
    expect(await client.reputation(later.address)).toMatchObject({ paid: 1, refuted: 0 });

    await expect(client.openDelivery({ worker: first, intent: job.intent, attestor: judge.signer.address, sha256: YES, announcement: before })).rejects.toThrow(RangeError);
    await client.openDelivery({ worker: first, intent: job.intent, attestor: judge.signer.address, sha256: WORK, announcement: before });
    const opened = await deliveryRecord(w.chain.transport, judge.signer.address, job.intent);
    expect(opened.openings.map(({ opening }) => opening)).toEqual([{ intent: job.intent, announcement: before, salt: await deliverySalt(first, job.intent, WORK) }]);
    expect(await recordedStanding(w.chain.transport, job.intent, opened)).toMatchObject({ valid: true, refutedBy: before });
    const reputation = await client.reputation(later.address);
    expect(reputation).toMatchObject({ paid: 0, refuted: 1 });
    expect(reputation.records).toMatchObject([{ intent: job.intent, outcome: "paid", refutedBy: before }]);
  });

  it("list the earlier salts the judge could open in order in its opening memo", async () => {
    const { w, judge, job } = await escrow();
    const [a, b, c, payee] = await Promise.all([funded(w.chain), funded(w.chain), funded(w.chain), funded(w.chain)]);
    const outsider = await keyed(w);
    const deliver = async (worker: KeyPairSigner, sha256: string) => w.chain.transport.send((await deliveryInstructions(w.chain.transport, { worker, intent: job.intent, sha256, url: WORK_URL })).instructions, worker);
    await deliver(a, YES);
    nextSlot(w);
    const sealedAway = await deliveryInstructions(w.chain.transport, { worker: b, intent: job.intent, sha256: NO, url: WORK_URL });
    const away = parseDeliveryMemo(memoOf(sealedAway.instructions));
    const foreign = await sealDelivery({ salt: sealedAway.salt, url: WORK_URL }, [outsider.signer.address], job.intent);
    if (away === null) {
      throw new Error("no delivery memo");
    }
    await landed(w, b, judge.signer.address, `${DELIVERY_MEMO_PREFIX}${job.intent}:${away.commitment}:${away.check}:${foreign}`);
    nextSlot(w);
    await deliver(c, NO);
    nextSlot(w);
    await deliver(payee, WORK);
    const record = await deliveryRecord(w.chain.transport, judge.signer.address, job.intent, undefined, judge.keypair);
    const first = firstDelivery(record.deliveries, WORK);
    if (first === null) {
      throw new Error("the payee's announcement did not open");
    }
    const [opening, ...more] = judgeOpenings(record.deliveries, first);
    const salts = [await deliverySalt(a, job.intent, YES), null, await deliverySalt(c, job.intent, NO)];
    expect(opening).toEqual({ intent: job.intent, salts });
    expect(more).toEqual([]);
    expect(judgeOpenings(record.deliveries, record.deliveries.find(({ worker }) => worker === a.address) as Delivery)).toEqual([]);
    const sent = await w.chain.transport.send(openingInstructions(judge.signer, judge.signer.address, opening ?? { intent: job.intent, salts: [] }), judge.signer);
    const read = await deliveryRecord(w.chain.transport, judge.signer.address, job.intent);
    expect(read.openings.map(({ opening: o, by }) => [o, by])).toEqual([[{ intent: job.intent, salts }, judge.signer.address]]);
    const text = `${OPENING_MEMO_PREFIX}${job.intent}:${salts.map((s) => s ?? "-").join(",")}`;
    expect((await memosOf(w, job.intent, sent))).toEqual([text]);
    expect(parseOpeningMemo(text)).toEqual({ intent: job.intent, salts });
  });

  it("refuse a worker whose signer cannot sign messages, and accept the signature it gives instead", async () => {
    const { w, job } = await escrow();
    const worker = await funded(w.chain);
    const noop = createNoopSigner(worker.address);
    await expect(deliveryInstructions(w.chain.transport, { worker: noop, intent: job.intent, sha256: WORK, url: WORK_URL })).rejects.toThrow(NoMessageSigner);
    const [signed] = await worker.signMessages([{ content: saltMessage(job.intent, WORK), signatures: {} }]);
    const saltSignature = signed?.[worker.address];
    const plan = await deliveryInstructions(w.chain.transport, { worker: noop, intent: job.intent, sha256: WORK, url: WORK_URL, ...(saltSignature === undefined ? {} : { saltSignature }) });
    expect(plan.salt).toBe(await deliverySalt(worker, job.intent, WORK));
    const other = await funded(w.chain);
    const [forged] = await other.signMessages([{ content: saltMessage(job.intent, WORK), signatures: {} }]);
    const wrong = forged?.[other.address] ?? new Uint8Array(64);
    await expect(deliveryInstructions(w.chain.transport, { worker: noop, intent: job.intent, sha256: WORK, url: WORK_URL, saltSignature: wrong })).rejects.toThrow(BadSaltSignature);
    const [elsewhere] = await worker.signMessages([{ content: saltMessage(job.intent, NO), signatures: {} }]);
    const misplaced = elsewhere?.[worker.address] ?? new Uint8Array(64);
    await expect(deliveryInstructions(w.chain.transport, { worker: noop, intent: job.intent, sha256: WORK, url: WORK_URL, saltSignature: misplaced })).rejects.toThrow(BadSaltSignature);
    await expect(deliverySalt(noop, job.intent, WORK, new Uint8Array(12))).rejects.toThrow(BadSaltSignature);
  });

  it("read a release that paid someone other than the salt's announcer as not valid, in every reader", async () => {
    const { w, client, judge, job } = await escrow();
    const worker = await funded(w.chain);
    const bribe = await funded(w.chain);
    await client.deliver({ worker, intent: job.intent, sha256: WORK, url: WORK_URL });
    const salt = await deliverySalt(worker, job.intent, WORK);
    const released = await client.settleProof({ judge: judge.signer, owner: w.owner.address, nonce: job.nonce, payTo: bribe.address, result: 1n, deliveredSha256: WORK, deliveredSalt: salt });
    const record = await deliveryRecord(w.chain.transport, judge.signer.address, job.intent);
    expect(await recordedStanding(w.chain.transport, job.intent, record)).toMatchObject({ signature: released, salt, valid: false, refutedBy: null });
    expect(await releaseStandingAt(w.chain.transport, job.intent, released, { createdAt: null, from: null })).toMatchObject({ valid: false });
    expect((await client.reputation(worker.address)).records).toMatchObject([{ intent: job.intent, outcome: "paid-other" }]);
  });

  it("split an opening longer than one memo into several, keeping the salts in order", () => {
    const intent = "SysvarRent111111111111111111111111111111111" as Address;
    const salts = Array.from({ length: MAX_OPENED_SALTS + 3 }, (_, i) => (i % 5 === 0 ? null : i.toString(16).padStart(32, "0")));
    const chunks = openingsOf(intent, salts);
    expect(chunks.map((chunk) => chunk.salts.length)).toEqual([MAX_OPENED_SALTS, 3]);
    expect(chunks.flatMap((chunk) => chunk.salts)).toEqual(salts);
    for (const chunk of chunks) {
      const memo = openingMemo(chunk);
      expect(memo.length).toBeLessThanOrEqual(MAX_DELIVERY_MEMO);
      expect(parseOpeningMemo(memo)).toEqual(chunk);
    }
    expect(openingsOf(intent, [])).toEqual([]);
    expect(unitedSalts([["ab".repeat(16), null], [null, "cd".repeat(16), "ef".repeat(16)], []])).toEqual(["ab".repeat(16), "cd".repeat(16), "ef".repeat(16)]);
  });

  it("read the judge's opening list as refuting a release to a later announcer, in reputation too", async () => {
    const { w, client, judge, job } = await escrow();
    const first = await funded(w.chain);
    const later = await funded(w.chain);
    const before = await client.deliver({ worker: first, intent: job.intent, sha256: WORK, url: WORK_URL });
    nextSlot(w);
    await client.deliver({ worker: later, intent: job.intent, sha256: WORK, url: WORK_URL });
    await client.settleProof({ judge: judge.signer, owner: w.owner.address, nonce: job.nonce, payTo: later.address, result: 1n, deliveredSha256: WORK, deliveredSalt: await deliverySalt(later, job.intent, WORK) });
    expect(await client.reputation(later.address)).toMatchObject({ paid: 1, refuted: 0 });
    const listed = { intent: job.intent, salts: [await deliverySalt(first, job.intent, WORK)] };
    await w.chain.transport.send(openingInstructions(judge.signer, judge.signer.address, listed), judge.signer);
    const record = await deliveryRecord(w.chain.transport, judge.signer.address, job.intent);
    expect(await recordedStanding(w.chain.transport, job.intent, record)).toMatchObject({ valid: true, refutedBy: before });
    const reputation = await client.reputation(later.address);
    expect(reputation).toMatchObject({ paid: 0, refuted: 1 });
    expect(reputation.records).toMatchObject([{ intent: job.intent, refutedBy: before }]);
  });

  it("ignore clear v1 and sealed v2 announcements in the judge's scan, even when they landed first", async () => {
    const { w, client, judge, job } = await escrow();
    const legacy = await funded(w.chain);
    const sealed = await funded(w.chain);
    const clear = `${PRODUCT_SLUG}-delivery:${job.intent}:${WORK}:${WORK_URL}`;
    await landed(w, legacy, judge.signer.address, clear);
    await landed(w, legacy, judge.signer.address, `${PRODUCT_SLUG}-delivery2:${job.intent}:${"ab".repeat(32)}:AQ==`);
    nextSlot(w);
    await client.deliver({ worker: sealed, intent: job.intent, sha256: WORK, url: WORK_URL });
    const record = await deliveryRecord(w.chain.transport, judge.signer.address, job.intent, undefined, judge.keypair);
    expect(record.complete).toBe(true);
    const salt = await deliverySalt(sealed, job.intent, WORK);
    expect(record.deliveries).toMatchObject([{ worker: sealed.address, url: WORK_URL, salt, commitment: commitmentOf(job.intent, sealed.address, salt, WORK) }]);
    expect(firstDelivery(record.deliveries, WORK)).toMatchObject({ worker: sealed.address, sha256: WORK });
    expect(parseDeliveryMemo(clear)).toBeNull();
  });

  it("open the salt and url for the judge and for every committee member, and for no outsider", async () => {
    const w0 = await world();
    const members = await Promise.all(Array.from({ length: 3 }, () => keyed(w0)));
    const client0 = createClient({ url: LOCAL, transport: w0.chain.transport });
    const payer = await funded(w0.chain);
    const { committee } = await client0.createCommittee({ payer, members: members.map((m) => m.signer.address), threshold: 2, feeWallet: payer.address });
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: committee, specHash: SPEC, judgeFee: 0n } as const;
    const job = await client0.createIntent({ signer: w0.owner, inputMint: w0.inputMint, outputMint: w0.outputMint, params });
    const worker = await funded(w0.chain);
    const outsider = await keyed(w0);
    const plan = await deliveryInstructions(w0.chain.transport, { worker, intent: job.intent, sha256: WORK, url: WORK_URL });
    expect(new Set(plan.sealedTo)).toEqual(new Set(members.map((m) => m.signer.address)));
    await w0.chain.transport.send(plan.instructions, worker);
    for (const member of members) {
      const opened = await client0.deliveryRecord({ judge: committee, intent: job.intent, keypair: member.keypair });
      expect(opened.deliveries).toMatchObject([{ worker: worker.address, url: WORK_URL, salt: plan.salt, commitment: plan.commitment }]);
      expect(firstDelivery(opened.deliveries, WORK)?.worker).toBe(worker.address);
    }
    const closed = await deliveryRecord(w0.chain.transport, committee, job.intent, undefined, outsider.keypair);
    expect(closed.deliveries).toMatchObject([{ worker: worker.address, url: "", sha256: "", salt: "" }]);
    const text = memoOf(plan.instructions);
    expect(text).not.toContain("example.org");
    expect(text).not.toContain(WORK);
    expect(parseDeliveryMemo(text)?.commitment).toBe(commitmentOf(job.intent, worker.address, plan.salt, WORK));
  });

  it("refuse a url too long for one transaction before sending, and fit the longest one", async () => {
    const w0 = await world();
    const members = await Promise.all(Array.from({ length: MAX_COMMITTEE_MEMBERS }, () => keyed(w0)));
    const client0 = createClient({ url: LOCAL, transport: w0.chain.transport });
    const payer = await funded(w0.chain);
    const { committee } = await client0.createCommittee({ payer, members: members.map((m) => m.signer.address), threshold: 3, feeWallet: payer.address });
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: committee, specHash: SPEC, judgeFee: 0n } as const;
    const job = await client0.createIntent({ signer: w0.owner, inputMint: w0.inputMint, outputMint: w0.outputMint, params });
    const worker = await funded(w0.chain);
    const limit = maxSealedUrl(MAX_COMMITTEE_MEMBERS);
    const long = urlOf(limit + 1);
    const sent = w0.chain.sent.length;
    await expect(client0.deliver({ worker, intent: job.intent, sha256: WORK, url: long })).rejects.toThrow(sealedUrlTooLong(long.length, MAX_COMMITTEE_MEMBERS));
    expect(w0.chain.sent.length).toBe(sent);
    const plan = await deliveryInstructions(w0.chain.transport, { worker, intent: job.intent, sha256: WORK, url: urlOf(limit) });
    expect(await transactionBytes(w0.chain.transport, plan.instructions, worker.address)).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    await client0.deliver({ worker, intent: job.intent, sha256: WORK, url: urlOf(limit) });
    const opened = await deliveryRecord(w0.chain.transport, committee, job.intent, undefined, members[7]?.keypair);
    expect(opened.deliveries).toMatchObject([{ worker: worker.address, url: urlOf(limit) }]);
  });

  it("break a tie in slot by signature only among announcements whose salt opens their own commitment", () => {
    const [intent, honest, copier] = ["SysvarRent111111111111111111111111111111111", "SysvarC1ock11111111111111111111111111111111", "11111111111111111111111111111111"] as Address[] as [Address, Address, Address];
    const salt = "ab".repeat(16);
    const commitment = commitmentOf(intent, honest, salt, WORK);
    const check = saltCheckOf(salt);
    const at = (worker: Address, signature: string) => ({ intent, worker, sha256: "", url: "", signature: signature as Signature, slot: 4n, blockTime: null, commitment, check, salt, sealed: "" }) satisfies Delivery;
    const found = [at(copier, "1"), at(honest, "z"), at(copier, "2")];
    expect(firstDelivery(found, WORK)).toMatchObject({ worker: honest, signature: "z", sha256: WORK });
    expect(withWork(at(copier, "1"), WORK)).toBeNull();
    expect(announces(at(honest, "z"), WORK.toUpperCase())).toBe(false);
    expect(announces({ ...at(honest, "z"), check: saltCheckOf("cd".repeat(16)) }, WORK)).toBe(false);
  });

  it("read an earlier opened announcement as refuting only when the release did not also pay its announcer", () => {
    const [intent, payee, coauthor, copier] = [
      "SysvarRent111111111111111111111111111111111",
      "SysvarC1ock11111111111111111111111111111111",
      "SysvarS1otHashes111111111111111111111111111",
      "11111111111111111111111111111111",
    ] as Address[] as [Address, Address, Address, Address];
    const [mine, theirs] = ["ab".repeat(16), "cd".repeat(16)];
    const at = (worker: Address, salt: string, signature: string, slot: bigint) =>
      ({ intent, worker, sha256: "", url: "", signature: signature as Signature, slot, blockTime: null, commitment: commitmentOf(intent, worker, salt, WORK), check: saltCheckOf(salt), salt: "", sealed: "" }) satisfies Delivery;
    const paid = at(payee, mine, "p", 5n);
    const before = at(coauthor, theirs, "c", 4n);
    const opened = [{ opening: { intent, announcement: "c", salt: theirs }, signature: "o", slot: 6n, by: coauthor }];
    expect(releaseStanding([paid, before], opened, { sha256: WORK, salt: mine }, [payee])).toMatchObject({ valid: true, refutedBy: { signature: "c" } });
    expect(releaseStanding([paid, before], opened, { sha256: WORK, salt: mine }, [payee, coauthor])).toMatchObject({ valid: true, refutedBy: null });
    const copied = at(copier, theirs, "c", 4n);
    expect(releaseStanding([paid, copied], opened, { sha256: WORK, salt: mine }, [payee, coauthor])).toMatchObject({ valid: true, refutedBy: { signature: "c" } });
    expect(releaseStanding([paid, before], opened, { sha256: WORK, salt: theirs }, [payee, coauthor])).toMatchObject({ valid: true, payee: { worker: coauthor }, refutedBy: null });
    expect(releaseStanding([paid, before], opened, { sha256: WORK, salt: mine }, [copier])).toMatchObject({ valid: false, refutedBy: null });
    expect(releaseStanding([paid, before], opened, { sha256: WORK, salt: mine }, null)).toMatchObject({ valid: false, refutedBy: null });
    expect(releaseStanding([paid, before], opened, { sha256: "ef".repeat(32), salt: mine }, [payee])).toMatchObject({ valid: false, refutedBy: null });
    expect(releaseStanding([paid, before], opened, { sha256: WORK }, [payee])).toMatchObject({ valid: false });
  });

  it("record the payee's salt in the release memo only beside a hash", async () => {
    const { w, client, judge, job } = await escrow();
    const worker = await funded(w.chain);
    const base = { judge: judge.signer, owner: w.owner.address, nonce: job.nonce, payTo: worker.address, result: 1n };
    await expect(client.settleProof({ ...base, deliveredSalt: "ab".repeat(16) })).rejects.toThrow(RangeError);
    await expect(client.settleProof({ ...base, deliveredSha256: WORK, deliveredSalt: "ab" })).rejects.toThrow(RangeError);
    const released = await client.settleProof({ ...base, deliveredSha256: WORK, deliveredSalt: "AB".repeat(16) });
    const [memo = ""] = await memosOf(w, job.intent, released);
    expect(parseRelease(memo)).toEqual({ sha256: WORK, salt: "ab".repeat(16) });
  });
});
