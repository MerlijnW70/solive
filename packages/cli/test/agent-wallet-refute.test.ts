import type { Address } from "@solana/kit";
import type { Client } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it } from "vitest";
import { createClient } from "@intent-engine/client/node";
import { loadAnnouncement, refutationsOf } from "@intent-engine/client/internal";
import { NOT_ANNOUNCEMENT } from "../src/agent/wallet.js";
import { call, fresh, ok } from "./agent-wallet-kit.js";
import { announced, keyed } from "./announce.js";
import { h, transport } from "./harness.js";

const WORK = "f1".repeat(32);
const url = (name: string) => "https://" + "example.org/" + name;

describe("the wallet server's refutations and reclaims", () => {
  let client: Client;

  beforeEach(async () => {
    client = await fresh();
  });

  it("refutes a release that paid a later announcement of its work, then reclaims its announcement's rent", async () => {
    const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    h.watched.push(wallet);
    const judge = await keyed();
    const escrow = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: judge.address, spec_hash: "5c".repeat(32), send: true });
    const intent = escrow["intent"] as Address;
    const earlier = await ok(client, "wallet_deliver", { intent, sha256: WORK, url: url("mine.tar"), send: true });
    expect((await call(client, "wallet_reclaim")).value).toMatchObject({ code: "NothingToReclaim" });
    const later = await announced(intent, await keyed(), WORK, url("later.tar"));
    await createClient({ url: "http://cluster", transport }).settleProof({
      judge,
      payer: judge,
      intent: { owner: wallet, nonce: BigInt(escrow["nonce"] as string) },
      announcement: later.announcement,
      opening: { sha256: WORK, salt: later.salt },
      result: 1n,
    });
    const refuting = { earlier: earlier["announcement"], paid: later.announcement, url: url("mine.tar") };
    expect((await call(client, "wallet_refute", { ...refuting, paid: wallet })).value).toMatchObject({ code: "NotRefutable", hint: `${wallet} ${NOT_ANNOUNCEMENT}` });
    expect((await call(client, "wallet_refute", { ...refuting, url: url("other.tar") })).value).toMatchObject({ code: "NotRefutable" });
    expect((await call(client, "wallet_refute", { ...refuting, earlier: later.announcement, paid: earlier["announcement"] })).value).toMatchObject({ code: "NotRefutable" });
    const preview = await ok(client, "wallet_refute", refuting);
    expect(preview).toMatchObject({ earlier: earlier["announcement"], paid: later.announcement, intent, sha256: WORK, sent: false });
    expect(await refutationsOf(transport, later.announcement)).toEqual([]);
    const sent = await ok(client, "wallet_refute", { ...refuting, send: true });
    expect(sent).toMatchObject({ sent: true, refutation: preview["refutation"], signature: expect.any(String) });
    expect((await refutationsOf(transport, later.announcement)).map(({ earlierAnnouncement }) => earlierAnnouncement)).toEqual([earlier["announcement"]]);
    const shown = await ok(client, "wallet_reclaim");
    expect(shown).toMatchObject({ closing: [earlier["announcement"]], closable: 1, sent: false });
    expect(await loadAnnouncement(transport, earlier["announcement"] as Address)).not.toBeNull();
    expect(await ok(client, "wallet_reclaim", { send: true })).toMatchObject({ closing: [earlier["announcement"]], sent: true, next: "closed" });
    expect(await loadAnnouncement(transport, earlier["announcement"] as Address)).toBeNull();
  });
});
