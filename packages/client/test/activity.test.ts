import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Address, getAddressDecoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { attestedResult, DEVNET_TEST_MINT, EVENT_IX_TAG, INTENT_ENGINE_PROGRAM_ADDRESS, InvalidInput, Kind, NATIVE_MINT, swapExactIn } from "@intent-engine/core";
import {
  encodeParams,
  getCreateIntentByAgentInstructionDataEncoder,
  getCreateIntentInstructionDataEncoder,
  getCreateIntentSignedInstructionDataEncoder,
  getIntentCreatedEventEncoder,
  getJobClaimedEventEncoder,
  getUserInitializedEventEncoder,
} from "@intent-engine/core/internal";
import { createClient, type EngineTransaction, escrowTermsIn, type ListedSignature, TransportLacks, type Transport } from "../src/index.js";
import { ACTIVITY_BATCH, ACTIVITY_LIMIT, ACTIVITY_LIMIT_MAX, TRANSACTION_FETCHES } from "../src/internal.js";
import { createTestWorld, testSignature } from "../src/testing.js";

const DEVNET = "https://api.devnet.solana.com";
const addressOf = (seed: number): Address => getAddressDecoder().decode(new Uint8Array(32).fill(seed));
const tagged = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);

const OWNER = addressOf(11);
const JUDGE = addressOf(12);
const JOB = addressOf(13);
const OTHER = addressOf(14);
const WORKER = addressOf(15);
const HASH = new Uint8Array(32).fill(0xab);

const claimed = (stake: bigint) => tagged(getJobClaimedEventEncoder().encode({ intent: JOB, worker: WORKER, until: 0n, stake }));
const user = tagged(getUserInitializedEventEncoder().encode({ owner: OWNER }));
const created = (intent: Address, nonce: bigint, kind: number = Kind.AttestedResult) =>
  tagged(
    getIntentCreatedEventEncoder().encode({
      intent,
      owner: OWNER,
      nonce,
      kind,
      inputMint: DEVNET_TEST_MINT,
      outputMint: DEVNET_TEST_MINT,
      receiver: OWNER,
      escrowed: 900n,
      expiresAt: 4_000_000_000n,
      rentPayer: OWNER,
      flags: 0,
      bounty: 0,
      createFee: 0,
    }),
  );

const escrowParams = encodeParams(attestedResult({ amountIn: 1_000n, minResult: 1n, maxResult: 3n, attestor: JUDGE, specHash: HASH, judgeFee: 100n }));
const createArgs = (nonce: bigint, params: Uint8Array = escrowParams, kind: number = Kind.AttestedResult) => ({
  args: { nonce, kind, flags: 0, params, expiresAt: 4_000_000_000n, ext: new Uint8Array(), maxCreateFee: 0, maxBounty: 0 },
});
const filler = (count: number) => Array.from({ length: count }, (_, i) => addressOf(100 + i));
const placed = (intentAt: number, intent: Address): Address[] => [...filler(intentAt), intent, ...filler(18 - intentAt)];

type Made = Partial<EngineTransaction> & { emitted: Uint8Array[] };

const txOf = (seed: number, made: Made): EngineTransaction => ({ signature: testSignature(seed), slot: BigInt(seed), blockTime: BigInt(1_000 + seed), failed: false, ...made });

const escrowTx = (call: Uint8Array, accounts: Address[], extra: Partial<EngineTransaction> = {}) =>
  txOf(1, { emitted: [created(JOB, 7n)], called: [Uint8Array.from(call)], calledAccounts: [accounts], ...extra });

