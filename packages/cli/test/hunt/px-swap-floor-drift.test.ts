import { type Address, getAddressDecoder } from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import { DEVNET_TEST_MINT as TEST_TOKEN, NATIVE_MINT, parseAmount } from "@intent-engine/core";
import { getIntentCreatedEventEncoder, getIntentFilledEventEncoder } from "@intent-engine/core/internal";
import { beforeEach, describe, expect, it } from "vitest";
import { testSignature } from "@intent-engine/client/testing";
import { LAMPORTS_PER_SOL } from "../../src/wallet.js";
import { h } from "../harness.js";
import { fresh, type Json, ok, tag } from "../agent-wallet-kit.js";

const filledAt = (intent: Address, amountIn: bigint, delivered: bigint) => ({
  signature: testSignature(`fill-${intent}`),
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
});

const keyOf = (k: number): Address => getAddressDecoder().decode(new Uint8Array(32).fill(k));

const honest = (k: number) => filledAt(keyOf(k), LAMPORTS_PER_SOL / 20n, 10n * LAMPORTS_PER_SOL);
const staged = (k: number) => filledAt(keyOf(k + 100), LAMPORTS_PER_SOL, LAMPORTS_PER_SOL);

describe("PX-2 the market swap's floor between preview and send", () => {
  let client: Client;

  beforeEach(async () => {
    client = await fresh();
  });

  it("PX-2 sends a swap whose floor is far below the min_receive its preview showed, without refusing", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    h.watched.push(owner);
    const swap = { sell: "SOL", buy: "TEST", amount: "0.05" };
    h.engineLog = [honest(2), honest(3), honest(4)];
    const preview = await ok(client, "wallet_swap", swap);
    expect(preview["sent"]).toBe(false);
    const shownFloor = parseAmount(preview["min_receive"] as string, 9);
    expect(shownFloor).toBeGreaterThan(9n * LAMPORTS_PER_SOL);
    h.engineLog = [staged(2), staged(3), staged(4), honest(2), honest(3), honest(4)];
    const outcome = await client.callTool({ name: "solive_wallet_swap", arguments: { ...swap, start_receive: preview["start_receive"], send: true } });
    const intents = (await ok(client, "wallet_intents"))["intents"] as Json[];
    const signed = intents.map((intent) => BigInt(intent["order"]["end_out"] as string));
    expect({ refused: outcome.isError === true, belowPreview: signed.filter((floor) => floor < shownFloor).map(String) }).toEqual({
      refused: outcome.isError === true,
      belowPreview: [],
    });
  });
});
