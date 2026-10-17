import {
  type Address,
  type Base64EncodedWireTransaction,
  type Blockhash,
  generateKeyPairSigner,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type KeyPairSigner,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { type Config, encodeParams, type Intent, IntentStatus, Kind } from "@intent-engine/core";
import {
  ALREADY_FILLING,
  badConcurrency,
  type Chain,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  type Pricer,
  type Quote,
  type QuoteRequest,
  RateLimited,
  type Report,
  SIMULATION_REFUSED,
  type SolverOptions,
  tick,
} from "../src/index.js";

const KEY = "11111111111111111111111111111112" as Address;
const NOW = 1_700_000_000n;
const AMOUNT = 100_000n;
const MIN_OUT = 90_000n;
const FLOOR = 2n;
const PLENTY = 10n ** 18n;

type Order = { address: Address; intent: Intent };

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function turns(count = 50): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await turn();
  }
}

async function until(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 100_000 && !ready(); i += 1) {
    await turn();
  }
  expect(ready()).toBe(true);
}

const fresh = async (): Promise<Address> => (await generateKeyPairSigner()).address;

async function order(outputMint: Address, over: Partial<Intent> = {}): Promise<Order> {
  return {
    address: await fresh(),
    intent: {
      discriminator: new Uint8Array(8),
      owner: await fresh(),
      inputMint: await fresh(),
      outputMint,
      receiver: KEY,
      nonce: 1n,
      escrowed: AMOUNT,
      createdAt: NOW,
      expiresAt: NOW + 600n,
      kind: Kind.SwapExactIn,
      status: IntentStatus.Open,
      bump: 255,
      vaultBump: 255,
      version: 1,
      padding: new Uint8Array(1),
      flags: 0,
      params: encodeParams({ kind: Kind.SwapExactIn, amountIn: AMOUNT, minOut: MIN_OUT }),
      rentPayer: KEY,
      filled: 0n,
      revision: 0,
      partnerBps: 0,
      partnerCutBps: 0,
      inFlight: 0n,
      partner: KEY,
      bounty: 0,
      mandate: "11111111111111111111111111111111" as Address,
      gap: new Uint8Array(4),
      mandateSerial: 0n,
      agentFee: 0n,
      claims: 0,
      reserved: new Uint8Array(15),
      ...over,
    },
  };
}

const config = (feeRecipient: Address): Config => ({
  discriminator: new Uint8Array(8),
  admin: KEY,
  pendingAdmin: KEY,
  guardian: KEY,
  feeRecipient,
  enabledKinds: 0b1_1110n,
  feeBps: 5,
  paused: 0,
  version: 1,
  bump: 255,
  kindFeeMask: 0,
  partnerCutBps: 0,
  domain: new Uint8Array(32),
  fillDisabledKinds: 0n,
  kindFeeBps: [0, 0, 0, 0],
  crankBounty: 0,
  createFee: 0,
  capsRequired: 0,
  reserved: new Uint8Array(7),
});

const paying = (request: QuoteRequest, profit: bigint): Quote => ({
  amountIn: request.amountIn,
  amountOut: MIN_OUT + profit,
  instructions: [],
  lookupTables: [],
});

type World = {
  orders: Order[];
  output: Address;
  solver: KeyPairSigner;
  started: Address[];
  sends: Address[];
  log: string[];
  events: string[];
  configReads: number;
  maxPlanning: number;
  maxSending: number;
  quote: (request: QuoteRequest, order: Order) => Promise<Quote | null>;
  failSimulation: (order: Order) => string | null;
  run(extra?: Partial<SolverOptions>): Promise<Report>;
};

