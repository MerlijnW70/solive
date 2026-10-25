import { type Address, generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { Kind, NATIVE_MINT } from "@intent-engine/core";
import { ACCOUNT_LAYOUTS } from "@intent-engine/core/internal";
import { connect, createClient } from "../src/index.js";
import { type World, world } from "./svm.js";
import { announced, fundedSigner, keyed, LOCAL, nativeMint, sha, specHash, workUrl } from "./work.js";

const WORK = sha("the work");
const PAY = 1_000_000n;

function layoutOf(name: string) {
  const layout = ACCOUNT_LAYOUTS.find((each) => each.name === name);
  if (layout === undefined) {
    throw new Error(`no ${name} layout`);
  }
  return layout;
}

function newerCopy(w: World, from: Address, name: string, to: Address = from): string {
  const account = w.chain.svm.getAccount(from);
  if (!account.exists) {
    throw new Error(`${from} does not exist`);
  }
  const layout = layoutOf(name);
  const data = Uint8Array.from(account.data);
  data[8 + layout.versionAt] = layout.version + 1;
  w.chain.svm.setAccount({ ...account, address: to, data });
  return `this ${name} account is of version ${layout.version + 1}`;
}

async function setup() {
  const w = await world();
  nativeMint(w);
  const client = createClient({ url: LOCAL, transport: w.chain.transport });
  const judge = await keyed(w);
  const owner = await fundedSigner(w);
  const escrow = async () => {
    const params = { kind: Kind.AttestedResult, amountIn: PAY, minResult: 1n, maxResult: 1n, attestor: judge.signer.address, specHash: specHash("the spec"), judgeFee: 0n } as const;
    return client.createIntent({ signer: owner, params, inputMint: NATIVE_MINT, outputMint: w.outputMint });
  };
  return { w, client, judge, owner, escrow };
}

describe("client scans beside an account of a newer layout", () => {
  it("lists the valid intents and jobs and names the newer intent with its reason", async () => {
    const { w, client, escrow } = await setup();
    const [valid, newer] = [await escrow(), await escrow()];
    const reason = newerCopy(w, newer.intent, "intent");
    const intents = await client.intents();
    expect(intents.intents.map(({ address }) => address)).toEqual([valid.intent]);
    expect(intents.unreadable).toEqual([{ address: newer.intent, reason: expect.stringContaining(reason) }]);
    const jobs = await client.jobs();
    expect(jobs.jobs.map(({ intent }) => intent)).toEqual([valid.intent]);
    expect(jobs.unreadable).toEqual([{ address: newer.intent, reason: expect.stringContaining(reason) }]);
    expect(await client.jobs({ attestor: (await generateKeyPairSigner()).address })).toEqual({ jobs: [], unreadable: jobs.unreadable });
  });

  it("still fails the scan on a read error that is not about the layout", async () => {
    const { w } = await setup();
    const broken = createClient({ url: LOCAL, transport: { ...w.chain.transport, intents: async () => Promise.reject(new Error("the node is down")) } });
    await expect(broken.intents()).rejects.toThrow("the node is down");
    await expect(broken.jobs()).rejects.toThrow("the node is down");
  });

  it("keeps an escrow's announcement list incomplete while an announcement of it cannot be read", async () => {
    const { w, client, judge, escrow } = await setup();
    const { intent } = await escrow();
    const worker = await fundedSigner(w);
    const first = await announced(client, worker, intent, WORK);
    const second = await announced(client, worker, intent, WORK, workUrl("second.tar"));
    expect(await client.announcements(intent)).toMatchObject({ complete: true, unreadable: [] });
    const copy = (await generateKeyPairSigner()).address;
    const reason = newerCopy(w, second.announcement, "announcement", copy);
    const list = await client.announcements(intent);
    expect(list.announcements.map(({ address }) => address)).toEqual([first.announcement, second.announcement]);
    expect(list.missing).toEqual([]);
    expect(list.unreadable).toEqual([{ address: copy, reason: expect.stringContaining(reason) }]);
    expect(list.complete).toBe(false);
    await expect(client.firstOpening({ intent, sha256: WORK, keypair: judge.keypair })).rejects.toThrow();
    const by = await client.announcementsBy(worker.address);
    expect(by.announcements.map(({ address }) => address)).toEqual([first.announcement, second.announcement]);
    expect(by.unreadable).toEqual(list.unreadable);
    const to = await client.announcementsTo(judge.signer.address);
    expect(to.announcements.map(({ address }) => address)).toEqual([first.announcement, second.announcement]);
    expect(to.unreadable).toEqual(list.unreadable);
  });

  it("drops a missing seq from the list and names the unreadable announcement in its place", async () => {
    const { w, client, escrow } = await setup();
    const { intent } = await escrow();
    const worker = await fundedSigner(w);
    const first = await announced(client, worker, intent, WORK);
    const second = await announced(client, worker, intent, WORK, workUrl("second.tar"));
    const reason = newerCopy(w, second.announcement, "announcement");
    expect(await client.announcements(intent)).toMatchObject({
      announcements: [{ address: first.announcement, seq: 1n }],
      complete: false,
      missing: [2n],
      unreadable: [{ address: second.announcement, reason: expect.stringContaining(reason) }],
    });
  });

  it("never counts a release as clean while a refutation of it cannot be read", async () => {
    const { w, client, judge, owner, escrow } = await setup();
    const { intent, nonce } = await escrow();
    const [early, late] = [await fundedSigner(w), await fundedSigner(w)];
    const earlier = await announced(client, early, intent, WORK, workUrl("first.tar"));
    const paid = await announced(client, late, intent, WORK);
    await client.settleProof({ judge: judge.signer, intent: { owner: owner.address, nonce }, ...paid, result: 1n });
    const clean = await client.reputation(late.address);
    expect(clean).toMatchObject({ paid: 1, refuted: 0, unreadable: [] });
    const { refutation } = await client.refute({ worker: early, earlier: earlier.announcement, paid: paid.announcement, sha256: WORK, url: workUrl("first.tar") });
    const reason = newerCopy(w, refutation, "refutation");
    const rep = await client.reputation(late.address);
    const unreadable = [{ address: refutation, reason: expect.stringContaining(reason) }];
    expect(rep).toMatchObject({ complete: false, paid: 0, refuted: 0, earned: [], unreadable });
    expect(rep.reason).toContain(refutation);
    expect(rep.records.find(({ announcement }) => announcement === paid.announcement)).toMatchObject({ outcome: "paid", refutations: [], unreadable });
    const buyer = await connect({ cluster: "devnet", signer: owner, transport: w.chain.transport });
    expect(await buyer.receipt({ escrow: intent })).toMatchObject({ payee: late.address, valid: true, refutedBy: null, complete: false, unreadable });
  });
});
