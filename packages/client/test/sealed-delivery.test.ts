import { createHash, generateKeyPairSync } from "node:crypto";
import { type Address, createKeyPairSignerFromBytes, type KeyPairSigner, lamports } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { describe, expect, it } from "vitest";
import {
  deliveryCommitment,
  DELIVERY_V2_MEMO_PREFIX,
  Kind,
  MAX_COMMITTEE_MEMBERS,
  maxSealedUrl,
  parseDeliveryMemoV2,
  sealedUrlTooLong,
} from "@intent-engine/core";
import {
  announcements,
  announces,
  commitmentOf,
  createClient,
  type Delivery,
  deliveryInstructions,
  deliveryRecord,
  firstDelivery,
  MEMO_PROGRAM_ADDRESS,
  memoInstruction,
  PACKET_DATA_SIZE,
  transactionBytes,
  withWork,
} from "../src/index.js";
import { funded, world, type World } from "./svm.js";

const LOCAL = "http://127.0.0.1:8899";
const SPEC = new Uint8Array(createHash("sha256").update("the spec").digest());
const WORK = createHash("sha256").update("the work").digest("hex");
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

describe("sealed deliveries", () => {
  it("pay the honest worker when a copier lands the same memo text in an earlier slot", async () => {
    const { w, client, judge, job } = await escrow();
    const worker = await funded(w.chain);
    const copier = await funded(w.chain);
    const plan = await deliveryInstructions(w.chain.transport, { worker, intent: job.intent, sha256: WORK, url: WORK_URL });
    const text = memoOf(plan.instructions);
    expect(text.startsWith(DELIVERY_V2_MEMO_PREFIX)).toBe(true);
    expect(plan.commitment).toBe(await deliveryCommitment({ intent: job.intent, worker: worker.address, sha256: WORK }));
    expect(plan.sealedTo).toEqual([judge.signer.address]);
    const copied = await landed(w, copier, judge.signer.address, text);
    w.chain.svm.warpToSlot(w.chain.svm.getClock().slot + 1n);
    const honest = await w.chain.transport.send(plan.instructions, worker);

    const record = await deliveryRecord(w.chain.transport, judge.signer.address, job.intent);
    expect(record.deliveries.map(({ worker: by, signature }) => [by, signature])).toEqual([
      [worker.address, honest],
      [copier.address, copied],
    ]);
    const first = firstDelivery(record.deliveries, WORK);
    expect(first).toMatchObject({ worker: worker.address, signature: honest, sha256: WORK });
    expect(record.deliveries.filter((d) => announces(d, WORK)).map(({ worker: by }) => by)).toEqual([worker.address]);
    expect(firstDelivery(record.deliveries, "cd".repeat(32))).toBeNull();
    await expect(client.settleProof({ judge: judge.signer, owner: w.owner.address, nonce: job.nonce, payTo: worker.address, result: 1n, deliveredSha256: WORK })).resolves.toBeTypeOf("string");
  });

  it("pay the honest worker when copies land in the same slot with smaller signatures", async () => {
    const { w, judge, job } = await escrow();
    let found: { worker: KeyPairSigner; honest: string; work: string; copies: string[] } | undefined;
    for (let round = 0; round < 8 && found === undefined; round++) {
      w.chain.svm.warpToSlot(w.chain.svm.getClock().slot + 1n);
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
    const record = await deliveryRecord(w.chain.transport, judge.signer.address, job.intent);
    const round = record.deliveries.filter(({ signature }) => signature === honest || copies.includes(signature));
    expect(new Set(round.map(({ slot }) => slot)).size).toBe(1);
    expect(round.some(({ signature }) => signature < honest)).toBe(true);
    expect(firstDelivery(record.deliveries, work)).toMatchObject({ worker: worker.address, signature: honest });
    expect(announcements(record.deliveries)).toEqual([]);
    expect(announcements(round.flatMap((d) => withWork(d, work) ?? []))).toMatchObject([{ sha256: work, first: { worker: worker.address }, copies: 0 }]);
  });

  it("break a tie in slot by signature only among announcements whose commitment matches their own fee payer", () => {
    const [intent, honest, copier] = ["SysvarRent111111111111111111111111111111111", "SysvarC1ock11111111111111111111111111111111", "11111111111111111111111111111111"] as Address[] as [Address, Address, Address];
    const commitment = commitmentOf(intent, honest, WORK);
    const at = (worker: Address, signature: string) => ({ intent, worker, sha256: "", url: "", signature, slot: 4n, blockTime: null, commitment }) as unknown as Delivery;
    const found = [at(copier, "1"), at(honest, "z"), at(copier, "2")];
    expect(firstDelivery(found, WORK)).toMatchObject({ worker: honest, signature: "z", sha256: WORK });
    expect(withWork(at(copier, "1"), WORK)).toBeNull();
    expect(announces(at(honest, "z"), WORK.toUpperCase())).toBe(false);
  });

  it("still pay a v1 announcement, and the earlier of a v1 and a v2 announcement of the same work", async () => {
    const { w, client, judge, job } = await escrow();
    const legacy = await funded(w.chain);
    const sealed = await funded(w.chain);
    await client.deliver({ worker: legacy, intent: job.intent, sha256: WORK, url: WORK_URL, version: 1 });
    w.chain.svm.warpToSlot(w.chain.svm.getClock().slot + 1n);
    await client.deliver({ worker: sealed, intent: job.intent, sha256: WORK, url: WORK_URL });
    await client.deliver({ worker: sealed, intent: job.intent, sha256: "cd".repeat(32), url: WORK_URL });
    const record = await deliveryRecord(w.chain.transport, judge.signer.address, job.intent);
    expect(firstDelivery(record.deliveries, WORK)).toMatchObject({ worker: legacy.address, url: WORK_URL, sha256: WORK });
    expect(firstDelivery(record.deliveries, "cd".repeat(32))).toMatchObject({ worker: sealed.address, sha256: "cd".repeat(32) });
    expect(announcements(record.deliveries)).toMatchObject([{ sha256: WORK, first: { worker: legacy.address }, copies: 1 }]);
  });

  it("open the url for the judge and for every committee member, and for no outsider", async () => {
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
      expect(opened.deliveries).toMatchObject([{ worker: worker.address, url: WORK_URL, commitment: plan.commitment }]);
    }
    const closed = await deliveryRecord(w0.chain.transport, committee, job.intent, undefined, outsider.keypair);
    expect(closed.deliveries).toMatchObject([{ worker: worker.address, url: "", sha256: "" }]);
    const text = memoOf(plan.instructions);
    expect(text).not.toContain("example.org");
    expect(text).not.toContain(WORK);
    expect(parseDeliveryMemoV2(text)?.commitment).toBe(commitmentOf(job.intent, worker.address, WORK));
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

  it("let a third party re-derive the payee from the hash in the release memo", async () => {
    const { w, client, judge, job } = await escrow();
    const worker = await funded(w.chain);
    const copier = await funded(w.chain);
    const plan = await deliveryInstructions(w.chain.transport, { worker, intent: job.intent, sha256: WORK, url: WORK_URL });
    await landed(w, copier, judge.signer.address, memoOf(plan.instructions));
    w.chain.svm.warpToSlot(w.chain.svm.getClock().slot + 1n);
    await w.chain.transport.send(plan.instructions, worker);
    await client.settleProof({ judge: judge.signer, owner: w.owner.address, nonce: job.nonce, payTo: worker.address, result: 1n, deliveredSha256: WORK });

    const auditor = createClient({ url: LOCAL, transport: w.chain.transport });
    const released = (await auditor.history(job.intent)).find(({ name }) => name === "IntentAttested");
    const recorded = released?.name === "IntentAttested" ? released.deliveredSha256 : undefined;
    expect(recorded).toBe(WORK);
    const record = await auditor.deliveryRecord({ judge: judge.signer.address, intent: job.intent });
    expect(record.complete).toBe(true);
    const recomputed = record.deliveries.map((d: Delivery) => ({ worker: d.worker, matches: d.commitment === commitmentOf(d.intent, d.worker, recorded ?? "") }));
    expect(recomputed).toEqual([
      { worker: worker.address, matches: true },
      { worker: copier.address, matches: false },
    ]);
    expect(firstDelivery(record.deliveries, recorded ?? "")?.worker).toBe(worker.address);
  });
});
