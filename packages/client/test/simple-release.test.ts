import { type Address, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT as TEST, feeBpsFor, IntentStatus, Kind, NATIVE_MINT as WSOL, splitFees, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import { connect, FirstOpeningRefused, NotSettleable, type SimpleClient } from "../src/index.js";
import { notFirstAnnouncer } from "../src/internal.js";
import { funded, world, type World } from "./svm.js";
import { keyed, sha, tokensOf, workUrl } from "./work.js";

const WORK = sha("the delivered work");
const SPEC = sha("the acceptance spec");
const PAY = 10_000_000n;

function preset(w: World, at: Address): void {
  const space = BigInt(getMintSize());
  w.chain.svm.setAccount({
    address: at,
    data: Uint8Array.from(getMintEncoder().encode({ mintAuthority: none(), supply: 0n, decimals: 9, isInitialized: true, freezeAuthority: none() })),
    executable: false,
    lamports: lamports(w.chain.svm.minimumBalanceForRentExemption(space)),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space,
  });
}

async function job() {
  const w = await world();
  preset(w, WSOL);
  preset(w, TEST);
  const owner = await funded(w.chain);
  const judge = await keyed(w);
  const at = (signer: KeyPairSigner) => connect({ cluster: "devnet", signer, transport: w.chain.transport });
  const buyer = await at(owner);
  const reviewer = await at(judge.signer);
  const made = await buyer.payForWork({ amount: "0.01", judge: judge.signer.address, specHash: SPEC });
  return { w, owner, judge, buyer, reviewer, at, escrow: made.intent as Address, nonce: made.nonce ?? 0n };
}

async function delivered(seller: SimpleClient<KeyPairSigner>, escrow: Address, url = workUrl()) {
  const done = await seller.deliver({ escrow, sha256: WORK, url });
  return done.announcement;
}

describe("the simple release pays the first announcement that opens to the work", () => {
  it("delivers with an announcement, releases with the judge's key, and reads the release as valid with the worker's reputation", async () => {
    const { w, judge, buyer, reviewer, at, escrow, nonce } = await job();
    const worker = await funded(w.chain);
    const seller = await at(worker);
    const sent = w.chain.sent.length;
    const previewed = await seller.deliver({ escrow, sha256: WORK, url: workUrl(), preview: true });
    expect(previewed.summary).toBe(`Deliver work ${WORK} at ${workUrl()} for escrow ${escrow}`);
    expect(previewed.instructions.length).toBeGreaterThan(0);
    expect(w.chain.sent).toHaveLength(sent);
    const made = await seller.deliver({ escrow, sha256: WORK.toUpperCase(), url: workUrl() });
    expect(made).toMatchObject({ seq: 1n, summary: previewed.summary, signature: expect.any(String) });
    expect(await seller.deliver({ escrow, sha256: WORK, url: workUrl() })).toEqual({ ...made, signature: null });

    const preview = await reviewer.release({ escrow, deliveredSha256: WORK.toUpperCase(), keypair: judge.keypair, preview: true });
    expect(preview.summary).toBe(`Release escrow ${escrow} holding 0.01 SOL to ${worker.address} for work ${WORK}, announced first in ${made.announcement}`);
    expect(preview.instructions.length).toBeGreaterThan(0);
    expect((await buyer.client.intent({ owner: buyer.signer.address, nonce }))?.intent.status).toBe(IntentStatus.Open);

    const released = await reviewer.release({ escrow, to: worker.address, deliveredSha256: WORK, keypair: judge.keypair });
    expect(w.chain.sent).toContain(released.signature);
    const { net } = splitFees(PAY, feeBpsFor(await buyer.client.config(), Kind.AttestedResult), 0, 0);
    expect(await tokensOf(w, worker.address, WSOL)).toBe(net);
    const event = (await buyer.client.history(escrow)).events.find(({ name }) => name === "IntentAttested");
    expect(event).toMatchObject({ signature: released.signature, deliveredSha256: WORK, deliveredSalt: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(await buyer.client.reputation(worker.address)).toMatchObject({ paid: 1, refuted: 0 });
    expect(await buyer.receipt({ escrow })).toMatchObject({ escrow, released: true, signature: released.signature, payee: worker.address, deliveredSha256: WORK, valid: true, refutedBy: null, complete: true });
    expect(await buyer.deliveries({ escrow })).toEqual([{ worker: worker.address, sha256: WORK, url: null, opened: false, announcement: made.announcement, seq: 1n }]);
    expect(await reviewer.deliveries({ escrow, keypair: judge.keypair })).toEqual([{ worker: worker.address, sha256: WORK, url: workUrl(), opened: true, announcement: made.announcement, seq: 1n }]);
  });

  it("refuses a to that is not the first announcer and names the announcement that came first", async () => {
    const { w, judge, reviewer, at, escrow } = await job();
    const [first, later] = [await funded(w.chain), await funded(w.chain)];
    const before = await delivered(await at(first), escrow);
    const after = await delivered(await at(later), escrow, workUrl("copied.tar"));
    const sent = w.chain.sent.length;
    const refused = reviewer.release({ escrow, to: later.address, deliveredSha256: WORK, keypair: judge.keypair });
    await expect(refused).rejects.toThrow(NotSettleable);
    await expect(refused).rejects.toThrow(notFirstAnnouncer(first.address, before, WORK, later.address));
    expect(w.chain.sent).toHaveLength(sent);
    expect(await reviewer.deliveries({ escrow, sha256: WORK, keypair: judge.keypair })).toEqual([
      { worker: first.address, sha256: WORK, url: workUrl(), opened: true, announcement: before, seq: 1n },
      { worker: later.address, sha256: WORK, url: workUrl("copied.tar"), opened: true, announcement: after, seq: 2n },
    ]);
  });

  it("refuses without the judge's key and for work nothing opens to, and pays once the key is given", async () => {
    const { w, judge, reviewer, at, escrow } = await job();
    const worker = await funded(w.chain);
    const announcement = await delivered(await at(worker), escrow);
    const sent = w.chain.sent.length;
    const refused = await reviewer.release({ escrow, deliveredSha256: WORK }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(FirstOpeningRefused);
    expect(refused).toMatchObject({ reason: "key-not-given", announcement, worker: worker.address });
    await expect(reviewer.release({ escrow, deliveredSha256: sha("other work"), keypair: judge.keypair })).rejects.toMatchObject({ reason: "nothing-opens" });
    expect(w.chain.sent).toHaveLength(sent);
    expect(await reviewer.deliveries({ escrow, sha256: WORK })).toEqual([{ worker: worker.address, sha256: null, url: null, opened: false, announcement, seq: 1n }]);
    expect(await reviewer.deliveries({ escrow, sha256: WORK, keypair: judge.keypair })).toEqual([{ worker: worker.address, sha256: WORK, url: workUrl(), opened: true, announcement, seq: 1n }]);
    const released = await reviewer.release({ escrow, deliveredSha256: WORK, keypair: judge.keypair });
    expect(w.chain.sent).toContain(released.signature);
    expect(await reviewer.receipt({ escrow })).toMatchObject({ released: true, payee: worker.address, deliveredSha256: WORK, valid: true });
  });

  it("reads an escrow nobody released yet", async () => {
    const { buyer, escrow } = await job();
    expect(await buyer.receipt({ escrow })).toEqual({
      escrow,
      released: false,
      signature: null,
      payee: null,
      payees: [],
      deliveredSha256: null,
      valid: false,
      refutedBy: null,
      held: [],
      withheld: [],
      complete: true,
      unreadable: [],
      summary: `Escrow ${escrow} is not released yet`,
    });
    expect(await buyer.deliveries({ escrow })).toEqual([]);
  });
});
