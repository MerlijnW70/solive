import { createHash } from "node:crypto";
import { type Address, type KeyPairSigner, signBytes } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { deliveryBookAddress, saltMessage, sortMembers } from "@intent-engine/core/internal";
import type { Transport } from "@intent-engine/client";
import { bookCreated, DELIVER_CHANGED, FEE_AT_LANDING, SYNCED_CHANGED } from "../src/agent/wallet/delivery.js";
import { EXIT_OK } from "../src/main.js";
import { keyed } from "./announce.js";
import { cli, funded, h, transport, world } from "./harness.js";
import { call, escrowTo, feeOf, lamportsOf, ok, recipientOf, served, useWallet } from "./bound-books-kit.js";

const WORK = createHash("sha256").update("the bound work\n").digest("hex");
const WORK_URL = "https://" + "work.example.org/" + "b".repeat(32);
const ANNOUNCE_FEE = 2_000_000n;
const SIGNATURE_FEE = 5_000n;

describe("a wallet_deliver send bound to its preview", () => {
  let w: Awaited<ReturnType<typeof world>>;
  let worker: KeyPairSigner;
  let intent: Address;

  beforeEach(async () => {
    w = await world();
    worker = await funded();
    intent = await escrowTo(w.owner, (await funded()).address, w.inputMint, w.outputMint);
    useWallet(worker);
  });

  it("refuses a send after the announce fee rose, and sends nothing", async () => {
    const recipient = await feeOf(ANNOUNCE_FEE);
    const client = await served();
    const args = { intent, sha256: WORK, url: WORK_URL };
    const shown = await ok(client, "wallet_deliver", args);
    expect(shown["approval"]).toMatch(/^[0-9a-f]{16}$/);
    await feeOf(ANNOUNCE_FEE * 2n);
    const [workerBefore, recipientBefore, wires] = [lamportsOf(worker.address), lamportsOf(recipient), h.wires.length];
    const raised = await call(client, "wallet_deliver", { ...args, approval: shown["approval"], send: true });
    expect(raised).toEqual({ error: true, value: expect.objectContaining({ code: "ReleaseChanged", hint: DELIVER_CHANGED }) });
    const bare = await call(client, "wallet_deliver", { ...args, send: true });
    expect(bare.value).toMatchObject({ code: "ReleaseChanged", hint: DELIVER_CHANGED });
    expect(h.wires).toHaveLength(wires);
    expect(h.svm.getAccount(shown["announcement"] as Address).exists).toBe(false);
    expect([lamportsOf(worker.address), lamportsOf(recipient)]).toEqual([workerBefore, recipientBefore]);
    const again = await ok(client, "wallet_deliver", args);
    expect(again["approval"]).not.toBe(shown["approval"]);
    expect(again["summary"]).toContainEqual(expect.stringContaining("announce fee of 0.004 SOL"));
  }, 60_000);

  it("pays exactly the announce fee and book rent its preview showed when the send carries its approval", async () => {
    const recipient = await feeOf(ANNOUNCE_FEE);
    const client = await served();
    const args = { intent, sha256: WORK, url: WORK_URL };
    const shown = await ok(client, "wallet_deliver", args);
    const book = await deliveryBookAddress(intent);
    expect(h.svm.getAccount(book).exists).toBe(false);
    const rentLine = (shown["summary"] as string[]).find((line) => line.startsWith("Creates:")) ?? "";
    const [workerBefore, recipientBefore] = [lamportsOf(worker.address), lamportsOf(recipient)];
    const done = await ok(client, "wallet_deliver", { ...args, approval: shown["approval"], send: true });
    expect(done).toMatchObject({ sent: true, approval: shown["approval"], seq: "1" });
    const bookRent = lamportsOf(book);
    const announcementRent = lamportsOf(shown["announcement"] as Address);
    expect(rentLine).toBe(bookCreated(bookRent, "this wallet"));
    expect(lamportsOf(recipient) - recipientBefore).toBe(ANNOUNCE_FEE);
    expect(workerBefore - lamportsOf(worker.address)).toBe(ANNOUNCE_FEE + bookRent + announcementRent + SIGNATURE_FEE);

    const second = { ...args, sha256: "c4".repeat(32) };
    const next = await ok(client, "wallet_deliver", second);
    expect((next["summary"] as string[]).some((line) => line.startsWith("Creates:"))).toBe(false);
    expect(next["approval"]).not.toBe(shown["approval"]);
    const before = lamportsOf(recipient);
    expect(await ok(client, "wallet_deliver", { ...second, approval: next["approval"], send: true })).toMatchObject({ sent: true, seq: "2" });
    expect(lamportsOf(recipient) - before).toBe(ANNOUNCE_FEE);
  }, 60_000);

  it("binds a send to the delivery book's rent: once another worker made the book, the old approval is refused", async () => {
    const client = await served();
    const args = { intent, sha256: WORK, url: WORK_URL };
    const shown = await ok(client, "wallet_deliver", args);
    useWallet(await funded());
    const other = await served();
    const first = await ok(other, "wallet_deliver", { ...args, sha256: "d7".repeat(32) });
    await ok(other, "wallet_deliver", { ...args, sha256: "d7".repeat(32), approval: first["approval"], send: true });
    useWallet(worker);
    const again = await served();
    expect((await call(again, "wallet_deliver", { ...args, approval: shown["approval"], send: true })).value).toMatchObject({ code: "ReleaseChanged", hint: DELIVER_CHANGED });
    expect(h.svm.getAccount(shown["announcement"] as Address).exists).toBe(false);
  }, 60_000);

  it("shows the book rent in prepare_deliver and warns that the fee is charged as the config holds it when the transaction lands", async () => {
    const client = await served();
    const salt = Buffer.from(await signBytes(worker.keyPair.privateKey, saltMessage(intent, WORK))).toString("hex");
    const prepared = await ok(client, "prepare_deliver", { worker: worker.address, intent, sha256: WORK, url: WORK_URL, salt_signature: salt });
    expect((prepared["summary"] as string[]).some((line) => line.startsWith("Creates: the escrow's delivery book"))).toBe(true);
    expect(prepared["warnings"]).toContain(FEE_AT_LANDING);
  }, 60_000);
  it("refuses a send after the fee recipient changed, though the fee stayed the same", async () => {
    await feeOf(ANNOUNCE_FEE);
    const client = await served();
    const args = { intent, sha256: WORK, url: WORK_URL };
    const shown = await ok(client, "wallet_deliver", args);
    const other = await funded();
    const held = lamportsOf(other.address);
    await recipientOf(other.address);
    const refused = await call(client, "wallet_deliver", { ...args, approval: shown["approval"], send: true });
    expect(refused.value).toMatchObject({ code: "ReleaseChanged", hint: DELIVER_CHANGED });
    expect(lamportsOf(other.address)).toBe(held);
    expect(h.svm.getAccount(shown["announcement"] as Address).exists).toBe(false);
  }, 60_000);

  it("refuses the announcement when the announce fee rose while its committee key sync landed, after sending only the sync", async () => {
    const members = sortMembers([(await keyed()).address, (await keyed()).address]);
    const payer = await funded();
    const created = await cli(["committee", "create", "--url", "devnet", "--keypair", "payer.json", "--members", members.join(","), "--threshold", "2", "--fee-wallet", payer.address, "--yes"], { "payer.json": payer });
    expect([created.code, created.err]).toEqual([EXIT_OK, ""]);
    const teamed = await escrowTo(w.owner, created.json()["committee"] as Address, w.inputMint, w.outputMint, 1n);
    const args = { intent: teamed, sha256: WORK, url: WORK_URL };
    const shown = await ok(await served(), "wallet_deliver", args);
    expect(shown).toMatchObject({ sent: false, sync_first: true });
    const live: Transport = transport;
    let sends = 0;
    h.through = {
      ...live,
      sendWire: async (wire, latest) => {
        const signature = await live.sendWire(wire, latest);
        sends += 1;
        if (sends === 1) {
          await feeOf(ANNOUNCE_FEE);
        }
        return signature;
      },
    };
    const refused = await call(await served(), "wallet_deliver", { ...args, approval: shown["approval"], send: true });
    expect(refused.value).toMatchObject({ code: "ReleaseChanged", hint: SYNCED_CHANGED });
    expect(sends).toBe(1);
    expect(h.svm.getAccount(shown["announcement"] as Address).exists).toBe(false);
  }, 60_000);
});
