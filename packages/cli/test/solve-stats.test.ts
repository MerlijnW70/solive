import {
  type Address,
  type Base64EncodedWireTransaction,
  type Blockhash,
  generateKeyPairSigner,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Config, type Intent, IntentStatus, Kind } from "@intent-engine/core";
import { encodeParams } from "@intent-engine/core/internal";
import type { Chain, Pricer, Quote, SolverOptions } from "@intent-engine/solver";
import type { ProgramAccount } from "@intent-engine/client";
import { parse, UsageError } from "../src/args.js";
import { type SolveCommand, watchSolveWith, type WatchTransport } from "../src/solve-commands.js";
import { skipCounts, skipKey, tally } from "../src/solve-stats.js";

const KEY = "11111111111111111111111111111112" as Address;
const NOW = 1_700_000_000n;
const AMOUNT = 100_000n;
const MIN_OUT = 90_000n;
const PLENTY = 10n ** 18n;
const QUOTE_MS = 7;

type Order = { address: Address; intent: Intent };

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
      version: 2,
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
      feeBps: 5,
      gap: new Uint8Array(2),
      mandateSerial: 0n,
      agentFee: 0n,
      claims: 0,
      gap2: new Uint8Array(7),
      capped: 0n,
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
  version: 2,
  bump: 255,
  kindFeeMask: 0,
  partnerCutBps: 0,
  domain: new Uint8Array(32),
  fillDisabledKinds: 0n,
  kindFeeBps: [0, 0, 0, 0],
  crankBounty: 0,
  createFee: 0,
  capsRequired: 0,
  padding: new Uint8Array(3),
  announceFee: 0,
  floorMints: [],
  floorAmounts: [],
});

const MINT = "So11111111111111111111111111111111111111112" as Address;

const SOLVE = ["solve", "--keypair", "k", "--jupiter", "https://" + "q.example", "--min-profit", `${MINT}=1`];

function usage(argv: string[]): string {
  try {
    parse(argv, {});
  } catch (error) {
    if (error instanceof UsageError) {
      return error.message;
    }
    throw error;
  }
  throw new Error("no usage error");
}

type Market = {
  orders: Order[];
  named: Record<"sent" | "filled" | "noRoute" | "short1" | "short2" | "old7" | "old9" | "refused", Order>;
  options: SolverOptions;
  transport: WatchTransport;
  seen: { asked: number; sends: Address[] };
};

const clock = { ms: 0 };

async function market(): Promise<Market> {
  const output = await fresh();
  const solver = await generateKeyPairSigner();
  const feeRecipient = await fresh();
  const blockhash = (await fresh()) as unknown as Blockhash;
  const named = {
    sent: await order(output),
    filled: await order(output),
    noRoute: await order(output),
    short1: await order(output),
    short2: await order(output),
    old7: await order(output, { version: 7 }),
    old9: await order(output, { version: 9 }),
    refused: await order(output),
  };
  const orders = Object.values(named);
  const byMint = new Map(orders.map((o) => [o.intent.inputMint, o]));
  const intentOf = (wire: Base64EncodedWireTransaction): Order => {
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
    const keys = getCompiledTransactionMessageDecoder().decode(tx.messageBytes).staticAccounts;
    const found = orders.find((o) => keys.includes(o.intent.inputMint));
    if (found === undefined) {
      throw new Error("the wire fills no known order");
    }
    return found;
  };
  const paying = (amountIn: bigint, amountOut: bigint): Quote => ({ amountIn, amountOut, instructions: [], lookupTables: [] });
  const seen = { asked: 0, sends: [] as Address[] };
  const pricer: Pricer = {
    quote: async (request) => {
      seen.asked += 1;
      clock.ms += QUOTE_MS;
      const found = byMint.get(request.inputMint);
      if (found === named.noRoute) {
        return null;
      }
      if (found === named.short1) {
        return paying(request.amountIn, MIN_OUT - 1n);
      }
      if (found === named.short2) {
        return paying(request.amountIn, MIN_OUT - 20n);
      }
      return paying(request.amountIn, MIN_OUT + (found === named.filled ? 9n : 5n));
    },
  };
  const chain: Chain = {
    config: async () => config(feeRecipient),
    intents: async () => orders,
    now: async () => NOW,
    tokenProgram: async () => TOKEN_PROGRAM_ADDRESS,
    exists: async () => true,
    lookupTables: async () => ({}),
    blockhash: async () => ({ blockhash, lastValidBlockHeight: 0n }),
    tokenAmount: async () => 0n,
  };
  const options: SolverOptions = {
    chain,
    pricer,
    solver,
    strategy: { minProfit: new Map([[output, 2n]]), maxFeeBps: 100 },
    tip: null,
    unitPrice: async () => 0n,
    simulate: async (wire) => ({ err: intentOf(wire) === named.refused ? "refused" : null, unitsConsumed: null, balances: [PLENTY, PLENTY] }),
    send: async (wire) => {
      const found = intentOf(wire);
      seen.sends.push(found.address);
      return { signature: "signature-" + found.address, confirmed: found === named.filled };
    },
  };
  const transport: WatchTransport = {
    submitWire: async () => {
      throw new Error("watch sends through the bundle stub");
    },
    getAccounts: async (addresses) => addresses.map(() => null),
  };
  return { orders, named, options, transport, seen };
}