describe("the terms an escrow was created with", () => {
  const plain = Uint8Array.from(getCreateIntentInstructionDataEncoder().encode(createArgs(7n)));

  it("reads owner, judge, spec hash, amounts and token from the create instruction of each kind", () => {
    const terms = {
      intent: JOB,
      signature: testSignature(1),
      owner: OWNER,
      attestor: JUDGE,
      specHash: "ab".repeat(32),
      mint: DEVNET_TEST_MINT,
      amountIn: 1_000n,
      escrowed: 900n,
      judgeFee: 100n,
      minResult: 1n,
      maxResult: 3n,
      nonce: 7n,
      expiresAt: 4_000_000_000n,
    };
    expect(escrowTermsIn(escrowTx(plain, placed(3, JOB)), JOB)).toEqual(terms);
    const byAgent = Uint8Array.from(getCreateIntentByAgentInstructionDataEncoder().encode(createArgs(7n)));
    expect(escrowTermsIn(escrowTx(byAgent, placed(5, JOB)), JOB)).toEqual(terms);
    const signed = Uint8Array.from(getCreateIntentSignedInstructionDataEncoder().encode({ ...createArgs(7n), submitBy: 4_000_000_000n, relayerFee: 0n }));
    expect(escrowTermsIn(escrowTx(signed, placed(4, JOB)), JOB)).toEqual(terms);
  });

  it("is null when the transaction did not create that escrow", () => {
    expect(escrowTermsIn(escrowTx(plain, placed(3, JOB)), OTHER)).toBeNull();
    expect(escrowTermsIn(escrowTx(plain, placed(3, JOB), { failed: true }), JOB)).toBeNull();
    expect(escrowTermsIn(escrowTx(plain, placed(2, JOB)), JOB)).toBeNull();
    expect(escrowTermsIn(escrowTx(plain, [OWNER, JOB]), JOB)).toBeNull();
    expect(escrowTermsIn(escrowTx(plain, placed(3, JOB), { emitted: [created(JOB, 8n)] }), JOB)).toBeNull();
    expect(escrowTermsIn(escrowTx(plain, placed(3, JOB), { emitted: [created(JOB, 7n, Kind.SwapExactIn)] }), JOB)).toBeNull();
    expect(escrowTermsIn(escrowTx(plain, placed(3, JOB), { emitted: [] }), JOB)).toBeNull();
    expect(escrowTermsIn(escrowTx(plain, placed(3, JOB), { called: [], calledAccounts: [] }), JOB)).toBeNull();
    const swap = Uint8Array.from(getCreateIntentInstructionDataEncoder().encode(createArgs(7n, encodeParams(swapExactIn({ amountIn: 1n, minOut: 1n })), Kind.SwapExactIn)));
    expect(escrowTermsIn(escrowTx(swap, placed(3, JOB)), JOB)).toBeNull();
    expect(escrowTermsIn(escrowTx(plain.slice(0, 20), placed(3, JOB)), JOB)).toBeNull();
    const badParams = Uint8Array.from(getCreateIntentInstructionDataEncoder().encode(createArgs(7n, new Uint8Array(3))));
    expect(escrowTermsIn(escrowTx(badParams, placed(3, JOB)), JOB)).toBeNull();
  });

  it("skips a create call for another intent before the one that made it", () => {
    const other = Uint8Array.from(getCreateIntentInstructionDataEncoder().encode(createArgs(7n, encodeParams(attestedResult({ amountIn: 5n, minResult: 0n, maxResult: 1n, attestor: OWNER, specHash: HASH, judgeFee: 0n })))));
    const tx = escrowTx(other, placed(3, OTHER), { called: [Uint8Array.from(other), plain], calledAccounts: [placed(3, OTHER), placed(3, JOB)] });
    expect(escrowTermsIn(tx, JOB)?.attestor).toBe(JUDGE);
  });

  it("reads the create call of an escrow made through another program, from the inner instructions", () => {
    const tx = txOf(1, { emitted: [created(JOB, 7n), plain], emittedAccounts: [[], placed(3, JOB)] });
    expect(escrowTermsIn(tx, JOB)).toMatchObject({ attestor: JUDGE, specHash: "ab".repeat(32), amountIn: 1_000n });
    expect(escrowTermsIn(tx, OTHER)).toBeNull();
    expect(escrowTermsIn(txOf(1, { emitted: [created(JOB, 7n), plain], emittedAccounts: [[], placed(2, JOB)] }), JOB)).toBeNull();
  });

  it("refuses to answer for an unread transaction rather than saying it created nothing", () => {
    const tx = txOf(1, { emitted: [], unread: true });
    expect(() => escrowTermsIn(tx, JOB)).toThrow(expect.objectContaining({ code: "transaction-unread", signature: tx.signature }));
  });

  it("reads a transaction by signature through the client, and needs transactionOf for it", async () => {
    const tx = escrowTx(plain, placed(3, JOB));
    const asked: string[] = [];
    const transport = { transactionOf: async (signature: string) => (asked.push(signature), signature === tx.signature ? tx : null) } as unknown as Transport;
    const client = createClient({ url: DEVNET, transport });
    expect((await client.escrowTerms(tx.signature, JOB))?.specHash).toBe("ab".repeat(32));
    await expect(client.escrowTerms(testSignature(99), JOB)).rejects.toMatchObject({ code: "transaction-unread", signature: testSignature(99) });
    expect((await client.escrowTerms(tx, JOB))?.owner).toBe(OWNER);
    expect(asked).toEqual([tx.signature, testSignature(99)]);
    await expect(createClient({ url: DEVNET, transport: {} as Transport }).escrowTerms(tx.signature, JOB)).rejects.toBeInstanceOf(TransportLacks);
  });
});

