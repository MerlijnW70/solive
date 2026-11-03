import { type Address, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { Kind, NATIVE_MINT } from "@intent-engine/core";
import { buildCreateProfile, buildUpdateProfile, newEncryptionKeyFile, profileAddress } from "@intent-engine/core/internal";
import { createClient, type Transport } from "../src/index.js";
import { reputationOf } from "../src/internal.js";
import { keylessJudges } from "../src/unopened.js";
import { standingUnread } from "../src/work-records.js";
import { world } from "./svm.js";
import { announced, fundedSigner, keyed, LOCAL, nativeMint, sha, specHash, workUrl } from "./work.js";

const WORK = sha("the reputation reads work");
const PAY = 1_000_000n;

const badGateway = () => new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers(), message: "Bad Gateway", statusCode: 502 });

const failingAt = (transport: Transport, address: Address, error: Error): Transport => ({
  ...transport,
  getAccount: async (asked) => {
    if (asked === address) {
      throw error;
    }
    return transport.getAccount(asked);
  },
});

async function refuted() {
  const w = await world();
  nativeMint(w);
  const client = createClient({ url: LOCAL, transport: w.chain.transport });
  const judge = await keyed(w);
  const owner = await fundedSigner(w);
  const fields = { wallet: judge.signer, skills: ["judge"], endpoint: "https://" + "judge.example", encryptionKey: (await newEncryptionKeyFile()).publicKey };
  await client.send([await buildCreateProfile(fields)], judge.signer);
  const params = { kind: Kind.AttestedResult, amountIn: PAY, minResult: 1n, maxResult: 1n, attestor: judge.signer.address, specHash: specHash("the reputation reads spec"), judgeFee: 0n } as const;
  const { intent, nonce } = await client.createIntent({ signer: owner, params, inputMint: NATIVE_MINT, outputMint: w.outputMint });
  const [early, late] = [await fundedSigner(w), await fundedSigner(w)];
  const earlier = await announced(client, early, intent, WORK, workUrl("first.tar"));
  const paid = await announced(client, late, intent, WORK);
  await client.settleProof({ judge: judge.signer, intent: { owner: owner.address, nonce }, ...paid, result: 1n });
  const { refutation } = await client.refute({ worker: early, earlier: earlier.announcement, paid: paid.announcement, sha256: WORK, url: workUrl("first.tar") });
  return { w, client, judge, late, paid, refutation, profile: await profileAddress(judge.signer.address) };
}

describe("a refutation whose recipients' keys cannot be read", () => {
  it("leaves the release out and the record incomplete, with a reason, when the judge's profile read fails in transport", async () => {
    const { w, late, paid, refutation, profile } = await refuted();
    const honest = await reputationOf(w.chain.transport, late.address);
    expect(honest).toMatchObject({ complete: true, paid: 0, refuted: 1 });
    const error = badGateway();
    const rep = await reputationOf(failingAt(w.chain.transport, profile, error), late.address);
    expect(rep).toMatchObject({ complete: false, paid: 0, refuted: 0, reason: standingUnread(paid.announcement, { address: refutation, reason: error.message }) });
    expect(rep.records).toMatchObject([{ outcome: "paid", refutations: [], unreadable: [{ address: refutation, reason: error.message }] }]);
    expect(rep.records[0]?.refutedBy).toBeUndefined();
    expect(rep.unreadable).toStrictEqual([{ address: refutation, reason: error.message }]);
  });

  it("lets a programming error in the profile read surface", async () => {
    const { w, late, profile } = await refuted();
    const bug = new TypeError("Cannot read properties of undefined (reading 'data')");
    await expect(reputationOf(failingAt(w.chain.transport, profile, bug), late.address)).rejects.toBe(bug);
  });

  it("still lists a refutation as unverifiable, and counts the release, once the judge's profile publishes no key", async () => {
    const { w, client, judge, late, refutation } = await refuted();
    await client.send([await buildUpdateProfile({ wallet: judge.signer, skills: ["judge"], endpoint: "https://" + "judge.example" })], judge.signer);
    const rep = await reputationOf(w.chain.transport, late.address);
    expect(rep).toMatchObject({ complete: true, paid: 1, refuted: 0 });
    expect(rep.records).toMatchObject([{ outcome: "paid", refutations: [{ refutation, standing: "unverifiable" }] }]);
  });
});

describe("keylessJudges when a profile cannot be read", () => {
  it("throws the transport error instead of naming the judge as keyless", async () => {
    const w = await world();
    const judge = await fundedSigner(w);
    const error = badGateway();
    expect(await keylessJudges(w.chain.transport, judge.address)).toStrictEqual([judge.address]);
    await expect(keylessJudges(failingAt(w.chain.transport, await profileAddress(judge.address), error), judge.address)).rejects.toBe(error);
  });
});
