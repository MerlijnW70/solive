import { createHash, generateKeyPairSync } from "node:crypto";
import { type Address, getAddressDecoder } from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import { DEVNET_TEST_MINT as TEST_TOKEN, NATIVE_MINT, parseAmount } from "@intent-engine/core";
import { getIntentCreatedEventEncoder, getIntentFilledEventEncoder, seal } from "@intent-engine/core/internal";
import { beforeEach, describe, expect, it } from "vitest";
import { ESCROW_CHANGED } from "../src/agent/wallet/escrow.js";
import { ORDER_CHANGED, orderPreviewNext } from "../src/agent/wallet/trade.js";
import { PREVIEW_APPROVAL_NEXT } from "../src/agent/wallet/guard.js";
import { LAMPORTS_PER_SOL } from "../src/wallet.js";
import { h } from "./harness.js";
import { call, fresh, type Json, ok, tag } from "./agent-wallet-kit.js";

const keyOf = (k: number): Address => getAddressDecoder().decode(new Uint8Array(32).fill(k));

const fill = (k: number, delivered: bigint) => {
  const intent = keyOf(k);
  const amountIn = LAMPORTS_PER_SOL / 20n;
  return {
    signature: `fill-${k}-${delivered}`,
    slot: 1n,
    blockTime: null,
    failed: false,
    emitted: [
      tag(
        getIntentCreatedEventEncoder().encode({
          intent,
          owner: intent,
          nonce: 0n,
          kind: 2,
          inputMint: NATIVE_MINT,
          outputMint: TEST_TOKEN,
          receiver: intent,
          escrowed: amountIn,
          expiresAt: 0n,
          rentPayer: intent,
          flags: 0,
          bounty: 0,
          createFee: 0,
        }),
      ),
      tag(
        getIntentFilledEventEncoder().encode({
          intent,
          owner: intent,
          solver: intent,
          receiver: intent,
          solverInput: intent,
          amountIn,
          delivered,
          required: 0n,
          fee: 0n,
          net: 0n,
          filled: amountIn,
          remaining: 0n,
          partnerFee: 0n,
        }),
      ),
    ],
  };
};

const market = (test: bigint) => [2, 3, 4].map((k) => fill(k, test * LAMPORTS_PER_SOL));

const SPEC = "# Bound job\n\nDeliver the report as one text file.\n";
const SPEC_URL = "https://" + "example.org/jobs/bound.sealed";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function address(): Address {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  return getAddressDecoder().decode(Uint8Array.from(Buffer.from(jwk.x ?? "", "base64url")));
}

const sealedTo = async (readers: Address[]) => seal(new TextEncoder().encode(SPEC), readers);

