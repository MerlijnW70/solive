import { type Address, getAddressEncoder, type Instruction, type ReadonlyUint8Array } from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstructionAsync } from "@solana-program/token";
import { beforeAll, describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, findAssociatedTokenAddress, NATIVE_MINT, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import {
  FILL_ATTESTED_DISCRIMINATOR,
  FILL_ATTESTED_SPLIT_DISCRIMINATOR,
  getFillAttestedInstructionDataDecoder,
  getFillAttestedSplitInstructionDataEncoder,
  getIntentDecoder,
  getIntentEncoder,
  INTENT_ENGINE_PROGRAM_ADDRESS,
} from "@intent-engine/core/internal";
import { createClient, type EngineTransaction, type Transport } from "../src/index.js";
import type { AccountView } from "../src/transport.js";
import { ECONOMICS_UNSET, createTestWorld, type TestWallet, type TestWorld } from "../src/testing.js";
import { eventsOf, intentHistory, paidWalletsOf, splitClaim } from "../src/release-reads.js";
import { delivered, proofParams } from "./plan-driver.js";

type Lane = { owner: TestWallet; judge: TestWallet; worker: TestWallet; intent: Address; delivery: Awaited<ReturnType<typeof delivered>> };

async function lane(world: TestWorld, amountIn = 1_000_000n, judgeFee = 0n): Promise<Lane> {
  const [owner, judge, worker] = [await world.wallet(), await world.wallet(), await world.wallet()];
  const made = await world.client.createIntent({ signer: owner, inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT, params: proofParams(judge.address, amountIn, judgeFee) });
  return { owner, judge, worker, intent: made.intent, delivery: await delivered(world, made.intent, worker) };
}

type Edit = (view: AccountView) => AccountView;

function patched(world: TestWorld, edits: Readonly<Record<string, Edit>>) {
  const edit = (address: Address, view: AccountView | null) => {
    const change = edits[address];
    return view === null || change === undefined ? view : change(view);
  };
  const transport: Transport = {
    ...world.transport,
    getAccount: async (address) => edit(address, await world.transport.getAccount(address)),
    getAccounts: async (addresses) => (await world.transport.getAccounts(addresses)).map((view, i) => edit(addresses[i] as Address, view)),
  };
  return createClient({ url: world.client.url, transport });
}

const intentEdit =
  (changes: Record<string, unknown>): Edit =>
  (view) => {
    const intent = getIntentDecoder().decode(view.data);
    return { ...view, data: new Uint8Array(getIntentEncoder().encode({ ...intent, ...changes } as never)) };
  };

const settleProof = (client: ReturnType<typeof createClient>, job: Lane) => client.plan.settleProof({ judge: job.judge, intent: job.intent, ...job.delivery, result: 1n });

const setupOf = (plan: { instructions: readonly Instruction[] }): number => plan.instructions.length - 2;

const engineCall = (instructions: readonly Instruction[], discriminator: ReadonlyUint8Array): Uint8Array => {
  const found = instructions.find(({ programAddress, data }) => programAddress === INTENT_ENGINE_PROGRAM_ADDRESS && data !== undefined && discriminator.every((byte, i) => data[i] === byte));
  return Uint8Array.from(found?.data ?? []);
};

describe("the plan of a release with no fee", () => {
  let world: TestWorld;
  beforeAll(async () => {
    world = await createTestWorld({ fees: { ...ECONOMICS_UNSET, feeBps: 0 } });
  });

  it("sets up only the account of the payee", async () => {
    const plan = await settleProof(world.client, await lane(world));
    expect(setupOf(plan)).toBe(1);
  });

  it("pays out what is still held, not what was escrowed", async () => {
    const job = await lane(world);
    const plan = await settleProof(patched(world, { [job.intent]: intentEdit({ filled: 250_000n }) }), job);
    expect(getFillAttestedInstructionDataDecoder().decode(engineCall(plan.instructions, FILL_ATTESTED_DISCRIMINATOR)).fill.amountIn).toBe(750_000n);
  });

  it("splits the fees of what is left after the judge fee", async () => {
    const job = await lane(world, 200n, 100n);
    const partner = (await world.wallet()).address;
    const plan = await settleProof(patched(world, { [job.intent]: intentEdit({ partner, partnerBps: 100, partnerCutBps: 5_000 }) }), job);
    const partnerAccount = await findAssociatedTokenAddress({ owner: partner, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(setupOf(plan)).toBe(3);
    expect(plan.instructions.some(({ accounts }) => accounts?.some(({ address }) => address === partnerAccount))).toBe(true);
  });
});

describe("the payee account of a release", () => {
  let world: TestWorld;
  beforeAll(async () => {
    world = await createTestWorld({ fees: { ...ECONOMICS_UNSET, feeBps: 0 } });
  });

  async function payeeCase(shape: (job: Lane, view: AccountView) => AccountView) {
    const job = await lane(world);
    const payee = await findAssociatedTokenAddress({ owner: job.worker.address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    await world.transport.send([await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: job.worker, owner: job.worker.address, mint: NATIVE_MINT })], job.worker);
    const bare = (data: Uint8Array): AccountView => ({ owner: TOKEN_PROGRAM_ADDRESS, data, lamports: 2_039_280n, executable: false });
    const head = new Uint8Array(64);
    head.set(getAddressEncoder().encode(NATIVE_MINT), 0);
    head.set(getAddressEncoder().encode(job.worker.address), 32);
    return settleProof(patched(world, { [payee]: () => shape(job, bare(head)) }), job);
  }

  it("is accepted with exactly the head of a token account", async () => {
    expect(setupOf(await payeeCase((_job, view) => view))).toBe(0);
  });

  it("is refused when it is shorter than the head of a token account", async () => {
    await expect(payeeCase((_job, view) => ({ ...view, data: view.data.subarray(0, 63) }))).rejects.toMatchObject({ code: "payee-moved" });
  });

  it("is refused when another program owns it", async () => {
    await expect(payeeCase((job, view) => ({ ...view, owner: job.worker.address }))).rejects.toMatchObject({ code: "payee-moved" });
  });
});

describe("the events of transactions", () => {
  let world: TestWorld;
  let first: Lane;
  let second: Lane;
  let transactions: EngineTransaction[];
  beforeAll(async () => {
    world = await createTestWorld();
    first = await lane(world);
    second = await lane(world);
    transactions = [...(await world.transport.engineTransactions(50, first.intent)), ...(await world.transport.engineTransactions(50, second.intent))];
  });

  it("keeps only the events of the intent asked for", () => {
    const both = eventsOf(transactions);
    const own = eventsOf(transactions, first.intent);
    expect(own.length).toBeGreaterThan(0);
    expect(own.every(({ event }) => "intent" in event.fields && event.fields.intent === first.intent)).toBe(true);
    expect(both.length).toBeGreaterThan(own.length);
    expect(eventsOf(transactions, second.intent).length).toBe(both.length - own.length);
  });
});

describe("the history of an intent", () => {
  let created: EngineTransaction;
  let intent: Address;
  beforeAll(async () => {
    const world = await createTestWorld();
    const job = await lane(world);
    intent = job.intent;
    const found = eventsOf(await world.transport.engineTransactions(50, intent), intent).find(({ event }) => event.name === "IntentCreated");
    created = (found as NonNullable<typeof found>).transaction;
  });

  const plain = (signature: string): EngineTransaction => {
    const { emittedAccounts: _skipped, ...rest } = created;
    return { ...rest, signature: signature as EngineTransaction["signature"], emitted: [] };
  };

  function paged(order: readonly string[]) {
    const asked: (string | undefined)[] = [];
    const known = new Map<string, EngineTransaction>(order.map((name) => [name, name === "created" ? created : plain(name)]));
    const transport = {
      signaturesOf: async (_of: Address, limit: number, before?: string) => {
        asked.push(before);
        const start = before === undefined ? 0 : order.indexOf(before) + 1;
        return order.slice(start, start + limit).map((signature) => ({ signature, slot: 1n, blockTime: 1n, failed: false, memo: null }));
      },
      transactionsOf: async (listed: readonly { signature: string }[]) => listed.map(({ signature }) => known.get(signature) as EngineTransaction),
    } as unknown as Transport;
    return { transport, asked };
  }

  const names = (found: readonly EngineTransaction[]) => found.map(({ signature }) => signature === created.signature ? "created" : signature);

  it("stops at the page that holds the creation of the intent", async () => {
    const { transport, asked } = paged(["s3", "s2", "s1", "created"]);
    const found = await intentHistory(transport, intent, 2, () => false);
    expect(names(found.transactions)).toStrictEqual(["s3", "s2", "s1", "created"]);
    expect(found.complete).toBe(true);
    expect(asked).toHaveLength(2);
  });

  it("is complete when the ledger runs out before the page is full", async () => {
    const { transport, asked } = paged(["s2", "s1"]);
    const found = await intentHistory(transport, intent, 5, () => false);
    expect(names(found.transactions)).toStrictEqual(["s2", "s1"]);
    expect(found.complete).toBe(true);
    expect(asked).toHaveLength(2);
  });

  it("stops at the page the caller has enough from", async () => {
    const { transport } = paged(["s3", "s2", "created"]);
    const found = await intentHistory(transport, intent, 2, (read) => read.length > 0);
    expect(names(found.transactions)).toStrictEqual(["s3", "s2"]);
    expect(found.complete).toBe(true);
  });

  it("is incomplete when the page limit is reached without the creation", async () => {
    const { transport } = paged(Array.from({ length: 40 }, (_, i) => "s" + String(i)));
    const found = await intentHistory(transport, intent, 2, () => false);
    expect(found.complete).toBe(false);
    expect(found.transactions).toHaveLength(20);
  });

  const unpaged = (read: EngineTransaction[]) => ({ engineTransactions: async () => read }) as unknown as Transport;

  it("without paging is complete when fewer transactions than asked came back", async () => {
    expect((await intentHistory(unpaged([plain("a")]), intent, 3)).complete).toBe(true);
  });

  it("without paging is incomplete when a full page came back with no creation", async () => {
    expect((await intentHistory(unpaged([plain("a"), plain("b"), plain("c")]), intent, 3)).complete).toBe(false);
  });

  it("without paging is complete when the creation is in a full page", async () => {
    expect((await intentHistory(unpaged([created, plain("b"), plain("c")]), intent, 3)).complete).toBe(true);
  });

  it("without paging is complete when the caller has enough from a full page", async () => {
    expect((await intentHistory(unpaged([plain("a"), plain("b"), plain("c")]), intent, 3, () => true)).complete).toBe(true);
  });
});

describe("the wallets a release paid", () => {
  const payee = "So11111111111111111111111111111111111111112" as Address;
  const owner = "11111111111111111111111111111112" as Address;
  const attested = { event: { name: "IntentAttested", fields: { payee } }, transaction: {} } as never;

  const holding = (length: number) => {
    const data = new Uint8Array(length);
    data.set(getAddressEncoder().encode(owner).subarray(0, Math.max(0, Math.min(32, length - 32))), 32);
    return { owner: TOKEN_PROGRAM_ADDRESS, data, lamports: 1n, executable: false } satisfies AccountView;
  };
  const reading = (view: AccountView | null) => ({ getAccount: async () => view }) as unknown as Transport;

  it("reads the owner from a token account of exactly the head, and of a full account", async () => {
    expect(await paidWalletsOf(reading(holding(64)), attested, owner)).toStrictEqual([owner]);
    expect(await paidWalletsOf(reading(holding(165)), attested, owner)).toStrictEqual([owner]);
  });

  it("knows nobody for a token account too short to read, or none", async () => {
    expect(await paidWalletsOf(reading(holding(63)), attested, owner)).toBeNull();
    expect(await paidWalletsOf(reading(null), attested, owner)).toBeNull();
  });
});

describe("the claim of a split release", () => {
  const intent = "So11111111111111111111111111111111111111112" as Address;
  const [first, second] = ["11111111111111111111111111111112", "11111111111111111111111111111113"] as Address[];
  const body = getFillAttestedSplitInstructionDataEncoder().encode({
    fill: { amountIn: 1n, result: 1n, maxFeeBps: 0 },
    claim: { recipients: [first as Address, second as Address], weights: [6_000, 4_000] },
    opening: { delivered: new Uint8Array(32), salt: new Uint8Array(16) },
    ext: new Uint8Array(0),
  });
  const release = (data: Uint8Array, accounts: Address[] = [first as Address, second as Address, intent]) => ({ called: [data], calledAccounts: [accounts], emitted: [] }) as unknown as EngineTransaction;

  it("is read from a call with the discriminator of a split fill", () => {
    expect(splitClaim(release(new Uint8Array(body)), intent)).toStrictEqual({ recipients: [first, second], weights: [6_000, 4_000] });
  });

  it("is not read from a call with another discriminator", () => {
    const other = new Uint8Array(body);
    other.set(FILL_ATTESTED_SPLIT_DISCRIMINATOR.map((byte) => byte ^ 0xff), 0);
    expect(splitClaim(release(other), intent)).toBeNull();
  });

  it("is not read from a call that names another intent", () => {
    expect(splitClaim(release(new Uint8Array(body), [first as Address, second as Address, first as Address]), intent)).toBeNull();
  });
});
