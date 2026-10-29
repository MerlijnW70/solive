import { type Address, getBase58Decoder } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import { ACCOUNT_LAYOUTS } from "@intent-engine/core/internal";
import type { Transport } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { svmTransport } from "@intent-engine/client/svm";
import { releaseStanding } from "../src/agent/wallet/standing.js";
import { connect, ok, preset } from "./agent-wallet-kit.js";
import { announced, keyed } from "./announce.js";
import { approved } from "./approved.js";
import { DOMAIN, h, transport, world } from "./harness.js";

const WORK = "f1".repeat(32);
const url = (name: string) => "https://" + "example.org/" + name;

const VERSION_AT = 8 + (ACCOUNT_LAYOUTS.find((layout) => layout.name === "announcement")?.versionAt ?? 0);

describe("the standing of a paid announcement", () => {
  let through: Transport;

  beforeEach(async () => {
    await world();
    through = svmTransport(h.svm, { genesisHash: getBase58Decoder().decode(DOMAIN) });
    h.through = through;
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
  });

  async function paid() {
    const client = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    h.watched.push(wallet);
    const judge = await keyed();
    const escrow = await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: judge.address, spec_hash: "5c".repeat(32) }));
    const intent = escrow["intent"] as Address;
    const earlier = await ok(client, "wallet_deliver", { intent, sha256: WORK, url: url("mine.tar"), send: true });
    const worker = await keyed();
    const later = await announced(intent, worker, WORK, url("later.tar"), through);
    const after = await announced(intent, await keyed(), "f2".repeat(32), url("after.tar"), through);
    await createClient({ url: "http://cluster", transport: through }).settleProof({
      judge,
      payer: judge,
      intent: { owner: wallet, nonce: BigInt(escrow["nonce"] as string) },
      announcement: later.announcement,
      opening: { sha256: WORK, salt: later.salt },
      result: 1n,
    });
    const paidOne = { announcement: later.announcement, seq: later.seq, worker: worker.address };
    return { client, wallet, intent, earlier, after, paidOne };
  }

  it("lists only the announcements before the paid one, and the refutation once one is made", async () => {
    const { client, wallet, intent, earlier, paidOne } = await paid();
    const before = await releaseStanding(through, intent, paidOne);
    expect(before.passed_over).toStrictEqual([{ announcement: earlier["announcement"], seq: 1n, worker: wallet }]);
    expect(before.refutations).toStrictEqual([]);
    expect(before).not.toHaveProperty("refuted_by");
    expect(before).not.toHaveProperty("unreadable");
    const refuted = await ok(client, "wallet_refute", { earlier: earlier["announcement"], paid: paidOne.announcement, url: url("mine.tar"), send: true });
    const standing = await releaseStanding(through, intent, paidOne);
    expect(standing.refutations).toMatchObject([{ refutation: refuted["refutation"], earlier: earlier["announcement"], earlier_seq: 1n, earlier_worker: wallet }]);
    expect(standing.refuted_by).toBe(refuted["refutation"]);
  });

  it("calls the standing complete only when the record was found, the history read in full and nothing was unreadable", async () => {
    const { intent, after, paidOne } = await paid();
    const complete = await releaseStanding(through, intent, paidOne);
    expect(complete).not.toHaveProperty("standing_complete");
    const cut = await releaseStanding({ ...through, firstAvailableSlot: async () => 5n }, intent, paidOne);
    expect(cut.refutations).toStrictEqual([]);
    expect(cut.standing_complete).toBe(false);
    const lost = await releaseStanding(transport, intent, paidOne);
    expect(lost).not.toHaveProperty("refutations");
    expect(lost.standing_complete).toBe(false);
    const held = h.svm.getAccount(after.announcement);
    if (!held.exists) {
      throw new Error("the announcement was not made");
    }
    const data = new Uint8Array(held.data);
    data[VERSION_AT] = (data[VERSION_AT] ?? 0) + 1;
    h.svm.setAccount({ ...held, data });
    const unreadable = await releaseStanding(through, intent, paidOne);
    expect(unreadable.standing_complete).toBe(false);
    expect(unreadable.unreadable).toMatchObject([{ account: after.announcement }]);
  });
});
