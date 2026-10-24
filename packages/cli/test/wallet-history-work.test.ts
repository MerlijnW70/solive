import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner, getBase58Decoder, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import {
  DEVNET_TEST_MINT,
  EVENT_IX_TAG,
  findAssociatedTokenAddress,
  formatAmount,
  getClaimDroppedEventEncoder,
  getJobClaimedEventEncoder,
  getStakeMovedEventEncoder,
  Kind,
  NATIVE_MINT,
  splitFee,
} from "@intent-engine/core";
import { createClient, type EngineTransaction } from "@intent-engine/client";
import { svmTransport } from "@intent-engine/client/svm";
import { tool } from "../src/agent/names.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { EXIT_OK } from "../src/main.js";
import { defaultWallet, LAMPORTS_PER_SOL } from "../src/wallet.js";
import { announced, keyed } from "./announce.js";
import { cli, DOMAIN, FEE_BPS, funded, h, HOME, NOW, transport, world } from "./harness.js";

type Json = Record<string, unknown>;

const URL_OF_WORK = "https://" + "example.org/work-0b5c8e2f";
const ESCROWED = LAMPORTS_PER_SOL / 20n;

const tag = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);

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

async function sent(client: Client, name: string, args: object): Promise<Json> {
  const shown = await ok(client, name, args);
  return ok(client, name, { ...args, approval: shown["approval"], send: true });
}

function useKey(signer: KeyPairSigner): void {
  h.files.set(defaultWallet(HOME), JSON.stringify(Array.from(h.keypairs.get(signer.address) ?? [])));
}

describe("wallet_history of a worker paid for announced work", () => {
  async function served() {
    await world();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    h.through = svmTransport(h.svm, { genesisHash: getBase58Decoder().decode(DOMAIN) });
    const client = await connect();
    const payer = (await ok(client, "wallet_setup"))["address"] as Address;
    const payerKey = h.files.get(defaultWallet(HOME)) ?? "";
    const escrow = (hint: string) => ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: payer, spec_hash: hint.repeat(32), send: true });
    return { client, payer, payerKey, escrow };
  }

  it("lists the worker's announcements, paid with amount and release, and names the worker's wallet as paid_to on the payer's side", async () => {
    const { client, payer, payerKey, escrow } = await served();
    const paidJob = await escrow("61");
    const openJob = await escrow("62");
    const intent = paidJob["intent"] as Address;
    const other = openJob["intent"] as Address;
    const worker = await funded();
    useKey(worker);
    const work = "c4".repeat(32);
    const announced = await ok(client, "wallet_deliver", { intent, sha256: work, url: URL_OF_WORK, send: true });
    const unpaid = await ok(client, "wallet_deliver", { intent: other, sha256: "c5".repeat(32), url: URL_OF_WORK, send: true });

    h.files.set(defaultWallet(HOME), payerKey);
    const attested = await sent(client, "wallet_attest", { owner: payer, nonce: paidJob["nonce"], delivered_sha256: work });
    expect(attested).toMatchObject({ sent: true, pay_to: worker.address });
    const payee = await findAssociatedTokenAddress({ owner: worker.address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const { net } = splitFee(ESCROWED, FEE_BPS);

    useKey(worker);
    const seen = await ok(client, "wallet_history");
    expect(seen).toMatchObject({ wallet: worker.address, more: false, claims: [], more_work: false });
    expect(seen["work"]).toEqual([
      { intent: other, announcement: unpaid["announcement"], signature: unpaid["signature"], at: expect.any(String), paid: false, amount: null, token: null, release: null, unpaid_reason: "open", released_to: null },
      { intent, announcement: announced["announcement"], signature: announced["signature"], at: expect.any(String), paid: true, amount: formatAmount(net, 9), token: "SOL", release: attested["signature"], unpaid_reason: null, released_to: null },
    ]);
    const newest = await ok(client, "wallet_history", { limit: 1 });
    expect(newest["work"]).toEqual([(seen["work"] as Json[])[0]]);
    expect(newest["more_work"]).toBe(true);

    h.files.set(defaultWallet(HOME), payerKey);
    const books = await ok(client, "wallet_history");
    expect(books["work"]).toEqual([]);
    expect((books["activity"] as Json[]).find((entry) => entry["intent"] === intent)).toMatchObject({
      outcome: "released",
      paid_to: worker.address,
      payee,
      signature: attested["signature"],
    });
  });

  it("does not count a release of another worker's announcement as pay for this one", async () => {
    const { client, payer, payerKey, escrow } = await served();
    const job = await escrow("63");
    const intent = job["intent"] as Address;
    const worker = await funded();
    useKey(worker);
    const mine = await ok(client, "wallet_deliver", { intent, sha256: "d1".repeat(32), url: URL_OF_WORK, send: true });
    const rival = await keyed();
    await announced(intent, rival, "d2".repeat(32), URL_OF_WORK, h.through ?? undefined);
    h.files.set(defaultWallet(HOME), payerKey);
    expect(await sent(client, "wallet_attest", { owner: payer, nonce: job["nonce"], delivered_sha256: "d2".repeat(32) })).toMatchObject({ sent: true, pay_to: rival.address });
    useKey(worker);
    const seen = await ok(client, "wallet_history");
    expect(seen["work"]).toEqual([
      { intent, announcement: mine["announcement"], signature: mine["signature"], at: expect.any(String), paid: false, amount: null, token: null, release: null, unpaid_reason: "released_to_other", released_to: rival.address },
    ]);
  });
});