type Program = { transport: Transport; listings: { limit: number; before: string | undefined; until: string | undefined }[]; reads: string[][] };

function program(transactions: EngineTransaction[]): Program {
  const newestFirst = [...transactions].reverse();
  const listings: Program["listings"] = [];
  const reads: string[][] = [];
  const transport = {
    signaturesOf: async (of: Address, limit: number, before?: string, until?: string): Promise<ListedSignature[]> => {
      expect(of).toBe(INTENT_ENGINE_PROGRAM_ADDRESS);
      listings.push({ limit, before, until });
      const start = before === undefined ? 0 : newestFirst.findIndex(({ signature }) => signature === before) + 1;
      const stop = until === undefined ? newestFirst.length : newestFirst.findIndex(({ signature }) => signature === until);
      return newestFirst.slice(start, stop === -1 ? newestFirst.length : stop).slice(0, limit).map(({ signature, slot, blockTime, failed }) => ({ signature, slot, blockTime, failed, memo: null }));
    },
    transactionsOf: async (listed: readonly ListedSignature[]) => {
      reads.push(listed.map(({ signature }) => signature));
      return listed.map(({ signature }) => transactions.find((tx) => tx.signature === signature) as EngineTransaction);
    },
  } as unknown as Transport;
  return { transport, listings, reads };
}

const claims = (count: number): EngineTransaction[] => Array.from({ length: count }, (_, i) => txOf(i + 1, { emitted: [claimed(BigInt(i + 1))] }));

const stakes = (events: { name: string; fields: unknown }[]) => events.map((event) => (event.name === "JobClaimed" ? (event.fields as { stake: bigint }).stake : event.name));

