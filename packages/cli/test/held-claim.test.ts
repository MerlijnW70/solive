import { type Address, getBase58Decoder } from "@solana/kit";
import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, formatAmount, NATIVE_MINT } from "@intent-engine/core";
import type { Transport } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { svmTransport } from "@intent-engine/client/svm";
import { NOTHING_HELD as CLI_NOTHING_HELD } from "../src/announce-commands.js";
import { CLAIM_HELD_CHANGED, NOTHING_HELD } from "../src/agent/wallet.js";
import { EXIT_OK } from "../src/main.js";
import { call, connect, ok, preset } from "./agent-wallet-kit.js";
import { keyed } from "./announce.js";
import { ata22, HELD_SHARE, HELD_WEIGHTS, heldEscrow, heldRelease, keyOf, otherAccount22 } from "./held-kit.js";
import { willHold } from "../src/agent/wallet/split.js";
import { balance, cli, DOMAIN, h, NOW, setNow, world } from "./harness.js";

const WORK = "7e".repeat(32);
const held = formatAmount(HELD_SHARE, 6);

async function chain(): Promise<Transport> {
  await world();
  const through = svmTransport(h.svm, { genesisHash: getBase58Decoder().decode(DOMAIN) });
  h.through = through;
  return through;
}

async function served(): Promise<{ client: Client; through: Transport }> {
  const through = await chain();
  preset(NATIVE_MINT);
  preset(DEVNET_TEST_MINT);
  return { client: await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]), through };
}

