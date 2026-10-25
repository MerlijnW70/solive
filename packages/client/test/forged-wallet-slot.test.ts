import type { Address, KeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { Kind, NATIVE_MINT, type SealRecipient } from "@intent-engine/core";
import {
  buildAnnounceDelivery,
  buildCreateCommittee,
  buildCreateProfile,
  buildUpdateProfile,
  deliverySecrets,
  newEncryptionKeyFile,
  openWithEsk,
  readEncryptionKeyFile,
  sealDeliveryV4,
  signCommitteeVote,
} from "@intent-engine/core/internal";
import { recipientsFor } from "../src/announce-keys.js";
import { createClient, FirstOpeningRefused } from "../src/index.js";
import { world, type World } from "./svm.js";
import { announced, fundedSigner, keyed, type Keyed, LOCAL, nativeMint, sha, specHash, tokensOf, workUrl } from "./work.js";

const WORK = sha("the honest work");
const ENDPOINT = "https://" + "judge.example";

async function escrowTo(w: World, attestor: Address) {
  nativeMint(w);
  const client = createClient({ url: LOCAL, transport: w.chain.transport });
  const owner = await fundedSigner(w);
  const params = { kind: Kind.AttestedResult, amountIn: 1_000_000n, minResult: 1n, maxResult: 1n, attestor, specHash: specHash("the pinned spec"), judgeFee: 0n } as const;
  const made = await client.createIntent({ signer: owner, params, inputMint: NATIVE_MINT, outputMint: w.outputMint });
  return { client, owner, intent: made.intent, nonce: made.nonce };
}

async function forge(w: World, intent: Address, attestor: Address, recipients: readonly SealRecipient[], committee: boolean) {
  const client = createClient({ url: LOCAL, transport: w.chain.transport });
  const griefer = await fundedSigner(w);
  const source = crypto.getRandomValues(new Uint8Array(32));
  const url = workUrl("grief");
  const blob = await sealDeliveryV4({ source, url, recipients }, intent, griefer.address);
  const { announcement, instruction } = await buildAnnounceDelivery({ worker: griefer, intent, attestor, committee, commitment: new Uint8Array(32).fill(7), blob });
  await client.send([instruction], griefer);
  return { griefer, announcement, blob, esk: (await deliverySecrets(url, recipients, source)).esk };
}

async function publish(w: World, wallet: KeyPairSigner, encryptionKey: string, update = false): Promise<void> {
  const fields = { wallet, skills: ["judge"], endpoint: ENDPOINT, encryptionKey };
  await w.chain.transport.send([update ? await buildUpdateProfile(fields) : await buildCreateProfile(fields)], wallet);
}

describe("an announcement whose wallet slot is not the assigned recipient's wallet key", () => {
  it("is skipped as forged-wallet-slot by firstOpening and openings of a key judge, whose release pays the honest worker, and no revealed key substantiates it for the judge", async () => {
    const w = await world();
    const judge = await keyed(w);
    const { client, owner, intent, nonce } = await escrowTo(w, judge.signer.address);
    const decoy = await fundedSigner(w);
    const { griefer, announcement: grief, blob, esk } = await forge(w, intent, judge.signer.address, [decoy.address], false);
    expect(await openWithEsk(blob, esk, [decoy.address], intent, griefer.address)).not.toBeNull();
    expect(await openWithEsk(blob, esk, [judge.signer.address], intent, griefer.address)).toBeNull();
    const honest = await fundedSigner(w);
    const made = await announced(client, honest, intent, WORK);
    const skipped = [{ announcement: grief, seq: 1n, worker: griefer.address, reason: "forged-wallet-slot" }];
    const first = await client.firstOpening({ intent, sha256: WORK, keypair: judge.keypair });
    expect(first).toMatchObject({ announcement: made.announcement, seq: 2n, worker: honest.address, skipped });
    expect(await client.openings({ intent, keypair: judge.keypair })).toEqual({ intent, opening: { announcement: made.announcement, seq: 2n, worker: honest.address, salt: made.opening.salt, url: workUrl() }, skipped });
    await client.settleProof({ judge: judge.signer, intent: { owner: owner.address, nonce }, announcement: first.announcement, opening: first, result: 1n });
    expect(await tokensOf(w, honest.address)).toBeGreaterThan(0n);
    expect(await tokensOf(w, griefer.address)).toBeNull();
  });

  it("still refuses with key-not-given, naming the profile slot, for a blob sealed to the judge's previous profile key after skipping a forged wallet slot", async () => {
    const w = await world();
    const judge = await keyed(w);
    const { client, intent } = await escrowTo(w, judge.signer.address);
    const decoy = await fundedSigner(w);
    const { griefer, announcement: grief } = await forge(w, intent, judge.signer.address, [decoy.address], false);
    const [old, rotated] = [await newEncryptionKeyFile(), await newEncryptionKeyFile()];
    await publish(w, judge.signer, old.publicKey);
    const early = await fundedSigner(w);
    const sealedToOld = await announced(client, early, intent, WORK);
    await publish(w, judge.signer, rotated.publicKey, true);
    await announced(client, await fundedSigner(w), intent, WORK, workUrl("copied.tar"));
    const current = await readEncryptionKeyFile(rotated.text);
    const refused = await client.firstOpening({ intent, sha256: WORK, keypair: [judge.keypair, current] }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(FirstOpeningRefused);
    expect(refused).toMatchObject({ reason: "key-not-given", announcement: sealedToOld.announcement, seq: 2n, worker: early.address, sealedTo: [{ wallet: judge.signer.address, kind: "profile", published: false }] });
    const opened = await client.firstOpening({ intent, sha256: WORK, keypair: [current, await readEncryptionKeyFile(old.text)] });
    expect(opened).toMatchObject({ announcement: sealedToOld.announcement, skipped: [{ announcement: grief, seq: 1n, worker: griefer.address, reason: "forged-wallet-slot" }] });
  });

  it("lets a committee member skip a blob with the wrong recipient count and a forged wallet slot at its own position, and vote with another member to pay the honest worker", async () => {
    const w = await world();
    const members = [await keyed(w), await keyed(w), await keyed(w)];
    const payer = await fundedSigner(w);
    const { committee, instruction } = await buildCreateCommittee({ payer, members: members.map(({ signer }) => signer.address), threshold: 2, feeWallet: payer.address });
    const { client, owner, intent, nonce } = await escrowTo(w, committee.address);
    const decoy = await fundedSigner(w);
    const early = await forge(w, intent, committee.address, [decoy.address], false);
    await client.send([instruction], payer);
    const order = (await client.committee(committee.address))?.members ?? [];
    const [first, second, third] = order.map((address) => members.find(({ signer }) => signer.address === address) as Keyed) as [Keyed, Keyed, Keyed];
    const { recipients, sync } = await recipientsFor(client.transport, committee.address, intent);
    if (sync !== null) {
      await client.send([sync], owner);
    }
    const forged = await forge(w, intent, committee.address, recipients.map((recipient, i) => (i === 1 ? decoy.address : recipient)), true);
    const worker = await fundedSigner(w);
    const made = await announced(client, worker, intent, WORK);
    const skipped = [
      { announcement: early.announcement, seq: 1n, worker: early.griefer.address, reason: "wrong-recipient-count" },
      { announcement: forged.announcement, seq: 2n, worker: forged.griefer.address, reason: "forged-wallet-slot" },
    ];
    for (const member of [first, second, third]) {
      expect(await client.firstOpening({ intent, sha256: WORK, keypair: member.keypair })).toMatchObject({ announcement: made.announcement, worker: worker.address, skipped });
    }
    const voted = await client.firstOpening({ intent, sha256: WORK, keypair: second.keypair });
    const target = { intent: { owner: owner.address, nonce }, announcement: voted.announcement, opening: voted, result: 1n };
    const ballot = await client.committeeBallot(target);
    const votes = await Promise.all([second, third].map(({ signer }) => signCommitteeVote(signer, ballot.digest, ballot.committee.members)));
    await client.settleCommittee({ ...target, solver: first.signer, votes });
    expect(await tokensOf(w, worker.address)).toBeGreaterThan(0n);
    expect(await tokensOf(w, forged.griefer.address)).toBeNull();
  });
});