describe("program-wide activity", () => {
  it("returns typed events newest first, across and within transactions, with signature, slot and block time", async () => {
    const txs = [txOf(1, { emitted: [user, claimed(1n)] }), txOf(2, { emitted: [claimed(2n), new Uint8Array(3), claimed(3n)] })];
    const { transport } = program(txs);
    const page = await createClient({ url: DEVNET, transport }).activity();
    expect(stakes(page.events)).toEqual([3n, 2n, 1n, "UserInitialized"]);
    expect(page.events[0]).toMatchObject({ name: "JobClaimed", signature: testSignature(2), slot: 2n, blockTime: 1_002n });
    expect(page.events[3]).toMatchObject({ signature: testSignature(1), slot: 1n, blockTime: 1_001n, fields: { owner: OWNER } });
    expect(page).toMatchObject({ newest: testSignature(2), next: null });
  });

  it("stops at until and reports the newest signature as the next cursor", async () => {
    const { transport, listings } = program(claims(5));
    const client = createClient({ url: DEVNET, transport });
    const page = await client.activity({ until: testSignature(3) });
    expect(stakes(page.events)).toEqual([5n, 4n]);
    expect(listings[0]).toEqual({ limit: ACTIVITY_LIMIT, before: undefined, until: testSignature(3) });
    expect(page.newest).toBe(testSignature(5));
    expect(await client.activity({ until: testSignature(5) })).toEqual({ events: [], newest: null, next: null, complete: true, unread: [] });
  });

  it("hands out no cursor past an unread transaction, so a reader following the docs reads it again", async () => {
    const chain = [txOf(1, { emitted: [claimed(1n)] }), txOf(2, { emitted: [], unread: true }), txOf(3, { emitted: [claimed(3n)] })];
    const client = createClient({ url: DEVNET, transport: program(chain).transport });
    const cut = await client.activity({ until: testSignature(1) });
    expect(stakes(cut.events)).toEqual([3n]);
    expect(cut).toMatchObject({ newest: null, next: null, complete: false, unread: [testSignature(2)] });
    chain[1] = txOf(2, { emitted: [claimed(2n)] });
    const again = await client.activity({ until: testSignature(1) });
    expect(stakes(again.events)).toEqual([3n, 2n]);
    expect(again).toMatchObject({ newest: testSignature(3), complete: true, unread: [] });
  });

  it("moves past a stuck signature when unread[0] is passed as until, as the docs say", async () => {
    const chain = [txOf(1, { emitted: [claimed(1n)] }), txOf(2, { emitted: [], unread: true }), txOf(3, { emitted: [], unread: true }), txOf(4, { emitted: [claimed(4n)] })];
    const client = createClient({ url: DEVNET, transport: program(chain).transport });
    const cut = await client.activity();
    expect(cut.unread).toEqual([testSignature(3), testSignature(2)]);
    const past = await client.activity({ until: String(cut.unread[0]) });
    expect(stakes(past.events)).toEqual([4n]);
    expect(past).toMatchObject({ newest: testSignature(4), complete: true, unread: [] });
  });

  it("reports an unread transaction of a later batch of the page", async () => {
    const chain = claims(ACTIVITY_BATCH + 5);
    chain[1] = txOf(2, { emitted: [], unread: true });
    const page = await createClient({ url: DEVNET, transport: program(chain).transport }).activity({ limit: ACTIVITY_BATCH + 5 });
    expect(page).toMatchObject({ newest: null, complete: false, unread: [testSignature(2)] });
  });

  it("reads in batches of at most ACTIVITY_BATCH signatures, each one read of their transactions, up to limit", async () => {
    const { transport, listings, reads } = program(claims(2 * ACTIVITY_BATCH + 30));
    const page = await createClient({ url: DEVNET, transport }).activity({ limit: 2 * ACTIVITY_BATCH + 10 });
    expect(listings.map(({ limit }) => limit)).toEqual([ACTIVITY_BATCH, ACTIVITY_BATCH, 10]);
    expect(listings.map(({ before }) => before)).toEqual([undefined, testSignature(ACTIVITY_BATCH + 31), testSignature(31)]);
    expect(reads.map((batch) => batch.length)).toEqual([ACTIVITY_BATCH, ACTIVITY_BATCH, 10]);
    expect(page.events).toHaveLength(2 * ACTIVITY_BATCH + 10);
    expect(stakes(page.events).slice(0, 2)).toEqual([BigInt(2 * ACTIVITY_BATCH + 30), BigInt(2 * ACTIVITY_BATCH + 29)]);
    expect(page.newest).toBe(testSignature(2 * ACTIVITY_BATCH + 30));
    expect(page.next).toBe(testSignature(21));
  });

  it("continues before next and ends with next null on a short batch", async () => {
    const { transport, listings } = program(claims(7));
    const client = createClient({ url: DEVNET, transport });
    const first = await client.activity({ limit: 4 });
    expect(stakes(first.events)).toEqual([7n, 6n, 5n, 4n]);
    expect(first.next).toBe(testSignature(4));
    const rest = await client.activity({ limit: 4, before: String(first.next) });
    expect(stakes(rest.events)).toEqual([3n, 2n, 1n]);
    expect(rest).toMatchObject({ newest: testSignature(3), next: null });
    expect(listings.at(-1)).toEqual({ limit: 4, before: testSignature(4), until: undefined });
  });

  it("reads no failed transaction and asks nothing for a batch of only failed ones", async () => {
    const failed = (seed: number) => txOf(seed, { emitted: [claimed(99n)], failed: true });
    const { transport, reads } = program([txOf(1, { emitted: [claimed(1n)] }), failed(2), failed(3)]);
    const client = createClient({ url: DEVNET, transport });
    expect(stakes((await client.activity({ limit: 2 })).events)).toEqual([]);
    expect(reads).toEqual([]);
    expect(stakes((await client.activity()).events)).toEqual([1n]);
    expect(reads).toEqual([[testSignature(1)]]);
  });

  it("refuses a limit out of range or a cursor that is not a signature, and needs signaturesOf and transactionsOf", async () => {
    const client = createClient({ url: DEVNET, transport: program([]).transport });
    for (const limit of [0, ACTIVITY_LIMIT_MAX + 1, 1.5]) {
      await expect(client.activity({ limit })).rejects.toMatchObject({ code: "invalid-input", field: "limit" });
    }
    expect((await client.activity({ limit: ACTIVITY_LIMIT_MAX })).events).toEqual([]);
    await expect(client.activity({ until: "not-a-signature" })).rejects.toMatchObject({ code: "invalid-input", field: "until" });
    await expect(client.activity({ before: "x" })).rejects.toBeInstanceOf(InvalidInput);
    await expect(createClient({ url: DEVNET, transport: {} as Transport }).activity()).rejects.toMatchObject({ code: "transport-lacks", method: "signaturesOf" });
    const listsOnly = { signaturesOf: async () => [] } as unknown as Transport;
    await expect(createClient({ url: DEVNET, transport: listsOnly }).activity()).rejects.toMatchObject({ code: "transport-lacks", method: "transactionsOf" });
  });
});