describe("claiming a held split share", () => {
  it("lists the share the wallet server's wallet holds, previews its claim, refuses a send whose terms differ from the preview, and claims it", async () => {
    const { client, through } = await served();
    const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    expect(await ok(client, "wallet_claim_held")).toMatchObject({ shares: [], sent: false, next: NOTHING_HELD });
    const made = await heldRelease(await keyOf(wallet), WORK, through);
    const listed = await ok(client, "wallet_claim_held");
    expect(listed).toMatchObject({ complete: true, sent: false, shares: [{ intent: made.intent, announcement: made.announcement, index: 1, amount: held, account: made.blocked }] });
    const receipt = await ok(client, "wallet_receipt", { owner: made.owner.address, nonce: String(made.nonce) });
    expect(receipt).toMatchObject({ held: [{ wallet, account: made.blocked, index: 1, amount: held, received: false, claimed_to: null }] });
    expect(receipt["next"]).toContain("wallet_claim_held");
    expect((await call(client, "wallet_claim_held", { announcement: made.announcement })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "to" }] });
    const to = await otherAccount22(made.payer, wallet, made.mint);
    const elsewhere = await otherAccount22(made.payer, wallet, made.mint);
    const preview = await ok(client, "wallet_claim_held", { announcement: made.announcement, to });
    expect(preview).toMatchObject({ claiming: { announcement: made.announcement, index: 1, amount: held }, to, sent: false, approval: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect((await call(client, "wallet_claim_held", { announcement: made.announcement, to, send: true })).value).toMatchObject({ code: "ReleaseChanged", hint: CLAIM_HELD_CHANGED });
    expect((await call(client, "wallet_claim_held", { announcement: made.announcement, to: elsewhere, approval: preview["approval"], send: true })).value).toMatchObject({ code: "ReleaseChanged", hint: CLAIM_HELD_CHANGED });
    expect((await call(client, "wallet_claim_held", { announcement: made.announcement, to, approval: "0".repeat(16), send: true })).value).toMatchObject({ code: "ReleaseChanged" });
    expect(balance(to)).toBe(0n);
    const done = await ok(client, "wallet_claim_held", { announcement: made.announcement, to, approval: preview["approval"], send: true });
    expect(done).toMatchObject({ sent: true, signature: expect.any(String) });
    expect(balance(to)).toBe(HELD_SHARE);
    expect(balance(elsewhere)).toBe(0n);
    expect(await ok(client, "wallet_claim_held")).toMatchObject({ shares: [], next: NOTHING_HELD });
    expect((await call(client, "wallet_claim_held", { announcement: made.announcement, to, approval: preview["approval"], send: true })).value).toMatchObject({ code: "NoShareHeld" });
    expect(await ok(client, "wallet_receipt", { owner: made.owner.address, nonce: String(made.nonce) })).toMatchObject({ held: [{ wallet, received: true, claimed_to: to }] });
  });

  it("keeps a holding escrow out of crank work and explains SharesHeld until the share is claimed", async () => {
    const { client, through } = await served();
    const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    const made = await heldRelease(await keyOf(wallet), WORK, through);
    const shown = await ok(client, "get_intent", { owner: made.owner.address, nonce: String(made.nonce) });
    expect(shown["summary"]).toContainEqual(expect.stringContaining("Holds a co-author's split share"));
    setNow(NOW + 7_200n);
    const cranker = await keyed();
    const crankable = await ok(client, "find_crank_work", { cranker: cranker.address });
    expect((crankable["work"] as { intent: Address }[]).map(({ intent }) => intent)).not.toContain(made.intent);
    const refused = await call(client, "prepare_crank", { cranker: cranker.address, owner: made.owner.address, nonce: String(made.nonce) });
    expect(refused.value).toMatchObject({ code: "SharesHeld", hint: expect.stringContaining("still holds a co-author's split share") });
    const to = await otherAccount22(made.payer, wallet, made.mint);
    await createClient({ url: "http://cluster", transport: through }).claimHeld({ wallet: await keyOf(wallet), announcement: made.announcement, to });
    expect(await ok(client, "prepare_crank", { cranker: cranker.address, owner: made.owner.address, nonce: String(made.nonce) })).toMatchObject({ action: "close" });
  });

  it("lists, previews and claims a held share from the command line, and refuses to close the escrow before", async () => {
    const through = await chain();
    const coauthor = await keyed("coauthor.json");
    const made = await heldRelease(coauthor, WORK, through);
    const listed = await cli(["claim-held", "--keypair", "coauthor.json"], {});
    expect([listed.code, listed.err]).toEqual([EXIT_OK, ""]);
    expect(listed.json()).toMatchObject({ wallet: coauthor.address, shares: [{ intent: made.intent, announcement: made.announcement, index: 1, amount: held, account: made.blocked }] });
    setNow(NOW + 7_200n);
    const closing = await cli(["close", "--keypair", "coauthor.json", "--owner", made.owner.address, "--nonce", String(made.nonce)], {});
    expect(closing.code).not.toBe(EXIT_OK);
    expect(closing.err).toContain("claim-held");
    const to = await otherAccount22(made.payer, coauthor.address, made.mint);
    const preview = await cli(["claim-held", "--keypair", "coauthor.json", "--announcement", made.announcement, "--to", to], {});
    expect([preview.code, preview.err]).toEqual([EXIT_OK, ""]);
    expect(preview.json()).toMatchObject({ sent: false, announcement: made.announcement, index: 1, amount: held, to });
    expect(balance(to)).toBe(0n);
    const sent = await cli(["claim-held", "--keypair", "coauthor.json", "--announcement", made.announcement, "--to", to, "--yes"], {});
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    expect(sent.json()).toMatchObject({ sent: true });
    expect(balance(to)).toBe(HELD_SHARE);
    expect(balance(await ata22(coauthor.address, made.mint))).toBe(0n);
    expect((await cli(["claim-held", "--keypair", "coauthor.json"], {})).json()).toMatchObject({ shares: [], next: CLI_NOTHING_HELD });
    const usage = await cli(["claim-held", "--keypair", "coauthor.json", "--to", to], {});
    expect(usage.code).not.toBe(EXIT_OK);
  });

  it("warns in a split release's preview that a co-author's account cannot take its share, so the release will hold it", async () => {
    const { client, through } = await served();
    const judge = (await ok(client, "wallet_setup"))["address"] as Address;
    const coauthor = await keyed();
    const made = await heldEscrow(coauthor, WORK, through, judge);
    const recipients = [
      { wallet: made.announcer.address, weight: HELD_WEIGHTS[0] },
      { wallet: coauthor.address, weight: HELD_WEIGHTS[1] },
    ];
    const preview = await ok(client, "wallet_attest_split", { owner: made.owner.address, nonce: String(made.nonce), recipients, delivered_sha256: WORK });
    expect(preview["warnings"]).toContain(willHold([coauthor.address]));
  });
});
