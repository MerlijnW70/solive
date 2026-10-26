import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { HELD_CLAIM_SECS } from "@intent-engine/core/internal";
import { connect } from "../src/index.js";
import { type HeldWorld, heldWorld, SHARES } from "./held.js";
import { ata22, balance22, otherAccount22, requireMemos, tokens22 } from "./token22.js";
import { fundedSigner, LOCAL } from "./work.js";

async function closeAfterClaimWindow(held: HeldWorld, intent: Address) {
  const { w, client } = held;
  const escrow = await client.intent(intent);
  const expiresAt = escrow?.intent.expiresAt ?? 0n;
  w.test.warp(expiresAt + HELD_CLAIM_SECS + 1n - w.test.now());
  const cranker = await fundedSigner(w);
  const signature = await client.close(cranker, intent);
  expect(await client.intent(intent)).toBeNull();
  return signature;
}

async function returnedToOwner() {
  const held = await heldWorld();
  const { w, client, mint, blocked, release, memoRequired } = held;
  const paid = await release(memoRequired);
  const ownerAccount = await ata22(w.owner.address, mint);
  const before = balance22(w, ownerAccount);
  const close = await closeAfterClaimWindow(held, paid.intent);
  expect(balance22(w, ownerAccount) - before).toBe(SHARES[1]);
  await expect(client.plan.claimHeld({ wallet: blocked, announcement: paid.announcement })).rejects.toMatchObject({ code: "no-held-share", reason: "escrow-closed" });
  expect((await client.heldShares(blocked.address)).shares).toEqual([]);
  return { ...held, paid, close, ownerAccount };
}

describe("a held share the closed escrow returned to its owner", () => {
  it("does not tell the co-author in its receipt that its share still waits in the escrow for its claim after the escrow returned it to the owner", async () => {
    const { w, blocked, paid } = await returnedToOwner();
    const simple = await connect({ url: LOCAL, signer: blocked, transport: w.chain.transport });
    const receipt = await simple.receipt({ escrow: paid.intent });
    expect(receipt.held.map(({ received }) => received)).toEqual([false]);
    expect(receipt.summary).not.toContain(`paid to ${blocked.address} but held in the escrow until it claims them`);
  });

  it("does not sum a share the owner got back as held for the co-author to claim in its reputation", async () => {
    const { client, blocked } = await returnedToOwner();
    const reputation = await client.reputation(blocked.address);
    expect(reputation.records[0]).toMatchObject({ outcome: "paid", role: "co-author" });
    expect(reputation.held).toEqual([]);
  });

  it("names a share the close returned as returned to the owner, with its amount and the close transaction, and leaves it out of earned and credit", async () => {
    const { w, client, mint, blocked, paid, close, ownerAccount } = await returnedToOwner();
    const simple = await connect({ url: LOCAL, signer: blocked, transport: w.chain.transport });
    const receipt = await simple.receipt({ escrow: paid.intent });
    expect(receipt.held).toEqual([
      {
        wallet: blocked.address,
        account: await ata22(blocked.address, mint),
        announcement: paid.announcement,
        index: 1,
        amount: SHARES[1],
        state: "returned",
        received: false,
        claimedTo: null,
        claim: null,
        returnedTo: ownerAccount,
        close,
      },
    ]);
    expect(receipt.summary).toContain(`${SHARES[1]} raw units held for ${blocked.address} were returned to the escrow's owner in ${ownerAccount} when the escrow closed in ${close}`);
    const reputation = await client.reputation(blocked.address);
    const [record] = reputation.records;
    expect(record).toMatchObject({ outcome: "paid", role: "co-author", earned: 0n, backed: 0n, createBacked: 0n, held: [{ index: 1, state: "returned", close }] });
    expect(reputation.earned).toEqual([{ mint, amount: 0n }]);
    expect(reputation.held).toEqual([]);
    expect(reputation.backed).toEqual([]);
  });

  it("shows the owner the refund of the share in its own receipt", async () => {
    const { w, paid, close, ownerAccount } = await returnedToOwner();
    const owner = await connect({ url: LOCAL, signer: w.owner, transport: w.chain.transport });
    const receipt = await owner.receipt({ escrow: paid.intent });
    expect(receipt.held).toMatchObject([{ index: 1, amount: SHARES[1], state: "returned", returnedTo: ownerAccount, close }]);
    expect(receipt.summary).toContain(`returned to the escrow's owner in ${ownerAccount}`);
  });
});

