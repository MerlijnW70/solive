import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { testSignature } from "@intent-engine/client/testing";
import { DEVNET_TEST_MINT, findAssociatedTokenAddress, IntentStatus, Kind, NATIVE_MINT } from "@intent-engine/core";
import {
  EVENT_IX_TAG,
  getIntentAttestedEventEncoder,
  getIntentCreatedEventEncoder,
  getIntentDecoder,
  getIntentEncoder,
  getJobClaimedEventEncoder,
  getLineLeftEventEncoder,
  getStakeMovedEventEncoder,
  getStoodByEventEncoder,
  splitFee,
} from "@intent-engine/core/internal";
import { type EngineTransaction, type Transport } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { tool } from "../src/agent/names.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { NOT_SENT } from "../src/flows.js";
import { EXIT_FAILED, EXIT_OK } from "../src/main.js";
import { LAMPORTS_PER_SOL } from "../src/wallet.js";
import { cli, FEE_BPS, h, NOW, transport, world } from "./harness.js";
import { approved } from "./approved.js";

type Json = Record<string, unknown>;

const STAKE = LAMPORTS_PER_SOL / 20n;
const ESCROWED = LAMPORTS_PER_SOL / 20n;
const tag = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);
const landed = (label: string, slot: bigint, emitted: Uint8Array[]): EngineTransaction => ({ signature: testSignature(label), slot, blockTime: NOW + slot, failed: false, emitted });

function preset(at: Address): void {
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
  const result = await client.callTool({ name: tool(name), arguments: args as Record<string, unknown> });
  expect(result.isError === true, JSON.stringify(result.structuredContent)).toBe(false);
  return result.structuredContent as Json;
}

const claimed = (intent: Address, worker: Address) => tag(getJobClaimedEventEncoder().encode({ intent, worker, until: NOW + 600n, stake: STAKE }));
const queued = (intent: Address, worker: Address) => tag(getStoodByEventEncoder().encode({ intent, worker, seq: 0, secs: 600, stake: STAKE }));
const left = (intent: Address, worker: Address) => tag(getLineLeftEventEncoder().encode({ intent, worker, seq: 0, refunded: STAKE }));
const moved = (intent: Address, worker: Address, to: Address, role: number) => tag(getStakeMovedEventEncoder().encode({ intent, worker, to, amount: STAKE, role }));

describe("wallet_history of claims taken from the line", () => {
  it("lists each claim, queue and leave with what became of its stake, released escrows included, when the hand-over is only in the escrow's history", async () => {
    const w = await world();
    h.files.clear();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    const spec = new Uint8Array(createHash("sha256").update("a job taken from the line").digest());
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: w.owner.address, specHash: spec, judgeFee: 0n } as const;
    const { intent: waiting } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
    const fresh = async (): Promise<Address> => (await generateKeyPairSigner()).address;
    const [released, direct, gone] = [await fresh(), await fresh(), await fresh()];
    let wallet = "" as Address;
    const escrows = new Map<Address, EngineTransaction[]>();
    let own: EngineTransaction[] = [];
    h.through = { ...transport, engineTransactions: async (_limit, of) => (of === wallet ? own : (escrows.get(of as Address) ?? [])) } satisfies Transport;
    const client = await connect();
    wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    const handover = landed("advance", 11n, [claimed(released, wallet)]);
    const release = landed("release", 12n, [moved(released, wallet, wallet, 0)]);
    escrows.set(released, [release, handover, landed("standby", 10n, [queued(released, wallet)])]);
    escrows.set(direct, [landed("direct-release", 15n, [moved(direct, wallet, wallet, 0)]), landed("direct-take", 14n, [claimed(direct, wallet)])]);
    own = [
      landed("direct-release", 15n, [moved(direct, wallet, wallet, 0)]),
      release,
      landed("standby", 10n, [queued(released, wallet)]),
      landed("waiting", 8n, [queued(waiting, wallet)]),
      landed("leave", 7n, [left(gone, wallet)]),
      landed("join", 6n, [queued(gone, wallet)]),
    ];
    const entry = (intent: Address, action: string, outcome: string, signature: string, slot: bigint) => ({ intent, action, stake: "0.05", stake_outcome: outcome, signature: testSignature(signature), at: String(NOW + slot) });
    const seen = await ok(client, "wallet_history");
    expect(seen["claims"]).toEqual([
      entry(direct, "claimed", "returned", "direct-take", 14n),
      entry(released, "claimed", "returned", "advance", 11n),
      entry(released, "queued", "returned", "standby", 10n),
      entry(waiting, "queued", "held", "waiting", 8n),
      entry(gone, "left", "returned", "leave", 7n),
      entry(gone, "queued", "returned", "join", 6n),
    ]);
  });
});

