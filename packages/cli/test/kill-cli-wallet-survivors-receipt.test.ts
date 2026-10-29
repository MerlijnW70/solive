import { type Address, generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { findIntentPda } from "@intent-engine/core/internal";
import { DEVNET_TEST_MINT, formatAmount, NATIVE_MINT } from "@intent-engine/core";
import { defaultWallet } from "../src/wallet.js";
import { escrowReceipt, heldForYou, heldReturnedLine, paidOther, RECEIPT_PARTIAL } from "../src/agent/wallet/receipt.js";
import { RECLAIM_MORE } from "../src/agent/wallet/refute.js";
import { call, connect, ok, preset } from "./agent-wallet-kit.js";
import { keyed } from "./announce.js";
import { approved } from "./approved.js";
import { funded, h, HOME, NOW, setNow, transport, world } from "./harness.js";
import { HELD_SHARE } from "./held-kit.js";
import { attestedEvent, heldWorld, landed, movedEvent, unreadFirst } from "./kill-cli-wallet-survivors-kit.js";

const useKey = (address: Address): void => {
  h.files.set(defaultWallet(HOME), JSON.stringify(Array.from(h.keypairs.get(address) ?? [])));
};

describe("the receipt of a split release that held a share", () => {
  it("names the returned share alone when nothing came before it, and no line at all for a release that returned nothing", async () => {
    const { client, made, wallet, close } = await heldWorld();
    const receipt = await ok(client, "wallet_receipt", { owner: made.owner.address, nonce: String(made.nonce) });
    expect(receipt["next"]).toBe(heldReturnedLine(formatAmount(HELD_SHARE, 6), wallet, made.owner.address, close));
    const waiting = await heldWorld(false);
    const open = await ok(waiting.client, "get_receipt", { owner: waiting.made.owner.address, nonce: String(waiting.made.nonce) });
    expect(open).not.toHaveProperty("next");
  });

  it("tells the co-author whose share is still held to claim it, after the note that the history is partial when there is one", async () => {
    const { client, through, made } = await heldWorld(false);
    const amount = formatAmount(HELD_SHARE, 6);
    const args = { owner: made.owner.address, nonce: String(made.nonce) };
    expect((await ok(client, "wallet_receipt", args))["next"]).toBe(heldForYou(amount));
    h.through = unreadFirst(through, made.intent);
    const partial = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    expect((await ok(partial, "wallet_receipt", args))["next"]).toBe(`${RECEIPT_PARTIAL}; ${heldForYou(amount)}`);
    const stranger = await funded();
    useKey(stranger.address);
    const seen = await ok(partial, "wallet_receipt", args);
    expect(seen["paid_this_wallet"]).toBe(false);
    expect(seen["next"]).toBe(`${paidOther(seen["paid_wallets"] as Address[], stranger.address)}; ${RECEIPT_PARTIAL}`);
  });

  it("says for each of several escrows whether it was released and whom it paid, in the order given", async () => {
    const { client, made, wallet } = await heldWorld(false);
    const mine = { sell: "SOL", amount: "0.05", attestor: wallet, min_result: "1", max_result: "1" };
    const paid = await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", mine));
    const unpaid = await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", mine));
    const payee = (await keyed()).address;
    await ok(client, "wallet_attest", await approved(client, "wallet_attest", { owner: wallet, nonce: paid["nonce"], pay_to: payee }));
    const seen = await ok(client, "wallet_receipt", {
      owner: made.owner.address,
      nonce: String(made.nonce),
      also: [
        { owner: wallet, nonce: paid["nonce"] },
        { owner: wallet, nonce: unpaid["nonce"] },
      ],
    });
    const [split, attested, open] = seen["escrows"] as Record<string, unknown>[];
    expect(split).toMatchObject({ owner: made.owner.address, nonce: String(made.nonce), intent: made.intent, released: true, paid_this_wallet: true });
    expect(split).not.toHaveProperty("paid_to");
    expect(split?.["paid_wallets"]).toContain(wallet);
    expect(attested).toStrictEqual({ owner: wallet, nonce: paid["nonce"], intent: paid["intent"], released: true, paid_to: payee, paid_this_wallet: false });
    expect(open).toStrictEqual({ owner: wallet, nonce: unpaid["nonce"], intent: unpaid["intent"], released: false });
  });
});

describe("the stake a release gave back to the worker", () => {
  it("counts a stake moved at or after the release and not one moved before it", async () => {
    await world();
    preset(NATIVE_MINT);
    const [owner, worker, payee, other] = [(await generateKeyPairSigner()).address, (await generateKeyPairSigner()).address, (await generateKeyPairSigner()).address, (await generateKeyPairSigner()).address];
    const [intent] = await findIntentPda({ owner, nonce: 7n });
    const release = landed("r1", 10n, [attestedEvent(intent, owner, payee, 1_000n, 1n, 0n)], { tokens: [{ account: payee, mint: NATIVE_MINT, owner: worker }] });
    const returned = async (slot: bigint) => {
      h.engineLog = [landed("r2", slot, [movedEvent(intent, worker, worker, 0, 5_000n), movedEvent(intent, other, other, 0, 9_000n)]), release].sort((a, b) => Number(b.slot - a.slot));
      return escrowReceipt(transport, owner, 7n, undefined);
    };
    expect(await returned(9n)).not.toHaveProperty("stake_returned");
    expect(await returned(10n)).toMatchObject({ stake_returned: "0.000005", stake_returned_to: worker });
    expect(await returned(11n)).toMatchObject({ stake_returned: "0.000005", stake_returned_to: worker });
  });
});

describe("closing the announcements of an escrow that ended", () => {
  it("closes a batch at a time and says when more can close", async () => {
    const client = await (async () => {
      await world();
      h.files.clear();
      preset(NATIVE_MINT);
      preset(DEVNET_TEST_MINT);
      return connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    })();
    const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    h.watched.push(wallet);
    const judge = await keyed();
    const escrow = await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: judge.address, spec_hash: "5e".repeat(32), expires_in: 3_600 }));
    for (let at = 1; at <= 6; at++) {
      await ok(client, "wallet_deliver", { intent: escrow["intent"], sha256: at.toString(16).padStart(2, "0").repeat(32), url: "https://" + "example.org/work-" + at, send: true });
    }
    setNow(NOW + 3_600n + 60n);
    const first = await ok(client, "wallet_reclaim", { send: true });
    expect(first).toMatchObject({ closable: 6, sent: true, next: RECLAIM_MORE });
    expect((first["closing"] as unknown[]).length).toBe(5);
    expect(await ok(client, "wallet_reclaim", { send: true })).toMatchObject({ closable: 1, sent: true, next: "closed" });
    expect((await call(client, "wallet_reclaim")).value).toMatchObject({ code: "NothingToReclaim" });
  });
});