async function world(orders: Order[], output: Address): Promise<World> {
  const solver = await generateKeyPairSigner();
  const feeRecipient = await fresh();
  const blockhash = (await fresh()) as unknown as Blockhash;
  const byMint = new Map(orders.map((o) => [o.intent.inputMint, o]));
  let planning = 0;
  let sending = 0;
  const intentOf = (wire: Base64EncodedWireTransaction): Order => {
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
    const keys = getCompiledTransactionMessageDecoder().decode(tx.messageBytes).staticAccounts;
    const found = orders.find((o) => keys.includes(o.intent.inputMint));
    if (found === undefined) {
      throw new Error("the wire fills no known order");
    }
    return found;
  };
  const w: World = {
    orders,
    output,
    solver,
    started: [],
    sends: [],
    log: [],
    events: [],
    configReads: 0,
    maxPlanning: 0,
    maxSending: 0,
    quote: async (request) => paying(request, 5n),
    failSimulation: () => null,
    run: (extra = {}) => tick({ ...options, ...extra }),
  };
  const chain: Chain = {
    config: async () => {
      w.configReads += 1;
      return config(feeRecipient);
    },
    intents: async () => orders,
    now: async () => NOW,
    tokenProgram: async (mint) => {
      const found = byMint.get(mint);
      if (found !== undefined) {
        w.started.push(found.address);
        w.events.push(`plan ${found.address}`);
        planning += 1;
        w.maxPlanning = Math.max(w.maxPlanning, planning);
      }
      return TOKEN_PROGRAM_ADDRESS;
    },
    exists: async () => true,
    lookupTables: async () => {
      planning -= 1;
      return {};
    },
    blockhash: async () => ({ blockhash, lastValidBlockHeight: 0n }),
    tokenAmount: async () => 0n,
  };
  const pricer: Pricer = {
    quote: (request) => {
      const found = byMint.get(request.inputMint);
      if (found === undefined) {
        throw new Error("no such order");
      }
      w.events.push(`quote ${found.address}`);
      return w.quote(request, found);
    },
  };
  const options: SolverOptions = {
    chain,
    pricer,
    solver,
    strategy: { minProfit: new Map([[output, FLOOR]]), maxFeeBps: 100 },
    tip: null,
    unitPrice: async () => 0n,
    simulate: async (wire) => {
      const found = intentOf(wire);
      w.log.push(`simulate ${found.address}`);
      const err = w.failSimulation(found);
      return { err, unitsConsumed: null, balances: [PLENTY, PLENTY] };
    },
    send: async (wire) => {
      const found = intentOf(wire);
      sending += 1;
      w.maxSending = Math.max(w.maxSending, sending);
      w.log.push(`send ${found.address}`);
      await turns(5);
      w.sends.push(found.address);
      w.log.push(`sent ${found.address}`);
      sending -= 1;
      return { signature: "signature-" + found.address, confirmed: true };
    },
  };
  return w;
}

async function many(count: number, over: (i: number) => Partial<Intent> = () => ({})): Promise<{ output: Address; orders: Order[] }> {
  const output = await fresh();
  const orders: Order[] = [];
  for (let i = 0; i < count; i += 1) {
    orders.push(await order(output, over(i)));
  }
  return { output, orders };
}

const filledEntry = (o: Order, profit: bigint) => ({ intent: o.address, profit, cost: expect.any(BigInt), signature: "signature-" + o.address });

type Held = { order: Order; release(): void; fail(error: unknown): void };

function holding(w: World): Held[] {
  const held: Held[] = [];
  w.quote = (request, found) =>
    new Promise((resolve, reject) => {
      held.push({ order: found, release: () => resolve(paying(request, 5n)), fail: reject });
    });
  return held;
}

