import { type Address, getAddressDecoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  ANNOUNCEMENT_DISCRIMINATOR,
  delivery,
  getAnnouncementDecoder,
  getAnnouncementEncoder,
  Kind,
  NATIVE_MINT,
  sealDeliveryV4,
} from "@intent-engine/core";
import { connect, createClient, type EngineAccount, FirstOpeningRefused, MISSING_SHOWN, type Transport } from "../src/index.js";
import { world } from "./svm.js";
import { announced, fundedSigner, keyed, nativeMint, sha, specHash, tokensOf, workUrl } from "./work.js";

const WORK = sha("the honest work");
const SPAM = 2_000;

const tagged = (data: ArrayLike<number>) => ANNOUNCEMENT_DISCRIMINATOR.every((b, i) => data[i] === b);

const addressAt = (i: number): Address => getAddressDecoder().decode(Uint8Array.from({ length: 32 }, (_, at) => (at < 4 ? (i >> (8 * at)) & 0xff : 0x5a)));

async function spammed() {
  const w = await world();
  nativeMint(w);
  const judge = await keyed(w);
  const owner = await fundedSigner(w);
  const client = createClient({ url: "http://127.0.0.1:8899", transport: w.chain.transport });
  const params = { kind: Kind.AttestedResult, amountIn: 1_000_000n, minResult: 1n, maxResult: 1n, attestor: judge.signer.address, specHash: specHash("the spec"), judgeFee: 0n } as const;
  const { intent } = await client.createIntent({ signer: owner, params, inputMint: NATIVE_MINT, outputMint: w.outputMint });
  const honest = await fundedSigner(w);
  const delivered = await announced(client, honest, intent, WORK);
  const real = w.chain.svm.getAccount(delivered.announcement);
  if (!real.exists) {
    throw new Error("no announcement");
  }
  const stored = getAnnouncementDecoder().decode(new Uint8Array(real.data));
  const spammer = addressAt(0xffffff);
  const blob = await sealDeliveryV4({ source: crypto.getRandomValues(new Uint8Array(32)), url: workUrl("spam"), recipients: [judge.signer.address] }, intent, spammer);
  const padded = new Uint8Array(delivery.MAX_SEALED_BLOB);
  padded.set(blob);
  const spam = Array.from({ length: SPAM }, (_, i): EngineAccount => ({
    address: addressAt(i + 1),
    data: new Uint8Array(getAnnouncementEncoder().encode({ ...stored, worker: spammer, seq: BigInt(i + 1), commitment: new Uint8Array(32).fill(9), blob: padded, blobLen: blob.length })),
    lamports: 1n,
  }));
  const relabelled = { address: delivered.announcement, data: new Uint8Array(getAnnouncementEncoder().encode({ ...stored, seq: BigInt(SPAM + 1) })), lamports: 1n };
  const listing = (accounts: readonly EngineAccount[]): Transport => ({
    ...w.chain.transport,
    engineAccounts: async (filter) => (filter !== undefined && tagged(filter.discriminator) ? [...accounts] : (w.chain.transport.engineAccounts?.(filter) ?? [])),
  });
  return { w, judge, owner, intent, honest, delivered, spam, relabelled, listing };
}

describe("an escrow flooded with announcements", () => {
  it("names at most the first missing seqs and stays fast however far the last seq present lies", async () => {
    const { intent, spam, relabelled, listing } = await spammed();
    const far = { ...relabelled, data: new Uint8Array(getAnnouncementEncoder().encode({ ...getAnnouncementDecoder().decode(relabelled.data), seq: 1n << 62n })) };
    const client = createClient({ url: "http://127.0.0.1:8899", transport: listing([spam[0] as EngineAccount, far]) });
    const list = await client.announcements(intent);
    expect(list).toMatchObject({ complete: false });
    expect(list.missing).toEqual(Array.from({ length: MISSING_SHOWN }, (_, i) => BigInt(i + 2)));
  });

  it("lists 2,000 spam announcements and the honest one complete, and the first opening walks past them to pay the honest worker", { timeout: 60_000 }, async () => {
    const { w, judge, intent, honest, delivered, spam, relabelled, listing } = await spammed();
    const transport = listing([relabelled, ...spam].reverse());
    const client = createClient({ url: "http://127.0.0.1:8899", transport });
    const list = await client.announcements(intent);
    expect(list).toMatchObject({ complete: true, missing: [] });
    expect(list.announcements).toHaveLength(SPAM + 1);
    expect(list.announcements.map(({ seq }) => seq)).toEqual(Array.from({ length: SPAM + 1 }, (_, i) => BigInt(i + 1)));
    const first = await client.firstOpening({ intent, sha256: WORK, keypair: judge.keypair });
    expect(first).toMatchObject({ announcement: delivered.announcement, seq: BigInt(SPAM + 1), worker: honest.address });
    const reviewer = await connect({ cluster: "devnet", signer: judge.signer, transport });
    await reviewer.release({ escrow: intent, deliveredSha256: WORK, keypair: judge.keypair });
    expect(await tokensOf(w, honest.address)).toBeGreaterThan(0n);
  });

  it("shows the list incomplete when one seq is missing, and the release is refused before anything is sent", { timeout: 60_000 }, async () => {
    const { w, judge, intent, honest, spam, relabelled, listing } = await spammed();
    const transport = listing([...spam.filter((_, i) => i !== 999), relabelled]);
    const client = createClient({ url: "http://127.0.0.1:8899", transport });
    expect(await client.announcements(intent)).toMatchObject({ complete: false, missing: [1_000n] });
    const reviewer = await connect({ cluster: "devnet", signer: judge.signer, transport });
    const sent = w.chain.sent.length;
    const refused = await reviewer.release({ escrow: intent, deliveredSha256: WORK, keypair: judge.keypair }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(FirstOpeningRefused);
    expect(refused).toMatchObject({ reason: "incomplete", missing: [1_000n] });
    expect(w.chain.sent).toHaveLength(sent);
    expect(await tokensOf(w, honest.address)).toBeNull();
  });
});
