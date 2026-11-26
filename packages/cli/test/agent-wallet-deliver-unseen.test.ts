import { type Address, generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { boundMembers } from "@intent-engine/client/internal";
import { announcedUnseen } from "../src/agent/wallet/delivery.js";
import { connect, fresh, ok } from "./agent-wallet-kit.js";
import { h, transport } from "./harness.js";
import { approved } from "./approved.js";

describe("the wallet server's deliver when the node does not show the landed announcement yet", () => {
  it("still reports the send, says the seq is unknown and names where to look, instead of leaving it out silently", async () => {
    await fresh();
    const hidden = new Set<Address>();
    const inner = boundMembers(transport);
    h.through = {
      ...inner,
      getAccount: async (address) => (hidden.has(address) ? null : inner.getAccount(address)),
      getAccounts: async (addresses) => Promise.all(addresses.map((address) => (hidden.has(address) ? null : inner.getAccount(address)))),
    };
    const client = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    await ok(client, "wallet_setup");
    const judge = (await generateKeyPairSigner()).address;
    const escrow = await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: judge, spec_hash: "5c".repeat(32) }));
    const delivery = { intent: escrow["intent"] as Address, sha256: "e7".repeat(32), url: "https://" + "example.org/work.tar" };
    const preview = await ok(client, "wallet_deliver", delivery);
    hidden.add(preview["announcement"] as Address);
    const sent = await ok(client, "wallet_deliver", await approved(client, "wallet_deliver", { ...delivery, send: true }));
    expect(sent).toMatchObject({ sent: true, signature: expect.any(String) });
    expect(sent["seq"]).toBeUndefined();
    expect(sent["next"]).toBe(announcedUnseen(preview["announcement"] as Address, sent["signature"] as string));
  });
});
