import { type Address, createSignableMessage, type KeyPairSigner, type TransactionSigner } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { InvalidInput, Kind, NATIVE_MINT } from "@intent-engine/core";
import {
  buildCreateProfile,
  findConfigPda,
  newEncryptionKeyFile,
  saltMessage,
} from "@intent-engine/core/internal";
import { BadSaltSignature, createClient } from "../src/index.js";
import { committeeKeys, recipientsFor, secretSource, type SecretInput } from "../src/announce-keys.js";
import { world, type World } from "./svm.js";
import { fundedSigner, keyed, type Keyed, LOCAL, nativeMint, sha, specHash, workUrl } from "./work.js";

const WORK = sha("the keyed work");
const OTHER = sha("some other work");
const ENDPOINT = "https://" + "member.example";

async function publish(w: World, wallet: KeyPairSigner): Promise<void> {
  const fields = { wallet, skills: ["judge"], endpoint: ENDPOINT, encryptionKey: (await newEncryptionKeyFile()).publicKey };
  await w.chain.transport.send([await buildCreateProfile(fields)], wallet);
}

async function committeeJob(size: number) {
  const w = await world();
  nativeMint(w);
  const client = createClient({ url: LOCAL, transport: w.chain.transport });
  const members: Keyed[] = [];
  for (let i = 0; i < size; i++) {
    members.push(await keyed(w));
  }
  const payer = await fundedSigner(w);
  const { committee } = await client.createCommittee({ payer, members: members.map(({ signer }) => signer.address), threshold: 2, feeWallet: payer.address });
  const view = await client.committee(committee);
  const sorted = (view?.members ?? []).map((address) => members.find(({ signer }) => signer.address === address) as Keyed);
  const owner = await fundedSigner(w);
  const params = { kind: Kind.AttestedResult, amountIn: 1_000_000n, minResult: 1n, maxResult: 1n, attestor: committee, specHash: specHash("the committee spec"), judgeFee: 0n } as const;
  const made = await client.createIntent({ signer: owner, params, inputMint: NATIVE_MINT, outputMint: w.outputMint });
  return { w, client, committee, members: sorted, intent: made.intent };
}

describe("a committee's key snapshot", () => {
  it("matches the published keys of members past the first and stops asking for a sync", async () => {
    const { w, client, committee, members, intent } = await committeeJob(3);
    const [, second, third] = members as [Keyed, Keyed, Keyed];
    await publish(w, second.signer);
    await publish(w, third.signer);
    const worker = await fundedSigner(w);
    expect((await recipientsFor(client.transport, committee, intent)).sync).not.toBeNull();
    expect((await client.announce({ worker, intent, sha256: WORK, url: workUrl() })).synced).toEqual(expect.any(String));
    expect(await committeeKeys(client.transport, committee)).toMatchObject({ synced: true, mask: 0b110 });
    expect((await recipientsFor(client.transport, committee, intent)).sync).toBeNull();
    expect((await client.announce({ worker, intent, sha256: WORK, url: workUrl("second.tar") })).synced).toBeNull();
  });

  it("asks for a sync again when a member the snapshot marks has no published key", async () => {
    const { w, client, committee, members, intent } = await committeeJob(3);
    const [, second] = members as [Keyed, Keyed];
    await publish(w, second.signer);
    const worker = await fundedSigner(w);
    await client.announce({ worker, intent, sha256: WORK, url: workUrl() });
    expect((await recipientsFor(client.transport, committee, intent)).sync).toBeNull();
    await publish(w, (members[2] as Keyed).signer);
    expect((await recipientsFor(client.transport, committee, intent)).sync).not.toBeNull();
  });

  it("reads a committee only from an engine-owned account that carries the committee tag", async () => {
    const { w, client, committee } = await committeeJob(3);
    const real = await client.transport.getAccount(committee);
    if (real === null) {
      throw new Error("no committee");
    }
    const via = (view: typeof real | null) => ({ ...w.chain.transport, getAccount: async () => view });
    const flipped = new Uint8Array(real.data);
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(await committeeKeys(via(real), committee)).toMatchObject({ address: committee, synced: false, mask: 0 });
    expect((await committeeKeys(via(real), committee))?.members).toHaveLength(3);
    expect(await committeeKeys(via(null), committee)).toBeNull();
    expect(await committeeKeys(via({ ...real, owner: TOKEN_PROGRAM_ADDRESS }), committee)).toBeNull();
    expect(await committeeKeys(via({ ...real, data: flipped }), committee)).toBeNull();
    expect(await committeeKeys(via({ ...real, owner: TOKEN_PROGRAM_ADDRESS, data: flipped }), committee)).toBeNull();
  });
});

describe("the secret an announcement is sealed with", () => {
  const INTENT = "SysvarC1ock11111111111111111111111111111111" as Address;

  it("takes a secret of the right length as it is and refuses any other length", async () => {
    const worker = await keyed(await world());
    const given = (secret: Uint8Array): SecretInput => ({ worker: worker.signer, secret });
    const secret = Uint8Array.from({ length: 32 }, (_, i) => i);
    expect(await secretSource(given(secret), INTENT, WORK)).toEqual(secret);
    await expect(secretSource(given(secret.slice(1)), INTENT, WORK)).rejects.toBeInstanceOf(InvalidInput);
    await expect(secretSource(given(new Uint8Array([...secret, 0])), INTENT, WORK)).rejects.toBeInstanceOf(InvalidInput);
  });

  it("takes a salt signature only when it is the worker's own ed25519 signature of the salt message", async () => {
    const worker = await keyed(await world());
    const other = await keyed(await world());
    const message = saltMessage(INTENT, WORK);
    const [signed] = await worker.signer.signMessages([createSignableMessage(message)]);
    const signature = signed?.[worker.signer.address];
    if (signature === undefined) {
      throw new Error("no signature");
    }
    const withSignature = (bytes: Uint8Array, by: TransactionSigner = worker.signer): SecretInput => ({ worker: by, saltSignature: bytes });
    expect(await secretSource(withSignature(signature), INTENT, WORK)).toEqual(Uint8Array.from(signature));
    expect(await secretSource({ worker: worker.signer }, INTENT, WORK)).toEqual(Uint8Array.from(signature));
    await expect(secretSource(withSignature(signature), INTENT, OTHER)).rejects.toBeInstanceOf(BadSaltSignature);
    await expect(secretSource(withSignature(signature, other.signer), INTENT, WORK)).rejects.toBeInstanceOf(BadSaltSignature);
    await expect(secretSource(withSignature(signature.slice(1)), INTENT, WORK)).rejects.toBeInstanceOf(BadSaltSignature);
    await expect(secretSource(withSignature(new Uint8Array([...signature, 0])), INTENT, WORK)).rejects.toBeInstanceOf(BadSaltSignature);
    await expect(secretSource(withSignature(new Uint8Array(64)), INTENT, WORK)).rejects.toBeInstanceOf(BadSaltSignature);
  });

  it("refuses a salt signature for a worker whose address cannot be read as a public key", async () => {
    const [offCurve] = await findConfigPda();
    const unreadable = { address: "not-an-address" } as unknown as TransactionSigner;
    await expect(secretSource({ worker: unreadable, saltSignature: new Uint8Array(64).fill(1) }, INTENT, WORK)).rejects.toBeInstanceOf(BadSaltSignature);
    const worker = { address: offCurve } as unknown as TransactionSigner;
    await expect(secretSource({ worker, saltSignature: new Uint8Array(64).fill(1) }, INTENT, WORK)).rejects.toBeInstanceOf(BadSaltSignature);
  });
});