describe("a held share claimed before the close", () => {
  it("stays received after the escrow closes, and the close returns nothing of it to the owner", async () => {
    const held = await heldWorld();
    const { w, client, mint, blocked, release, memoRequired } = held;
    const paid = await release(memoRequired);
    const simple = await connect({ url: LOCAL, signer: blocked, transport: w.chain.transport });
    expect((await simple.receipt({ escrow: paid.intent })).held).toMatchObject([{ state: "held", received: false, returnedTo: null, close: null }]);
    const to = await otherAccount22(w, blocked.address, mint);
    const claim = await client.claimHeld({ wallet: blocked, announcement: paid.announcement, to });
    const ownerAccount = await ata22(w.owner.address, mint);
    const before = balance22(w, ownerAccount);
    await closeAfterClaimWindow(held, paid.intent);
    expect(balance22(w, ownerAccount)).toBe(before);
    const receipt = await simple.receipt({ escrow: paid.intent });
    expect(receipt.held).toMatchObject([{ index: 1, amount: SHARES[1], state: "received", received: true, claimedTo: to, claim, returnedTo: null, close: null }]);
    expect(receipt.summary).toContain(`${blocked.address} received its held share of ${SHARES[1]} raw units in ${to}`);
    const reputation = await client.reputation(blocked.address);
    expect(reputation.records[0]).toMatchObject({ outcome: "paid", role: "co-author", earned: SHARES[1], held: [{ state: "received" }] });
    expect(reputation.earned).toEqual([{ mint, amount: SHARES[1] }]);
    expect(reputation.held).toEqual([]);
  });
});

describe("a split with one share claimed and one returned", () => {
  it("reads the claimed share as received and the other as returned to the owner, in the receipt and in each co-author's reputation", async () => {
    const held = await heldWorld();
    const { w, client, mint, announcer, blocked, release, memoRequired } = held;
    const bothBlocked = async (account: Address) => {
      await memoRequired(account);
      await requireMemos(w, announcer, await tokens22(w, announcer.address, mint, 0n));
    };
    const paid = await release(bothBlocked, "both");
    const to = await otherAccount22(w, blocked.address, mint);
    const claim = await client.claimHeld({ wallet: blocked, announcement: paid.announcement, index: 1, to });
    const ownerAccount = await ata22(w.owner.address, mint);
    const before = balance22(w, ownerAccount);
    const close = await closeAfterClaimWindow(held, paid.intent);
    expect(balance22(w, ownerAccount) - before).toBe(SHARES[0]);
    const simple = await connect({ url: LOCAL, signer: w.owner, transport: w.chain.transport });
    const receipt = await simple.receipt({ escrow: paid.intent });
    expect(receipt.held).toMatchObject([
      { wallet: announcer.address, index: 0, amount: SHARES[0], state: "returned", received: false, returnedTo: ownerAccount, close },
      { wallet: blocked.address, index: 1, amount: SHARES[1], state: "received", received: true, claimedTo: to, claim, returnedTo: null, close: null },
    ]);
    const returned = await client.reputation(announcer.address);
    expect(returned.records[0]).toMatchObject({ outcome: "paid", role: "announcer", earned: 0n, held: [{ index: 0, state: "returned" }] });
    expect(returned.held).toEqual([]);
    const claimed = await client.reputation(blocked.address);
    expect(claimed.records[0]).toMatchObject({ outcome: "paid", role: "co-author", earned: SHARES[1], held: [{ index: 1, state: "received" }] });
    expect(claimed.held).toEqual([]);
  });
});