describe("the activity docs", () => {
  it("state the limits activity reads within", () => {
    const root = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
    const page = readFileSync(`${root}/docs/sdk-client.md`, "utf8");
    expect(page).toContain(`It lists \`limit\` transactions, ${ACTIVITY_LIMIT} by default and at most ${ACTIVITY_LIMIT_MAX}, in batches of ${ACTIVITY_BATCH},`);
    expect(page).toContain(`one \`getTransaction\` per transaction that did not fail, ${TRANSACTION_FETCHES} at a time, so a default \`activity()\` can cost ${ACTIVITY_LIMIT + 1} RPC calls`);
    expect(page).toContain("keep the first page's `newest`");
    expect(page).toContain("`complete` is `false`");
    expect(page).toContain("pass `unread[0]` as `until`, which gives up that signature and every older one not yet read");
    expect(page).toContain("a 429 rejects with `RateLimited` and discards the page's earlier batches");
    expect(page).not.toContain("in one call");
  });
});

describe("activity and escrow terms on the program", () => {
  it("reads a real escrow's creation and its terms, and until stops at the newest one read", async () => {
    const world = await createTestWorld();
    const [owner, judge] = [await world.wallet(), await world.wallet()];
    const specHash = new Uint8Array(createHash("sha256").update("the spec").digest());
    const amountIn = await world.client.amount(NATIVE_MINT, "0.5");
    const params = attestedResult({ amountIn, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash, judgeFee: 0n });
    const made = await world.client.createIntent({ signer: owner, inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT, params });
    const page = await world.client.activity({ limit: 10 });
    expect(page.events.find(({ name }) => name === "IntentCreated")).toMatchObject({ signature: made.signature, fields: { intent: made.intent, owner: owner.address } });
    expect(page.newest).toBe(made.signature);
    expect(await world.client.escrowTerms(made.signature, made.intent)).toMatchObject({
      owner: owner.address,
      attestor: judge.address,
      specHash: Buffer.from(specHash).toString("hex"),
      mint: NATIVE_MINT,
      amountIn,
      nonce: made.nonce,
    });
    expect(await world.client.escrowTerms(made.signature, judge.address)).toBeNull();
    expect((await world.client.activity({ until: made.signature })).events).toEqual([]);
    const cancelled = await world.client.cancel(owner, made.intent);
    const later = await world.client.activity({ until: made.signature });
    expect(later.newest).toBe(cancelled);
    expect(later.events.map(({ name }) => name)).toContain("IntentCancelled");
    expect(later.events.every(({ signature }) => signature === cancelled)).toBe(true);
  });
});
