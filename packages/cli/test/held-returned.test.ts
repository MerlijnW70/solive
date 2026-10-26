import { type Address, getBase58Decoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, formatAmount, NATIVE_MINT } from "@intent-engine/core";
import { HELD_CLAIM_SECS, signMessageBytes } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { svmTransport } from "@intent-engine/client/svm";
import { connect, ok, preset } from "./agent-wallet-kit.js";
import { announced, keyed } from "./announce.js";
import { ata22, HELD_SHARE, HELD_WEIGHTS, heldEscrow, keyOf } from "./held-kit.js";
import { balance, DOMAIN, h, setNow, world } from "./harness.js";

const WORK = "7f".repeat(32);
const held = formatAmount(HELD_SHARE, 6);

describe("a held share the escrow's close returned to its owner", () => {
  it("shows the share as returned to the owner in the receipt, the reputation and the history of the co-author", async () => {
    await world();
    const through = svmTransport(h.svm, { genesisHash: getBase58Decoder().decode(DOMAIN) });
    h.through = through;
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    const client = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    const coauthor = await keyOf(wallet);
    const judge = await keyed();
    const made = await heldEscrow(coauthor, WORK, through, judge.address);
    await announced(made.intent, coauthor, WORK, undefined, through);
    const sdk = createClient({ url: "http://cluster", transport: through });
    const target = {
      intent: { owner: made.owner.address, nonce: made.nonce },
      announcement: made.announcement,
      opening: { sha256: WORK, salt: made.salt },
      result: 1n,
      recipients: [
        { wallet: made.announcer.address, weight: HELD_WEIGHTS[0] ?? 0 },
        { wallet, weight: HELD_WEIGHTS[1] ?? 0 },
      ],
    };
    const ballot = await sdk.splitBallot(target);
    const signatures = await Promise.all([made.announcer, coauthor].map(async (signer) => ({ wallet: signer.address, signature: await signMessageBytes(signer, ballot.message) })));
    await sdk.settleSplit({ ...target, judge, signatures });
    const escrow = await sdk.intent(made.intent);
    setNow((escrow?.intent.expiresAt ?? 0n) + HELD_CLAIM_SECS + 1n);
    const ownerAccount = await ata22(made.owner.address, made.mint);
    const before = balance(ownerAccount);
    const close = await sdk.close(await keyed(), made.intent);
    expect(balance(ownerAccount) - before).toBe(HELD_SHARE);
    const receipt = await ok(client, "wallet_receipt", { owner: made.owner.address, nonce: String(made.nonce) });
    expect(receipt).toMatchObject({ held: [{ wallet, index: 1, amount: held, state: "returned", received: false, claimed_to: null, returned_to: ownerAccount, close }] });
    expect(receipt["next"]).toContain(`${held} held for ${wallet} was never claimed and was returned to the escrow's owner ${made.owner.address} when the escrow closed in ${close}`);
    expect(receipt["next"]).not.toContain("wallet_claim_held");
    const reputation = await ok(client, "get_reputation", { worker: wallet });
    expect(reputation["held"]).toEqual([]);
    expect(reputation["records"]).toMatchObject([{ outcome: "paid", role: "co-author", returned: String(HELD_SHARE) }]);
    expect((reputation["records"] as Record<string, unknown>[])[0]?.["held"]).toBeUndefined();
    const history = await ok(client, "wallet_history");
    expect(history["work"]).toMatchObject([{ intent: made.intent, paid: true, amount: "0", returned: held, returned_in: close }]);
    expect((history["work"] as Record<string, unknown>[])[0]?.["held"]).toBeUndefined();
  });
});