describe("wallet_history of the claims a wallet took or dropped", () => {
  it("lists each claim and drop newest first with what became of the stake", async () => {
    const w = await world();
    h.files.clear();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    const judge = (await generateKeyPairSigner()).address;
    const spec = new Uint8Array(createHash("sha256").update("a job whose claim the history shows").digest());
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge, specHash: spec, judgeFee: 0n } as const;
    const { intent: held } = await createClient({ url: "http://cluster", transport }).createIntent({
      signer: w.owner,
      params,
      inputMint: w.inputMint,
      outputMint: w.outputMint,
      nonce: 0n,
      expiresAt: NOW + 3_600n,
    });
    const opened = await cli(["claims", "open", "--keypair", "owner.json", "--nonce", "0", "--max-secs", "3600", "--stake", "0.05", "--yes"], { "owner.json": w.owner });
    expect([opened.code, opened.err]).toEqual([EXIT_OK, ""]);
    const client = await connect();
    const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    expect(await sent(client, "wallet_claim", { owner: w.owner.address, nonce: "0", action: "take", secs: 600 })).toMatchObject({ sent: true });

    const stake = LAMPORTS_PER_SOL / 20n;
    const fresh = async (): Promise<Address> => (await generateKeyPairSigner()).address;
    const returned = await fresh();
    const dropped = await fresh();
    const forfeited = await fresh();
    const lost = await fresh();
    const rival = await fresh();
    const claimed = (intent: Address, worker: Address) => tag(getJobClaimedEventEncoder().encode({ intent, worker, until: NOW + 600n, stake }));
    const moved = (intent: Address, to: Address, role: number) => tag(getStakeMovedEventEncoder().encode({ intent, worker: wallet, to, amount: stake, role }));
    const landed = (signature: string, slot: bigint, emitted: Uint8Array[]): EngineTransaction => ({ signature, slot, blockTime: NOW + slot, failed: false, emitted });
    h.engineLog = [
      landed("take-held", 20n, [claimed(held, wallet)]),
      landed("rival-take", 19n, [claimed(lost, rival)]),
      landed("forfeit", 18n, [moved(forfeited, w.owner.address, 1)]),
      landed("take-forfeited", 17n, [claimed(forfeited, wallet)]),
      landed("drop", 16n, [tag(getClaimDroppedEventEncoder().encode({ intent: dropped, worker: wallet, refunded: stake }))]),
      landed("take-dropped", 15n, [claimed(dropped, wallet)]),
      landed("refund", 14n, [moved(returned, wallet, 0)]),
      landed("take-returned", 13n, [claimed(returned, wallet)]),
      landed("take-lost", 12n, [claimed(lost, wallet)]),
    ];
    const entry = (intent: Address, action: string, outcome: string, signature: string, slot: bigint) => ({
      intent,
      action,
      stake: "0.05",
      stake_outcome: outcome,
      signature,
      at: String(NOW + slot),
    });
    const seen = await ok(client, "wallet_history");
    expect(seen["claims"]).toEqual([
      entry(held, "claimed", "held", "take-held", 20n),
      entry(forfeited, "claimed", "forfeited", "take-forfeited", 17n),
      entry(dropped, "dropped", "returned", "drop", 16n),
      entry(dropped, "claimed", "returned", "take-dropped", 15n),
      entry(returned, "claimed", "returned", "take-returned", 13n),
      entry(lost, "claimed", "unknown", "take-lost", 12n),
    ]);
    expect(seen["work"]).toEqual([]);
    expect(seen["more_work"]).toBe(false);
    const newest = await ok(client, "wallet_history", { limit: 2 });
    expect((newest["claims"] as Json[]).map((claim) => claim["signature"])).toEqual(["take-held", "take-forfeited"]);
    expect(newest["more_work"]).toBe(true);
  });
});
