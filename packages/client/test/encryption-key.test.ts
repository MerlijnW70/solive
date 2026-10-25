import type { Address, KeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { Kind } from "@intent-engine/core";
import { buildCreateProfile, buildUpdateProfile, delivery, newEncryptionKeyFile, readEncryptionKeyFile } from "@intent-engine/core/internal";
import { createClient, FirstOpeningRefused } from "../src/index.js";
import { funded, world, type World } from "./svm.js";
import { announced, keyed, LOCAL, sha, specHash, workUrl } from "./work.js";

const WORK = sha("the work");
const ENDPOINT = "https://" + "judge.example";

async function publish(w: World, wallet: KeyPairSigner, encryptionKey?: string): Promise<void> {
  const fields = { wallet, skills: ["judge"], endpoint: ENDPOINT, ...(encryptionKey === undefined ? {} : { encryptionKey }) };
  const exists = (await createClient({ url: LOCAL, transport: w.chain.transport }).profile(wallet.address)) !== null;
  await w.chain.transport.send([exists ? await buildUpdateProfile(fields) : await buildCreateProfile(fields)], wallet);
}

async function escrowFor(w: World, attestor: Address) {
  const client = createClient({ url: LOCAL, transport: w.chain.transport });
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor, specHash: specHash("the spec"), judgeFee: 0n } as const;
  return { client, job: await client.createIntent({ signer: w.owner, inputMint: w.inputMint, outputMint: w.outputMint, params }) };
}

const maskOf = async (client: ReturnType<typeof createClient>, intent: Address) =>
  (await client.announcements(intent)).announcements.map(({ blob }) => delivery.blobHead(blob).mask);

describe("deliveries sealed to a profile's encryption key", () => {
  it("refuse while an earlier announcement is sealed to the judge's published key and no key is given, and pay once it is", async () => {
    const w = await world();
    const judge = await keyed(w);
    const file = await newEncryptionKeyFile();
    const key = await readEncryptionKeyFile(file.text);
    await publish(w, judge.signer, file.publicKey);
    const { client, job } = await escrowFor(w, judge.signer.address);
    const [copier, worker] = [await funded(w.chain), await funded(w.chain)];
    await announced(client, copier, job.intent, sha("not the work"));
    const delivered = await announced(client, worker, job.intent, WORK);
    expect(await maskOf(client, job.intent)).toEqual([1, 1]);
    for (const keypair of [undefined, judge.keypair]) {
      const refused = await client.firstOpening({ intent: job.intent, sha256: WORK, keypair }).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(FirstOpeningRefused);
      expect(refused).toMatchObject({ reason: "key-not-given", seq: 1n, worker: copier.address, sealedTo: [{ wallet: judge.signer.address, kind: "profile", published: true }] });
    }
    const first = await client.firstOpening({ intent: job.intent, sha256: WORK, keypair: key });
    expect(first).toMatchObject({ announcement: delivered.announcement, seq: 2n, worker: worker.address, url: workUrl() });
    const both = await client.firstOpening({ intent: job.intent, sha256: WORK, keypair: [judge.keypair, key] });
    expect(both.announcement).toBe(delivered.announcement);
    await expect(client.settleProof({ judge: judge.signer, intent: { owner: w.owner.address, nonce: job.nonce }, ...delivered, result: 1n })).resolves.toBeTypeOf("string");
  });

  it("refuse when an earlier announcement is sealed to a key the judge rotated away from and not given, instead of skipping it", async () => {
    const w = await world();
    const judge = await keyed(w);
    const [old, rotated] = [await newEncryptionKeyFile(), await newEncryptionKeyFile()];
    await publish(w, judge.signer, old.publicKey);
    const { client, job } = await escrowFor(w, judge.signer.address);
    const [early, late] = [await funded(w.chain), await funded(w.chain)];
    const first = await announced(client, early, job.intent, WORK);
    await publish(w, judge.signer, rotated.publicKey);
    await announced(client, late, job.intent, WORK, workUrl("copied.tar"));
    const current = await readEncryptionKeyFile(rotated.text);
    const refused = await client.firstOpening({ intent: job.intent, sha256: WORK, keypair: current }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(FirstOpeningRefused);
    expect(refused).toMatchObject({ reason: "key-not-given", announcement: first.announcement, seq: 1n, worker: early.address, sealedTo: [{ kind: "profile", published: false }] });
    expect((refused as Error).message).toContain("an earlier encryption key");
    const opened = await client.firstOpening({ intent: job.intent, sha256: WORK, keypair: [current, await readEncryptionKeyFile(old.text)] });
    expect(opened).toMatchObject({ announcement: first.announcement, worker: early.address });
  });

  it("fall back to the key derived from the wallet without a profile, or with a profile that publishes no key or removed it", async () => {
    const w = await world();
    const judge = await keyed(w);
    const { client, job } = await escrowFor(w, judge.signer.address);
    const worker = await funded(w.chain);
    const announce = async (name: string) => announced(client, worker, job.intent, WORK, workUrl(name));
    await announce("a");
    await publish(w, judge.signer);
    await announce("b");
    await publish(w, judge.signer, (await newEncryptionKeyFile()).publicKey);
    await announce("c");
    await publish(w, judge.signer);
    await announce("d");
    expect(await maskOf(client, job.intent)).toEqual([0, 0, 1, 0]);
  });
});
