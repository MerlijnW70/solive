import { describe, expect, it } from "vitest";
import { InvalidInput, isSdkError } from "../src/index.js";
import { ANNOUNCEMENT_HELD_AT, ANNOUNCEMENT_STATE_AT } from "../src/held-shares.js";
import { loadAnnouncement } from "../src/announcement-reads.js";
import { heldBack } from "../src/reclaim-reasons.js";
import { delivery } from "@intent-engine/core/internal";
import { heldWorld, SHARES, WEIGHTS } from "./held.js";
import { ata22, balance22, otherAccount22 } from "./token22.js";

describe("held split shares", () => {
  it("lists the share a split release held for a co-author whose account requires memos, claims it into another account, and lists nothing after", async () => {
    const { w, client, announcer, blocked, release, memoRequired } = await heldWorld();
    const paid = await release(memoRequired);
    const blockedAta = await ata22(blocked.address, (await client.intent(paid.intent))?.intent.inputMint ?? blocked.address);
    expect(balance22(w, blockedAta)).toBe(0n);
    const listed = await client.heldShares(blocked.address);
    expect(listed).toMatchObject({ wallet: blocked.address, complete: true, reasons: [] });
    expect(listed.shares).toEqual([
      expect.objectContaining({
        wallet: blocked.address,
        intent: paid.intent,
        announcement: paid.announcement,
        index: 1,
        amount: SHARES[1],
        account: blockedAta,
        release: paid.signature,
        split: { recipients: [announcer.address, blocked.address], weights: WEIGHTS },
      }),
    ]);
    expect((await client.heldShares(announcer.address)).shares).toEqual([]);
    const other = await otherAccount22(w, blocked.address, listed.shares[0]?.mint ?? blocked.address);
    const plan = await client.plan.claimHeld({ wallet: blocked, announcement: paid.announcement, to: other });
    expect(plan).toMatchObject({ payer: blocked.address, to: other, share: { index: 1, amount: SHARES[1] } });
    await client.claimHeld({ wallet: blocked, announcement: paid.announcement, to: other });
    expect(balance22(w, other)).toBe(SHARES[1]);
    expect((await client.heldShares(blocked.address)).shares).toEqual([]);
    expect((await loadAnnouncement(w.chain.transport, paid.announcement))?.held).toBe(0);
    await expect(client.plan.claimHeld({ wallet: blocked, announcement: paid.announcement, to: other })).rejects.toMatchObject({ code: "no-held-share", reason: "not-held" });
  });

  it("refuses to claim into the canonical account while it still requires memos, and into an account of another wallet", async () => {
    const { w, client, announcer, blocked, release, memoRequired } = await heldWorld();
    const paid = await release(memoRequired);
    const error = await client.plan.claimHeld({ wallet: blocked, announcement: paid.announcement }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidInput);
    expect(error).toMatchObject({ field: "to", rule: "missing" });
    const [share] = (await client.heldShares(blocked.address)).shares;
    const theirs = await otherAccount22(w, announcer.address, share?.mint ?? blocked.address);
    await expect(client.plan.claimHeld({ wallet: blocked, announcement: paid.announcement, to: theirs })).rejects.toMatchObject({ field: "to", rule: "conflict" });
    await expect(client.plan.claimHeld({ wallet: announcer, announcement: paid.announcement, to: theirs })).rejects.toSatisfy((caught: unknown) => isSdkError(caught, "no-held-share"));
  });

  it("holds nothing when every co-author's account takes its share", async () => {
    const { client, blocked, release } = await heldWorld();
    const paid = await release();
    expect((await client.heldShares(blocked.address)).shares).toEqual([]);
    expect((await loadAnnouncement(client.transport, paid.announcement))?.held).toBe(0);
  });

  it("reads the paid state and held byte at the offsets the listing filters on", async () => {
    const { w, client, release, memoRequired } = await heldWorld();
    const paid = await release(memoRequired);
    const raw = await w.chain.transport.getAccount(paid.announcement);
    const view = await loadAnnouncement(client.transport, paid.announcement);
    expect(raw?.data[ANNOUNCEMENT_STATE_AT]).toBe(1);
    expect(raw?.data[ANNOUNCEMENT_HELD_AT]).toBe(view?.held);
    expect(view?.held).toBe(0b10);
  });

  it("keeps the paid announcement out of a reclaim while it holds a share, and closes it once the share is claimed", async () => {
    const { w, client, announcer, blocked, release, memoRequired } = await heldWorld();
    const paid = await release(memoRequired);
    w.test.warp(delivery.REFUTE_WINDOW_SECS + 1n);
    const kept = await client.plan.reclaim({ worker: announcer });
    expect(kept.closed).toEqual([]);
    expect(kept.reasons).toEqual([{ announcement: paid.announcement, reason: heldBack(paid.intent) }]);
    const [share] = (await client.heldShares(blocked.address)).shares;
    await client.claimHeld({ wallet: blocked, announcement: paid.announcement, to: await otherAccount22(w, blocked.address, share?.mint ?? blocked.address) });
    expect((await client.plan.reclaim({ worker: announcer })).closed).toEqual([paid.announcement]);
  });
});