describe("parallel planning", () => {
  it("defaults to 4 plans at a time and accepts 1 to 32", () => {
    expect(DEFAULT_CONCURRENCY).toBe(4);
    expect(MAX_CONCURRENCY).toBe(32);
    expect(badConcurrency(0)).toBe("concurrency must be an integer from 1 to 32, not 0");
  });

  it("refuses a concurrency outside 1 to 32 before it reads the chain", async () => {
    const { output, orders } = await many(1);
    const w = await world(orders, output);
    for (const bad of [0, 33, 1.5, -1, Number.NaN]) {
      await expect(w.run({ concurrency: bad })).rejects.toThrow(badConcurrency(bad));
    }
    expect(w.configReads).toBe(0);
    for (const good of [1, 32]) {
      expect((await w.run({ concurrency: good })).filled).toHaveLength(1);
    }
  });

  it("never has more than concurrency plans in flight", async () => {
    const { output, orders } = await many(7);
    const w = await world(orders, output);
    const held = holding(w);
    const done = w.run({ concurrency: 3 });
    await until(() => held.length === 3);
    await turns();
    expect(new Set(w.started).size).toBe(3);
    expect(w.sends).toEqual([]);
    for (let released = 0; released < orders.length; released += 1) {
      const due = Math.min(orders.length, released + 3);
      await until(() => held.length === due);
      await turns();
      expect(held.length).toBe(due);
      expect(new Set(w.started).size).toBe(due);
      held[released]?.release();
    }
    const report = await done;
    expect(report.filled).toEqual(orders.map((o) => filledEntry(o, 5n)));
    expect(w.maxPlanning).toBe(3);
    expect(new Set(w.started).size).toBe(orders.length);
  });

  it("plans 4 orders at a time when no concurrency is given", async () => {
    const { output, orders } = await many(6);
    const w = await world(orders, output);
    const held = holding(w);
    const done = w.run();
    await until(() => held.length === 4);
    await turns();
    expect(new Set(w.started).size).toBe(4);
    for (let released = 0; released < orders.length; released += 1) {
      await until(() => held.length > released);
      held[released]?.release();
    }
    expect((await done).filled).toHaveLength(6);
    expect(w.maxPlanning).toBe(4);
  });

  it("simulates and sends one fill at a time, highest profit first, then soonest expiry, then lowest address", async () => {
    const output = await fresh();
    const low = await order(output);
    const late = await order(output, { expiresAt: NOW + 900n });
    const soon = await order(output, { expiresAt: NOW + 300n });
    const tieA = await order(output, { expiresAt: NOW + 300n });
    const tieB = await order(output, { expiresAt: NOW + 300n });
    const orders = [low, late, soon, tieA, tieB];
    const profits = new Map<Address, bigint>([
      [low.address, 5n],
      [late.address, 9n],
      [soon.address, 9n],
      [tieA.address, 3n],
      [tieB.address, 3n],
    ]);
    const w = await world(orders, output);
    w.quote = async (request, found) => paying(request, profits.get(found.address) ?? 0n);
    const report = await w.run({ concurrency: 5 });
    const ties = [tieA.address, tieB.address].toSorted((a, b) => (a < b ? -1 : 1));
    const expected = [soon.address, late.address, low.address, ...ties];
    expect(w.sends).toEqual(expected);
    expect(w.maxSending).toBe(1);
    expect(w.log).toEqual(expected.flatMap((address) => [`simulate ${address}`, `send ${address}`, `sent ${address}`]));
    expect(report).toEqual({
      filled: orders.map((o) => filledEntry(o, profits.get(o.address) ?? 0n)),
      sent: [],
      skipped: [],
      failed: [],
    });
  });

  it("stops starting plans once rate limited, lets running plans finish and skips the rest", async () => {
    const { output, orders } = await many(5);
    const w = await world(orders, output);
    const held = holding(w);
    const done = w.run({ concurrency: 2 });
    await until(() => held.length === 2);
    const [limited, running] = held;
    limited?.fail(new RateLimited());
    await turns();
    expect(new Set(w.started).size).toBe(2);
    running?.release();
    const report = await done;
    const reason = new RateLimited().message;
    expect(report).toEqual({
      filled: running === undefined ? [] : [filledEntry(running.order, 5n)],
      sent: [],
      skipped: orders.filter((o) => o !== running?.order).map((o) => ({ intent: o.address, reason })),
      failed: [],
    });
    expect(new Set(w.started).size).toBe(2);
    expect(held).toHaveLength(2);
  });

  it("sends nothing more once a send step is rate limited", async () => {
    const { output, orders } = await many(3);
    const w = await world(orders, output);
    w.failSimulation = () => {
      throw new RateLimited();
    };
    const report = await w.run();
    const reason = new RateLimited().message;
    expect(report).toEqual({ filled: [], sent: [], skipped: orders.map((o) => ({ intent: o.address, reason })), failed: [] });
    expect(w.log).toHaveLength(1);
    expect(w.sends).toEqual([]);
  });

  it("never sends two fills for one order in one tick", async () => {
    const { output, orders } = await many(1);
    const [only] = orders;
    if (only === undefined) {
      throw new Error("no order");
    }
    const w = await world([only, only], output);
    const report = await w.run();
    expect(report).toEqual({ filled: [filledEntry(only, 5n)], sent: [], skipped: [{ intent: only.address, reason: ALREADY_FILLING }], failed: [] });
    expect(w.sends).toEqual([only.address]);
  });

  it("with concurrency 1 plans one order after another and reports what the sequential solver reported", async () => {
    const scenario = async (concurrency: number) => {
      const output = await fresh();
      const good = await order(output);
      const thin = await order(output);
      const broken = await order(output);
      const rich = await order(output);
      const expired = await order(output, { expiresAt: NOW - 1n });
      const refused = await order(output);
      const orders = [good, thin, broken, rich, expired, refused];
      const w = await world(orders, output);
      const profits = new Map<Address, bigint>([
        [good.address, 3n],
        [thin.address, 1n],
        [rich.address, 9n],
        [refused.address, 4n],
      ]);
      w.quote = async (request, found) => {
        if (found === broken) {
          throw new Error("market unavailable");
        }
        return paying(request, profits.get(found.address) ?? 0n);
      };
      w.failSimulation = (found) => (found === refused ? "boom" : null);
      const report = await w.run({ concurrency });
      expect(report).toEqual({
        filled: [filledEntry(good, 3n), filledEntry(rich, 9n)],
        sent: [],
        skipped: [
          { intent: thin.address, reason: `profit 1 is below ${FLOOR}` },
          { intent: expired.address, reason: "expired" },
        ],
        failed: [
          { intent: broken.address, error: "market unavailable" },
          { intent: refused.address, error: `${SIMULATION_REFUSED}: boom` },
        ],
      });
      expect(w.sends).toEqual([rich.address, good.address]);
      return { w, orders: [good, thin, broken, rich, refused] };
    };
    const sequential = await scenario(1);
    expect(sequential.w.events).toEqual(sequential.orders.flatMap((o) => [`plan ${o.address}`, `quote ${o.address}`]));
    const parallel = await scenario(4);
    expect(parallel.w.events.slice(0, 4).every((event) => event.startsWith("plan "))).toBe(true);
  });
});