describe("a wallet send bound to what its preview showed", () => {
  let client: Client;
  let owner: Address;

  beforeEach(async () => {
    client = await fresh();
    owner = (await ok(client, "wallet_setup"))["address"] as Address;
    h.watched.push(owner);
  });

  const intents = async () => (await ok(client, "wallet_intents"))["intents"] as Json[];

  it("refuses a market swap whose default floor moved after its preview, then sends the floor and start a new preview showed", async () => {
    const swap = { sell: "SOL", buy: "TEST", amount: "0.05" };
    h.engineLog = market(10n);
    const preview = await ok(client, "wallet_swap", swap);
    expect(preview).toMatchObject({ sent: false, next: orderPreviewNext(true), approval: expect.stringMatching(/^[0-9a-f]{16}$/) });
    h.engineLog = market(11n);
    const moved = await call(client, "wallet_swap", { ...swap, start_receive: preview["start_receive"], approval: preview["approval"], send: true });
    expect(moved).toMatchObject({ error: true, value: { code: "ReleaseChanged", hint: ORDER_CHANGED } });
    h.engineLog = market(9n);
    expect((await call(client, "wallet_swap", { ...swap, start_receive: preview["start_receive"], approval: preview["approval"], send: true })).value).toMatchObject({ hint: ORDER_CHANGED });
    expect(await intents()).toEqual([]);
    const again = await ok(client, "wallet_swap", swap);
    expect(again["approval"]).not.toBe(preview["approval"]);
    const sent = await ok(client, "wallet_swap", { ...swap, start_receive: again["start_receive"], approval: again["approval"], send: true });
    expect(sent).toMatchObject({ sent: true, min_receive: again["min_receive"], start_receive: again["start_receive"], approval: again["approval"] });
    const [order] = (await intents()).map((intent) => intent["order"] as Json);
    expect(order).toMatchObject({ end_out: String(parseAmount(again["min_receive"] as string, 9)), start_out: String(parseAmount(again["start_receive"] as string, 9)) });
  });

  it("refuses a swap sent without the approval, or with terms its approval did not cover", async () => {
    const swap = { sell: "SOL", buy: "TEST", amount: "0.05", min_receive: "5", exact: true };
    const preview = await ok(client, "wallet_swap", swap);
    expect(preview["next"]).toBe(orderPreviewNext(false));
    for (const changed of [{ ...swap, send: true }, { ...swap, amount: "0.04", approval: preview["approval"], send: true }, { ...swap, min_receive: "4", approval: preview["approval"], send: true }]) {
      expect((await call(client, "wallet_swap", changed)).value).toMatchObject({ code: "ReleaseChanged", hint: ORDER_CHANGED });
    }
    expect(await intents()).toEqual([]);
    expect(await ok(client, "wallet_swap", { ...swap, approval: preview["approval"], send: true })).toMatchObject({ sent: true });
  });

  it("refuses a schedule whose default floor moved after its preview, and sends every order at the floor a new preview showed", async () => {
    const plan = { sell: "SOL", buy: "TEST", amount: "0.05", every: 600, times: 2 };
    h.engineLog = market(10n);
    const preview = await ok(client, "wallet_recurring", plan);
    expect(preview).toMatchObject({ next: orderPreviewNext(true), approval: expect.stringMatching(/^[0-9a-f]{16}$/) });
    h.engineLog = market(12n);
    const moved = await call(client, "wallet_recurring", { ...plan, start_receive: preview["start_receive"], approval: preview["approval"], send: true });
    expect(moved).toMatchObject({ error: true, value: { code: "ReleaseChanged", hint: ORDER_CHANGED } });
    expect(await intents()).toEqual([]);
    const again = await ok(client, "wallet_recurring", plan);
    expect(await ok(client, "wallet_recurring", { ...plan, start_receive: again["start_receive"], approval: again["approval"], send: true })).toMatchObject({ sent: true });
    const floors = (await intents()).map((intent) => (intent["order"] as Json)["end_out"]);
    expect(floors).toEqual([0, 1].map(() => String(parseAmount(again["min_receive"] as string, 9))));
  });

  it("refuses an escrow whose sealed spec was sealed to another worker after its preview, and keeps a re-seal to the same wallets", async () => {
    const [judge, worker, intruder] = [address(), address(), address()];
    const terms = { sell: "SOL", amount: "0.05", attestor: judge, spec_hash: sha(SPEC), spec_url: SPEC_URL, claim_stake: "0.01", claim_secs: 600 };
    h.specPages.set(SPEC_URL, await sealedTo([owner, judge, worker]));
    const preview = await ok(client, "wallet_escrow", terms);
    expect(preview).toMatchObject({ sent: false, next: PREVIEW_APPROVAL_NEXT, approval: expect.stringMatching(/^[0-9a-f]{16}$/) });
    h.specPages.set(SPEC_URL, await sealedTo([owner, judge, intruder]));
    const swapped = await call(client, "wallet_escrow", { ...terms, approval: preview["approval"], send: true });
    expect(swapped).toMatchObject({ error: true, value: { code: "ReleaseChanged", hint: ESCROW_CHANGED } });
    expect(await intents()).toEqual([]);
    h.specPages.set(SPEC_URL, await sealedTo([owner, judge, worker]));
    const made = await ok(client, "wallet_escrow", { ...terms, approval: preview["approval"], send: true });
    expect(made).toMatchObject({ sent: true, approval: preview["approval"] });
    const listed = await ok(client, "get_claims", { owner, nonce: made["nonce"] });
    expect(listed["claim_list"]?.["workers"]).toEqual([worker]);
  });

  it("refuses an escrow whose spec_url holds other bytes than at its preview", async () => {
    const terms = { sell: "SOL", amount: "0.05", attestor: owner, spec_hash: sha(SPEC), spec_url: SPEC_URL };
    h.specPages.set(SPEC_URL, new TextEncoder().encode(SPEC));
    const preview = await ok(client, "wallet_escrow", terms);
    h.specPages.set(SPEC_URL, new TextEncoder().encode(`${SPEC}Also deliver the answer.\n`));
    expect((await call(client, "wallet_escrow", { ...terms, approval: preview["approval"], send: true })).value).toMatchObject({ code: "ReleaseChanged", hint: ESCROW_CHANGED });
    expect((await call(client, "wallet_escrow", { ...terms, amount: "0.04", approval: preview["approval"], send: true })).value).toMatchObject({ hint: ESCROW_CHANGED });
    expect(await intents()).toEqual([]);
    h.specPages.set(SPEC_URL, new TextEncoder().encode(SPEC));
    expect(await ok(client, "wallet_escrow", { ...terms, approval: preview["approval"], send: true })).toMatchObject({ sent: true });
  });

  it("refuses a plan whose sealed spec was sealed to another worker after its preview, before escrowing any piece", async () => {
    const [judge, worker, intruder] = [address(), address(), address()];
    const plan = { sell: "SOL", attestor: judge, spec_hash: sha(SPEC), spec_url: SPEC_URL, claim_stake: "0.01", claim_secs: 600, pieces: [{ name: "a", amount: "0.01" }, { name: "b", amount: "0.01" }] };
    h.specPages.set(SPEC_URL, await sealedTo([owner, judge, worker]));
    const preview = await ok(client, "wallet_escrow_plan", plan);
    expect(preview).toMatchObject({ sent: false, next: PREVIEW_APPROVAL_NEXT, approval: expect.stringMatching(/^[0-9a-f]{16}$/) });
    h.specPages.set(SPEC_URL, await sealedTo([owner, judge, intruder]));
    expect((await call(client, "wallet_escrow_plan", { ...plan, approval: preview["approval"], send: true })).value).toMatchObject({ code: "ReleaseChanged", hint: ESCROW_CHANGED });
    expect(await intents()).toEqual([]);
    h.specPages.set(SPEC_URL, await sealedTo([owner, judge, worker]));
    const sent = await ok(client, "wallet_escrow_plan", { ...plan, approval: preview["approval"], send: true });
    for (const piece of sent["pieces"] as Json[]) {
      expect((await ok(client, "get_claims", { owner, nonce: piece["nonce"] }))["claim_list"]?.["workers"]).toEqual([worker]);
    }
  });
});
