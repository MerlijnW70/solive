import { describe, expect, it } from "vitest";
import { splitFee } from "@intent-engine/core/internal";
import { connect } from "../src/index.js";
import { heldWorld, PAY, SHARES } from "./held.js";
import { FEE_BPS } from "./svm.js";
import { ata22, otherAccount22 } from "./token22.js";
import { LOCAL } from "./work.js";

describe("held shares and withheld fees in receipts and records", () => {
  it("reads a held share as paid to its co-author but not received until the claim, in the receipt, the work record and the reputation", async () => {
    const { w, client, mint, blocked, release, memoRequired } = await heldWorld();
    const paid = await release(memoRequired);
    const simple = await connect({ url: LOCAL, signer: blocked, transport: w.chain.transport });
    const before = await simple.receipt({ escrow: paid.intent });
    const blockedAta = await ata22(blocked.address, mint);
    expect(before.payees).toContain(blocked.address);
    expect(before.held).toEqual([
      { wallet: blocked.address, account: blockedAta, announcement: paid.announcement, index: 1, amount: SHARES[1], received: false, claimedTo: null, claim: null },
    ]);
    expect(before.summary).toContain(`held in the escrow until it claims them`);
    const waiting = await client.reputation(blocked.address);
    expect(waiting.records[0]).toMatchObject({ outcome: "paid", role: "co-author", earned: SHARES[1], held: [{ index: 1, amount: SHARES[1], received: false }] });
    expect(waiting.held).toEqual([{ mint, amount: SHARES[1] }]);
    const other = await otherAccount22(w, blocked.address, mint);
    const signature = await client.claimHeld({ wallet: blocked, announcement: paid.announcement, to: other });
    const after = await simple.receipt({ escrow: paid.intent });
    expect(after.held).toEqual([
      { wallet: blocked.address, account: blockedAta, announcement: paid.announcement, index: 1, amount: SHARES[1], received: true, claimedTo: other, claim: signature },
    ]);
    const received = await client.reputation(blocked.address);
    expect(received.records[0]).toMatchObject({ earned: SHARES[1], held: [{ received: true, claimedTo: other }] });
    expect(received.held).toEqual([]);
  });

  it("names nothing held for a co-author whose account took its share", async () => {
    const { w, client, announcer, release, memoRequired } = await heldWorld();
    const paid = await release(memoRequired);
    const rep = await client.reputation(announcer.address);
    expect(rep.records[0]).toMatchObject({ outcome: "paid", earned: SHARES[0] });
    expect(rep.records[0]?.held).toBeUndefined();
    expect(rep.held).toEqual([]);
    const simple = await connect({ url: LOCAL, signer: announcer, transport: w.chain.transport });
    expect((await simple.receipt({ escrow: paid.intent })).withheld).toEqual([]);
  });

  it("reports a protocol fee its account could not take as withheld, like the other withheld fees", async () => {
    const { w, release, treasuryMemos, mint, announcer } = await heldWorld();
    await treasuryMemos();
    const paid = await release();
    const simple = await connect({ url: LOCAL, signer: announcer, transport: w.chain.transport });
    const receipt = await simple.receipt({ escrow: paid.intent });
    expect(receipt.withheld).toEqual([{ role: "protocol", payee: w.feeRecipient.address, account: await ata22(w.feeRecipient.address, mint), amount: splitFee(PAY, FEE_BPS).fee }]);
    expect(receipt.held).toEqual([]);
    expect(receipt.summary).toContain("the protocol fee of");
  });
});
