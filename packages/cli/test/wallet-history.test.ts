import { type Address, generateKeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, findAssociatedTokenAddress, Kind, NATIVE_MINT } from "@intent-engine/core";
import {
  EVENT_IX_TAG,
  getIntentAttestedEventEncoder,
  getIntentCancelledEventEncoder,
  getIntentCreatedEventEncoder,
  getIntentFilledEventEncoder,
} from "@intent-engine/core/internal";
import type { EngineTransaction, TokenHolding } from "@intent-engine/client";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { EXIT_OK } from "../src/main.js";
import { cli, h, world } from "./harness.js";
import { approved } from "./approved.js";

type Json = Record<string, unknown>;
const SOL = 1_000_000_000n;
const tag = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);
const landed = (signature: string, slot: bigint, emitted: Uint8Array[], blockTime: bigint | null = null, tokens: TokenHolding[] = []): EngineTransaction => ({
  signature,
  slot,
  blockTime,
  failed: false,
  emitted,
  memos: [],
  tokens,
});

function preset(at: Address): void {
  if (h.svm.getAccount(at).exists) {
    return;
  }
  const space = BigInt(getMintSize());
  h.svm.setAccount({
    address: at,
    data: Uint8Array.from(getMintEncoder().encode({ mintAuthority: none(), supply: 0n, decimals: 9, isInitialized: true, freezeAuthority: none() })),
    executable: false,
    lamports: lamports(h.svm.minimumBalanceForRentExemption(space)),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space,
  });
}

async function connect(): Promise<Client> {
  h.served.length = 0;
  const started = await cli(["mcp", "--url", "devnet", "--wallet"], {});
  expect([started.code, started.err]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
  const [near, far] = InMemoryTransport.createLinkedPair();
  await h.served[0]?.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const result = await client.callTool({ name: `solive_${name}`, arguments: args as Record<string, unknown> });
  expect(result.isError === true, JSON.stringify(result.structuredContent)).toBe(false);
  return result.structuredContent as Json;
}

describe("solive_wallet_history", () => {
  it("lists the wallet's intents newest first with how each ended, closed ones included", async () => {
    await world();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    const client = await connect();
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const worker = (await generateKeyPairSigner()).address;
    const payee = await findAssociatedTokenAddress({ owner: worker, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const intents: Address[] = [];
    for (let i = 0; i < 4; i += 1) {
      intents.push((await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner })))["intent"] as Address);
    }
    await ok(client, "wallet_cancel", { nonce: "1", send: true });
    expect(h.svm.getAccount(intents[1] ?? owner).exists).toBe(false);

    const created = (intent: Address, nonce: bigint, kind: number) =>
      tag(
        getIntentCreatedEventEncoder().encode({
          intent,
          owner,
          nonce,
          kind,
          inputMint: NATIVE_MINT,
          outputMint: DEVNET_TEST_MINT,
          receiver: owner,
          escrowed: SOL / 20n,
          expiresAt: 0n,
          rentPayer: owner,
          flags: 0,
          bounty: 0,
          createFee: 0,
        }),
      );
    const [released = owner, cancelled = owner, open = owner, filled = owner] = intents;
    h.engineLog = [
      landed("fill", 9n, [
        tag(
          getIntentFilledEventEncoder().encode({
            intent: filled,
            owner,
            solver: worker,
            receiver: owner,
            solverInput: worker,
            amountIn: SOL / 20n,
            delivered: 6_375_000_000n,
            required: 5n * SOL,
            fee: 0n,
            net: SOL / 20n,
            filled: SOL / 20n,
            remaining: 0n,
            partnerFee: 0n,
          }),
        ),
      ], 1_700_000_900n),
      landed("cancel", 8n, [tag(getIntentCancelledEventEncoder().encode({ intent: cancelled, owner, refunded: SOL / 20n }))]),
      landed("release", 7n, [
        tag(
          getIntentAttestedEventEncoder().encode({
            intent: released,
            owner,
            solver: owner,
            payee,
            attestor: owner,
            amountIn: SOL / 20n,
            result: 1n,
            fee: 0n,
            net: SOL / 20n,
            filled: SOL / 20n,
            remaining: 0n,
            partnerFee: 0n,
          }),
        ),
      ], null, [{ account: payee, mint: NATIVE_MINT, owner: worker }]),
      landed("create-3", 4n, [created(filled, 3n, Kind.SwapExactIn)]),
      landed("create-2", 3n, [created(open, 2n, Kind.AttestedResult)]),
      landed("create-1", 2n, [created(cancelled, 1n, Kind.AttestedResult)]),
      landed("create-0", 1n, [created(released, 0n, Kind.AttestedResult)]),
    ];

    const shown = await ok(client, "wallet_history");
    expect(shown).toEqual({
      wallet: owner,
      more: false,
      activity: [
        { nonce: "3", intent: filled, kind: "SwapExactIn", outcome: "filled", sold: "0.05", sell_token: "SOL", received: "6.375", receive_token: "TEST", paid_to: null, payee: null, signature: "fill", at: "1700000900" },
        { nonce: "2", intent: open, kind: "AttestedResult", outcome: "open", sold: "0.05", sell_token: "SOL", received: null, receive_token: null, paid_to: null, payee: null, signature: null, at: null },
        { nonce: "1", intent: cancelled, kind: "AttestedResult", outcome: "cancelled", sold: "0.05", sell_token: "SOL", received: null, receive_token: null, paid_to: null, payee: null, signature: "cancel", at: null },
        { nonce: "0", intent: released, kind: "AttestedResult", outcome: "released", sold: "0.05", sell_token: "SOL", received: null, receive_token: null, paid_to: worker, payee, signature: "release", at: null },
      ],
      work: [],
      claims: [],
      more_work: false,
    });
    expect(payee).not.toBe(worker);
    const newest = await ok(client, "wallet_history", { limit: 2 });
    expect((newest["activity"] as Json[]).map((a) => a["nonce"])).toEqual(["3", "2"]);
    expect(newest["more"]).toBe(true);
  });
});