describe("wallet_receipt of a released job with a claim", () => {
  it("says the claim's stake went back to the paid worker and labels payee as its token account", async () => {
    await world();
    h.files.clear();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    const client = await connect();
    const payer = (await ok(client, "wallet_setup"))["address"] as Address;
    const job = await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: payer, spec_hash: "6a".repeat(32) }));
    const intent = job["intent"] as Address;
    const held = h.svm.getAccount(intent);
    if (!held.exists) {
      throw new Error("the escrow was not created");
    }
    const escrow = getIntentDecoder().decode(held.data);
    h.svm.setAccount({ ...held, data: Uint8Array.from(getIntentEncoder().encode({ ...escrow, status: IntentStatus.Filled })) });
    const created = getIntentCreatedEventEncoder().encode({ ...escrow, intent, receiver: escrow.owner, rentPayer: escrow.owner, flags: 0, bounty: 0, createFee: 0 });
    const worker = (await generateKeyPairSigner()).address;
    const payee = await findAssociatedTokenAddress({ owner: worker, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const { fee, net } = splitFee(ESCROWED, FEE_BPS);
    const attested = getIntentAttestedEventEncoder().encode({ intent, owner: payer, solver: payer, payee, attestor: payer, amountIn: ESCROWED, result: 1n, fee, net, filled: ESCROWED, remaining: 0n, partnerFee: 0n });
    h.engineLog = [
      { ...landed("released", 9n, [tag(attested), moved(intent, worker, worker, 0)]), blockTime: escrow.createdAt + 9n, tokens: [{ account: payee, mint: NATIVE_MINT, owner: worker }] },
      { ...landed("made", 1n, [tag(created)]), blockTime: null },
    ];
    const receipt = await ok(client, "wallet_receipt", { nonce: job["nonce"] });
    expect(receipt).toMatchObject({ released: true, paid_to: worker, payee, stake_returned: "0.05", stake_returned_to: worker });
    const described = (await client.listTools()).tools.find(({ name }) => name === tool("wallet_receipt"));
    expect(JSON.stringify(described?.outputSchema)).toContain("a token account, not a wallet");
  });
});

describe("advance-nonce", () => {
  it("previews without --yes and sends only with it", async () => {
    const w = await world();
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: w.owner.address, specHash: new Uint8Array(32).fill(7), judgeFee: 0n } as const;
    const create = (nonce: bigint) => createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce, expiresAt: NOW + 3_600n });
    await create(3n);
    const preview = await cli(["advance-nonce", "--keypair", "owner.json", "--base", "300"], { "owner.json": w.owner });
    expect([preview.code, preview.err]).toEqual([EXIT_OK, ""]);
    expect(preview.json()).toMatchObject({ owner: w.owner.address, base: "300", sent: false, next: NOT_SENT });
    expect(preview.json()["signature"]).toBeUndefined();
    await create(4n);
    const sent = await cli(["advance-nonce", "--keypair", "owner.json", "--base", "300", "--yes"], { "owner.json": w.owner });
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    expect(sent.json()).toMatchObject({ sent: true, signature: expect.any(String) });
    await expect(create(5n)).rejects.toThrow();
    expect((await cli(["advance-nonce", "--keypair", "owner.json", "--base", "1"], { "owner.json": w.owner })).code).toBe(EXIT_FAILED);
  });
});
