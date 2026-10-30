import type { KeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { Kind, NATIVE_MINT } from "@intent-engine/core";
import { buildCreateProfile, delivery, newEncryptionKeyFile, readEncryptionKeyFile } from "@intent-engine/core/internal";
import { createClient } from "../src/index.js";
import { world, type World } from "./svm.js";
import { fundedSigner, keyed, type Keyed, LOCAL, nativeMint, sha, specHash, workUrl } from "./work.js";

const WORK = sha("the opened work");
const ENDPOINT = "https://" + "member.example";

async function publish(w: World, wallet: KeyPairSigner, encryptionKey: string): Promise<void> {
  await w.chain.transport.send([await buildCreateProfile({ wallet, skills: ["judge"], endpoint: ENDPOINT, encryptionKey })], wallet);
}

async function committeeJob() {
  const w = await world();
  nativeMint(w);
  const client = createClient({ url: LOCAL, transport: w.chain.transport });
  const members: Keyed[] = [];
  for (let i = 0; i < 3; i++) {
    members.push(await keyed(w));
  }
  const payer = await fundedSigner(w);
  const { committee } = await client.createCommittee({ payer, members: members.map(({ signer }) => signer.address), threshold: 2, feeWallet: payer.address });
  const view = await client.committee(committee);
  const sorted = (view?.members ?? []).map((address) => members.find(({ signer }) => signer.address === address) as Keyed);
  const owner = await fundedSigner(w);
  const params = { kind: Kind.AttestedResult, amountIn: 1_000_000n, minResult: 1n, maxResult: 1n, attestor: committee, specHash: specHash("the opened spec"), judgeFee: 0n } as const;
  const made = await client.createIntent({ signer: owner, params, inputMint: NATIVE_MINT, outputMint: w.outputMint });
  return { w, client, members: sorted, intent: made.intent };
}

describe("a delivery sealed to a committee whose second member keeps a profile key", () => {
  it("opens for a wallet member, lists each slot by its own kind, and opens for the profile key", async () => {
    const { w, client, members, intent } = await committeeJob();
    const [first, second, third] = members as [Keyed, Keyed, Keyed];
    const file = await newEncryptionKeyFile();
    await publish(w, second.signer, file.publicKey);
    const worker = await fundedSigner(w);
    const made = await client.announce({ worker, intent, sha256: WORK, url: workUrl() });
    const [listed] = (await client.announcements(intent)).announcements;
    expect(delivery.blobHead(listed?.blob ?? new Uint8Array())).toMatchObject({ count: 3, mask: 0b010 });

    for (const opener of [first.keypair, third.keypair, await readEncryptionKeyFile(file.text)]) {
      const opened = await client.firstOpening({ intent, sha256: WORK, keypair: opener });
      expect(opened).toMatchObject({ announcement: made.announcement, worker: worker.address, skipped: [] });
    }
    await expect(client.firstOpening({ intent, sha256: WORK, keypair: second.keypair })).rejects.toMatchObject({
      reason: "key-not-given",
      sealedTo: [
        { wallet: first.signer.address, kind: "wallet", published: true },
        { wallet: second.signer.address, kind: "profile", published: true },
        { wallet: third.signer.address, kind: "wallet", published: true },
      ],
    });
  });
});
