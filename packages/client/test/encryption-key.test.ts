import { createHash, generateKeyPairSync } from "node:crypto";
import { type Address, createKeyPairSignerFromBytes, type KeyPairSigner, lamports } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { buildCreateProfile, buildUpdateProfile, Kind, newEncryptionKeyFile, readEncryptionKeyFile } from "@intent-engine/core";
import { createClient, deliveryInstructions, deliveryRecord, firstDelivery } from "../src/index.js";
import { funded, world, type World } from "./svm.js";

const LOCAL = "http://127.0.0.1:8899";
const SPEC = new Uint8Array(createHash("sha256").update("the spec").digest());
const WORK = createHash("sha256").update("the work").digest("hex");
const WORK_URL = "https://example.org/work.tar";
const ENDPOINT = "https://" + "judge.example";

async function keyed(w: World): Promise<{ signer: KeyPairSigner; keypair: Uint8Array }> {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const keypair = Uint8Array.from([...Buffer.from(jwk.d ?? "", "base64url"), ...Buffer.from(jwk.x ?? "", "base64url")]);
  const signer = await createKeyPairSignerFromBytes(keypair);
  w.chain.svm.airdrop(signer.address, lamports(10_000_000_000n));
  return { signer, keypair };
}

async function publish(w: World, wallet: KeyPairSigner, encryptionKey?: string): Promise<void> {
  const fields = { wallet, skills: ["judge"], endpoint: ENDPOINT, ...(encryptionKey === undefined ? {} : { encryptionKey }) };
  const exists = (await createClient({ url: LOCAL, transport: w.chain.transport }).profile(wallet.address)) !== null;
  await w.chain.transport.send([exists ? await buildUpdateProfile(fields) : await buildCreateProfile(fields)], wallet);
}

async function escrowFor(w: World, attestor: Address) {
  const client = createClient({ url: LOCAL, transport: w.chain.transport });
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor, specHash: SPEC, judgeFee: 0n } as const;
  return { client, job: await client.createIntent({ signer: w.owner, inputMint: w.inputMint, outputMint: w.outputMint, params }) };
}

describe("deliveries sealed to a profile's encryption key", () => {
  it("seal to the judge's profile encryption key, which opens the announcement while its wallet key does not, and pay its worker", async () => {
    const w = await world();
    const judge = await keyed(w);
    const file = await newEncryptionKeyFile();
    const key = await readEncryptionKeyFile(file.text);
    await publish(w, judge.signer, file.publicKey);
    const { client, job } = await escrowFor(w, judge.signer.address);
    expect((await client.profile(judge.signer.address))?.encryptionKey).toBe(file.publicKey);
    const worker = await funded(w.chain);
    const plan = await deliveryInstructions(w.chain.transport, { worker, intent: job.intent, sha256: WORK, url: WORK_URL });
    expect([plan.sealedTo, plan.sealedKeys]).toEqual([[judge.signer.address], ["profile"]]);
    await w.chain.transport.send(plan.instructions, worker);
    const opened = await deliveryRecord(w.chain.transport, judge.signer.address, job.intent, undefined, key);
    expect(opened.deliveries).toMatchObject([{ worker: worker.address, url: WORK_URL, salt: plan.salt }]);
    const walletOnly = await deliveryRecord(w.chain.transport, judge.signer.address, job.intent, undefined, judge.keypair);
    expect(walletOnly.deliveries).toMatchObject([{ worker: worker.address, url: "", salt: "" }]);
    const both = await client.deliveryRecord({ judge: judge.signer.address, intent: job.intent, keypair: [judge.keypair, key] });
    const first = firstDelivery(both.deliveries, WORK);
    expect(first?.worker).toBe(worker.address);
    const settled = { judge: judge.signer, owner: w.owner.address, nonce: job.nonce, payTo: worker.address, result: 1n, deliveredSha256: WORK, deliveredSalt: plan.salt };
    await expect(client.settleProof(settled)).resolves.toBeTypeOf("string");
  });

  it("fall back to the key derived from the wallet without a profile, or with a profile that publishes no key or removed it", async () => {
    const w = await world();
    const judge = await keyed(w);
    const { job } = await escrowFor(w, judge.signer.address);
    const worker = await funded(w.chain);
    const sealedWith = async () => (await deliveryInstructions(w.chain.transport, { worker, intent: job.intent, sha256: WORK, url: WORK_URL })).sealedKeys;
    expect(await sealedWith()).toEqual(["wallet"]);
    await publish(w, judge.signer);
    expect(await sealedWith()).toEqual(["wallet"]);
    await publish(w, judge.signer, (await newEncryptionKeyFile()).publicKey);
    expect(await sealedWith()).toEqual(["profile"]);
    await publish(w, judge.signer);
    expect(await sealedWith()).toEqual(["wallet"]);
    const plan = await deliveryInstructions(w.chain.transport, { worker, intent: job.intent, sha256: WORK, url: WORK_URL });
    await w.chain.transport.send(plan.instructions, worker);
    const opened = await deliveryRecord(w.chain.transport, judge.signer.address, job.intent, undefined, judge.keypair);
    expect(opened.deliveries).toMatchObject([{ worker: worker.address, url: WORK_URL, salt: plan.salt }]);
  });

  it("seal to each committee member's own key: the profile key of a member that publishes one, the wallet key of the others", async () => {
    const w = await world();
    const members = await Promise.all(Array.from({ length: 3 }, () => keyed(w)));
    const payer = await funded(w.chain);
    const client = createClient({ url: LOCAL, transport: w.chain.transport });
    const { committee } = await client.createCommittee({ payer, members: members.map((m) => m.signer.address), threshold: 2, feeWallet: payer.address });
    const [onDevice, ...others] = members;
    if (onDevice === undefined) {
      throw new Error("no member");
    }
    const file = await newEncryptionKeyFile();
    await publish(w, onDevice.signer, file.publicKey);
    const { job } = await escrowFor(w, committee);
    const worker = await funded(w.chain);
    const plan = await deliveryInstructions(w.chain.transport, { worker, intent: job.intent, sha256: WORK, url: WORK_URL });
    expect(plan.sealedTo.map((member, at) => [member, plan.sealedKeys[at]])).toEqual(
      plan.sealedTo.map((member) => [member, member === onDevice.signer.address ? "profile" : "wallet"]),
    );
    await w.chain.transport.send(plan.instructions, worker);
    for (const opener of [await readEncryptionKeyFile(file.text), ...others.map((m) => m.keypair)]) {
      const opened = await deliveryRecord(w.chain.transport, committee, job.intent, undefined, opener);
      expect(opened.deliveries).toMatchObject([{ worker: worker.address, url: WORK_URL, salt: plan.salt }]);
    }
    const closed = await deliveryRecord(w.chain.transport, committee, job.intent, undefined, onDevice.keypair);
    expect(closed.deliveries).toMatchObject([{ url: "", salt: "" }]);
  });
});
