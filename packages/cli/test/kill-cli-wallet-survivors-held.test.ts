import { type Address, getBase58Decoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import { svmTransport } from "@intent-engine/client/svm";
import { call, connect, ok, preset } from "./agent-wallet-kit.js";
import { heldRelease, keyOf, otherAccount22 } from "./held-kit.js";
import { DOMAIN, h, world } from "./harness.js";

describe("the held share a wallet may claim", () => {
  it("points at the one share to preview, refuses a send with no share named, honours the share index and names the account it pays into", async () => {
    await world();
    h.through = svmTransport(h.svm, { genesisHash: getBase58Decoder().decode(DOMAIN) });
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    const client = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    const made = await heldRelease(await keyOf(wallet), "7e".repeat(32), h.through);
    const listed = await ok(client, "wallet_claim_held");
    expect(listed["next"]).toBe(`pass announcement ${made.announcement} to preview the claim`);
    expect((await call(client, "wallet_claim_held", { send: true })).value).toMatchObject({
      code: "InvalidInput",
      issues: [{ path: "announcement", message: "give the announcement whose share to claim" }],
    });
    const to = await otherAccount22(made.payer, wallet, made.mint);
    const preview = await ok(client, "wallet_claim_held", { announcement: made.announcement, to });
    expect(preview["summary"]).toContain(`Pays into: ${to}, a token account of this wallet`);
    expect(await ok(client, "wallet_claim_held", { announcement: made.announcement, to, index: 1 })).toMatchObject({ claiming: { index: 1 } });
    expect((await call(client, "wallet_claim_held", { announcement: made.announcement, to, index: 5 })).error).toBe(true);
  });
});
