import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Address, createKeyPairSignerFromBytes, type KeyPairSigner, lamports } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { Kind, NATIVE_MINT } from "@intent-engine/core";
import { buildAnnounceDelivery, refutationAddress } from "@intent-engine/core/internal";
import { createClient, NotRefutable } from "../src/index.js";
import { submit } from "../src/internal.js";
import { specUrlOf } from "../src/job-specs.js";
import { MEMO_PROGRAM_ADDRESS } from "../src/transport.js";
import { world, type World } from "./svm.js";
import { announced, fundedSigner, LOCAL, nativeMint, SOL, specHash, workUrl } from "./work.js";

type Delivery = { source: string; commitment: string; blob: string };

type Legacy = {
  wallets: { owner: string; worker: string; judge: string };
  nonce: string;
  intent: Address;
  sha256: string;
  url: string;
  signed: Delivery;
  secret: Delivery;
  memos: { spec: string };
};

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const LEGACY = JSON.parse(readFileSync(`${ROOT}/packages/core/test/golden/legacy-tags.json`, "utf8")) as Legacy;
const PAY = 1_000_000n;

const bytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));

async function funded(w: World, keypair: string): Promise<KeyPairSigner> {
  const signer = await createKeyPairSignerFromBytes(bytes(keypair));
  w.chain.svm.airdrop(signer.address, lamports(10n * SOL));
  return signer;
}

async function legacyJob() {
  const w = await world();
  nativeMint(w);
  const client = createClient({ url: LOCAL, transport: w.chain.transport });
  const [owner, worker, judge] = await Promise.all([funded(w, LEGACY.wallets.owner), funded(w, LEGACY.wallets.worker), funded(w, LEGACY.wallets.judge)]);
  const params = { kind: Kind.AttestedResult, amountIn: PAY, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: specHash("the legacy spec"), judgeFee: 0n } as const;
  const plan = await client.plan.createIntent({ signer: owner, params, inputMint: NATIVE_MINT, outputMint: w.outputMint, nonce: BigInt(LEGACY.nonce), specUrl: LEGACY.url });
  const memo = new TextEncoder().encode(LEGACY.memos.spec);
  const instructions = plan.instructions.map((ix) => (ix.programAddress === MEMO_PROGRAM_ADDRESS ? { ...ix, data: memo } : ix));
  expect(instructions.filter((ix) => ix.programAddress === MEMO_PROGRAM_ADDRESS)).toHaveLength(1);
  await submit(client.send, { ...plan, instructions }, owner);
  expect(plan.intent).toBe(LEGACY.intent);
  const announce = async (made: Delivery) => {
    const { announcement, instruction } = await buildAnnounceDelivery({ worker, intent: LEGACY.intent, attestor: judge.address, commitment: bytes(made.commitment), blob: bytes(made.blob) });
    await client.send([instruction], worker);
    return announcement;
  };
  const paidBy = async () => {
    const late = await fundedSigner(w);
    const paid = await announced(client, late, LEGACY.intent, LEGACY.sha256, workUrl("late.tar"));
    await client.settleProof({ judge, intent: { owner: owner.address, nonce: BigInt(LEGACY.nonce) }, ...paid, result: 1n });
    return { late, paid };
  };
  return { w, client, worker, announce, paidBy };
}

describe("an escrow and announcement written under the earlier tags", () => {
  it("still names its spec url from the earlier spec memo", async () => {
    const { w } = await legacyJob();
    expect(await specUrlOf(w.chain.transport, LEGACY.intent)).toBe(LEGACY.url);
  });

  it("is still refuted by the worker who signed the earlier salt message", async () => {
    const { client, worker, announce, paidBy } = await legacyJob();
    const earlier = await announce(LEGACY.signed);
    const { late, paid } = await paidBy();
    const refute = { worker, earlier, paid: paid.announcement, sha256: LEGACY.sha256, url: LEGACY.url };
    await expect(client.refute({ ...refute, url: workUrl("other.tar") })).rejects.toThrow(NotRefutable);
    const { refutation } = await client.refute(refute);
    expect(refutation).toBe(await refutationAddress(earlier));
    const rep = await client.reputation(late.address);
    expect(rep).toMatchObject({ paid: 0, refuted: 1 });
    expect(rep.records).toMatchObject([{ refutedBy: refutation, refutations: [{ refutation, standing: "substantiated" }] }]);
  });

  it("is still refuted with the earlier kept secret, and with the earlier salt signature given as bytes", async () => {
    const { client, worker, announce, paidBy } = await legacyJob();
    const kept = await announce(LEGACY.secret);
    const signed = await announce(LEGACY.signed);
    const { late, paid } = await paidBy();
    const base = { worker, paid: paid.announcement, sha256: LEGACY.sha256, url: LEGACY.url };
    await expect(client.refute({ ...base, earlier: kept, saltSignature: bytes(LEGACY.signed.source) })).rejects.toThrow(NotRefutable);
    await client.refute({ ...base, earlier: kept, secret: bytes(LEGACY.secret.source) });
    await client.refute({ ...base, earlier: signed, saltSignature: bytes(LEGACY.signed.source) });
    expect(await client.reputation(late.address)).toMatchObject({ paid: 0, refuted: 1 });
  });
});