async function watched(m: Market, flags: string[], rounds: (ProgramAccount[] | null)[]): Promise<object[]> {
  const command = parse([...SOLVE, "--jito", "https://" + "jito.example", "--watch", "--interval", "3", ...flags], {}) as SolveCommand;
  const lines: object[] = [];
  const waits = [...rounds];
  await watchSolveWith(
    command,
    3,
    {
      now: () => NOW,
      intentChanges: () => ({ wait: async () => waits.shift() ?? null, close: () => undefined }),
    },
    m.transport,
    m.options,
    (line) => lines.push(JSON.parse(JSON.stringify(line, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v)))),
  );
  return lines;
}

const SHORT = "the route pays #, less than the # the intent requires";
const OLD = "unsupported intent version #";
const WAITING = "# fill of this intent failed in a row; it is tried again in # seconds";
const unreadable = (address: Address): ProgramAccount[] => [{ address, data: new Uint8Array([1, 2, 3]) }];

describe("solve --watch --stats", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("needs --watch and is off unless asked for", () => {
    expect(usage([...SOLVE, "--stats"])).toBe("--stats needs --watch");
    expect(parse([...SOLVE, "--watch", "--stats"], {})).toMatchObject({ stats: true });
    expect(parse([...SOLVE, "--watch"], {})).not.toHaveProperty("stats");
    expect(parse(SOLVE, {})).not.toHaveProperty("stats");
  });

  it("gives skip reasons that differ only in numbers one key", () => {
    expect(skipKey("the route pays 89999, less than the 90000 the intent requires")).toBe(SHORT);
    expect(skipKey("no route")).toBe("no route");
    expect(skipCounts([{ reason: "unsupported intent version 7" }, { reason: "unsupported intent version 12" }, { reason: "expired" }])).toEqual({
      [OLD]: 2,
      expired: 1,
    });
    expect(skipCounts([])).toEqual({});
  });

  it("counts each scan's own quotes, cache hits and failures, with the cache ttl in seconds", async () => {
    const clock = { ms: 0 };
    const quote: Quote = { amountIn: 1n, amountOut: 2n, instructions: [], lookupTables: [] };
    const counted = tally({ quote: async () => quote }, 2, () => clock.ms);
    const request = { inputMint: KEY, outputMint: KEY, amountIn: 1n, taker: KEY };
    const report = { filled: [], sent: [], skipped: [{ intent: KEY, reason: "no route" }], failed: [{ intent: KEY, error: "x" }] };
    const first = counted.mark();
    await counted.pricer.quote(request);
    clock.ms = 1_500;
    await counted.pricer.quote(request);
    counted.planned(KEY);
    expect(first({ orders: 3, report, lost: 2, ms: 7 })).toStrictEqual({ orders: 3, planned: 1, quotes: 1, cached: 1, filled: 0, sent: 0, failed: 3, skipped: { "no route": 1 }, ms: 7 });
    const second = counted.mark();
    await counted.pricer.quote(request);
    expect(second({ orders: 1, report, lost: 0, ms: 1 })).toStrictEqual({ orders: 1, planned: 0, quotes: 0, cached: 1, filled: 0, sent: 0, failed: 1, skipped: { "no route": 1 }, ms: 1 });
    clock.ms = 3_600;
    await counted.pricer.quote(request);
    expect(second({ orders: 1, report, lost: 0, ms: 1 })).toMatchObject({ quotes: 1, cached: 1 });
  });

  it("prints one stats line per full scan, none for a changed-only scan, with counts that match the scan", async () => {
    clock.ms = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock.ms);
    const m = await market();
    const lines = await watched(m, ["--stats"], [unreadable(m.named.old7.address), []]);
    const stats = lines.filter((line) => "stats" in line);
    expect(stats).toEqual([
      {
        at: String(NOW),
        scan: "full",
        stats: { orders: 8, planned: 6, quotes: 6, cached: 0, filled: 1, sent: 1, failed: 1, skipped: { "no route": 1, [SHORT]: 2, [OLD]: 2 }, ms: 6 * QUOTE_MS },
      },
      {
        at: String(NOW),
        scan: "full",
        stats: { orders: 8, planned: 4, quotes: 1, cached: 4, filled: 1, sent: 0, failed: 0, skipped: { "no route": 1, [SHORT]: 2, [OLD]: 2, [WAITING]: 1 }, ms: QUOTE_MS },
      },
    ]);
    expect(lines.filter((line) => "unreadable" in line)).toEqual([{ at: String(NOW), scan: "changed", unreadable: [{ intent: m.named.old7.address, reason: "the data is not an engine intent account" }] }]);
    expect(m.seen.asked).toBe(7);
  });

  it("prints no stats without --stats and fills and sends the same either way", async () => {
    clock.ms = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock.ms);
    const counted = await market();
    const plain = await market();
    const withStats = await watched(counted, ["--stats"], [[]]);
    const without = await watched(plain, [], [[]]);
    expect(without.filter((line) => "stats" in line)).toEqual([]);
    expect(withStats.filter((line) => "stats" in line)).toHaveLength(2);
    const named = (m: Market, lines: object[]): unknown => {
      let text = JSON.stringify(lines.filter((line) => !("stats" in line)));
      m.orders.forEach((o, i) => {
        text = text.replaceAll(o.address, "order" + i);
      });
      return JSON.parse(text);
    };
    expect(named(plain, without)).toEqual(named(counted, withStats));
    expect(without).toHaveLength(2);
    const which = (m: Market) => m.seen.sends.map((address) => m.orders.findIndex((o) => o.address === address));
    expect(which(plain)).toEqual(which(counted));
    expect(which(plain)).toEqual([1, 0, 1]);
    expect([plain.seen.asked, counted.seen.asked]).toEqual([7, 7]);
  });
});
