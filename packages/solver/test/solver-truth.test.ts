import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Address, isSolanaError, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { type Intent, NATIVE_MINT, splitFees } from "@intent-engine/core";
import {
  backoff,
  firstToSend,
  haltOf,
  NODE_RATE_LIMITED,
  nodeRateLimited,
  netBelowFloor,
  netShort,
  type Plan,
  type SolValue,
  unpricedFloor,
  unpricedFloors,
} from "../src/index.js";
import { fresh, FLOOR, many, order, paying, world } from "./parallel-world.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const PAGE = readFileSync(`${ROOT}/docs/solver.md`, "utf8");

const SDK_BRAND = Symbol.for("@intent-engine/sdk-error");

const clientLimit = (): Error =>
  Object.assign(new Error("the node rate limited getProgramAccounts; read again later"), { name: "RateLimited", code: "rate-limited", [SDK_BRAND]: true });

const httpError = (statusCode: number): SolanaError<typeof SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR> =>
  new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { message: "Too Many Requests", statusCode, headers: new Headers() });

const nodeLimits: [string, () => Error, string][] = [
  ["the client's RateLimited", clientLimit, "the node rate limited getProgramAccounts; read again later"],
  ["a raw 429 from the transport", () => httpError(429), NODE_RATE_LIMITED],
  ["a raw 429 wrapped by another error", () => new Error("could not read the mint", { cause: httpError(429) }), NODE_RATE_LIMITED],
  ["a node reply that says 429", () => new Error("HTTP error (429): Too Many Requests"), NODE_RATE_LIMITED],
];

describe("a node rate limit halts the tick", () => {
  it("recognises the client's RateLimited and a raw 429, and nothing else", () => {
    for (const [, make, reason] of nodeLimits) {
      expect(nodeRateLimited(make())).toBe(true);
      expect(haltOf(make())).toBe(reason);
    }
    for (const other of [
      new Error("market unavailable"),
      new Error("account 4290 is missing"),
      httpError(500),
      new Error("the node answered 500", { cause: httpError(500) }),
      Object.assign(new Error("timed out"), { code: "timed-out", [SDK_BRAND]: true }),
      "429",
    ]) {
      expect(nodeRateLimited(other)).toBe(false);
      expect(haltOf(other)).toBeNull();
    }
    expect(isSolanaError(httpError(429), SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)).toBe(true);
  });

  it.each(nodeLimits)("stops planning on %s, skips the rest and backs no order off", async (_, make, reason) => {
    const { output, orders } = await many(3);
    const w = await world(orders, output);
    w.quote = async () => {
      throw make();
    };
    const held = backoff(5, () => 0);
    const report = await w.run({ concurrency: 1, backoff: held });
    expect(report).toEqual({
      filled: [],
      sent: [],
      skipped: orders.map((o) => ({ intent: o.address, reason })),
      failed: [],
      warnings: [unpricedFloor(output)],
    });
    expect(w.events.filter((event) => event.startsWith("quote "))).toHaveLength(1);
    expect(held.size()).toBe(0);
    for (const { address, intent } of orders) {
      expect(held.waiting(address, intent)).toBeNull();
    }
  });

  it("still backs an order off when its own planning fails for another reason", async () => {
    const { output, orders } = await many(2);
    const w = await world(orders, output);
    w.quote = async (request, found) => {
      if (found === orders[0]) {
        throw new Error("market unavailable");
      }
      return paying(request, 5n);
    };
    const held = backoff(5, () => 0);
    const report = await w.run({ concurrency: 1, backoff: held });
    expect(report.failed).toEqual([{ intent: orders[0]?.address, error: "market unavailable" }]);
    expect(report.filled).toHaveLength(1);
    expect(held.size()).toBe(1);
  });

  it.each(nodeLimits)("stops sending on %s during a fill, skips the rest and backs no order off", async (_, make, reason) => {
    const { output, orders } = await many(3);
    const w = await world(orders, output);
    const held = backoff(5, () => 0);
    const report = await w.run({
      backoff: held,
      simulate: async () => {
        throw make();
      },
    });
    expect(report).toEqual({
      filled: [],
      sent: [],
      skipped: orders.map((o) => ({ intent: o.address, reason })),
      failed: [],
      warnings: [unpricedFloor(output)],
    });
    expect(w.sends).toEqual([]);
    expect(held.size()).toBe(0);
  });
});

const plan = (outputMint: Address, profit: bigint, expiresAt = 1n, address = "11111111111111111111111111111112" as Address): Plan =>
  ({ profit, intent: { outputMint, expiresAt } as Intent, address }) as Plan;

describe("fills are ranked by value", () => {
  it("ranks two mints with different decimals by lamports, and one mint by raw profit", async () => {
    const [cheap, dear] = [await fresh(), await fresh()];
    const values: SolValue = new Map([
      [cheap, { raw: 1_000_000n, lamports: 1n }],
      [dear, { raw: 1n, lamports: 1_000n }],
    ]);
    const lotsOfCheap = plan(cheap, 2_000_000n);
    const fewDear = plan(dear, 50n);
    expect(firstToSend(lotsOfCheap, fewDear)).toBeLessThan(0);
    expect(firstToSend(fewDear, lotsOfCheap, values)).toBeLessThan(0);
    expect(firstToSend(lotsOfCheap, fewDear, values)).toBeGreaterThan(0);
    expect(firstToSend(plan(dear, 51n), fewDear, values)).toBeLessThan(0);
    expect(firstToSend(plan(cheap, 3_000_000n), lotsOfCheap, values)).toBeLessThan(0);
  });

  it("values wrapped SOL at its own lamports and ranks priced mints before unpriced ones", async () => {
    const [priced, unknown] = [await fresh(), await fresh()];
    const values: SolValue = new Map([[priced, { raw: 10n, lamports: 1n }]]);
    expect(firstToSend(plan(NATIVE_MINT, 6n), plan(priced, 50n), values)).toBeLessThan(0);
    expect(firstToSend(plan(NATIVE_MINT, 4n), plan(priced, 50n), values)).toBeGreaterThan(0);
    expect(firstToSend(plan(priced, 1n), plan(unknown, 10n ** 18n), values)).toBeLessThan(0);
    expect(firstToSend(plan(unknown, 10n ** 18n), plan(priced, 1n), values)).toBeGreaterThan(0);
    expect(firstToSend(plan(unknown, 9n), plan(await fresh(), 8n), values)).toBeLessThan(0);
  });

  it("breaks equal values by the soonest expiry and then the lowest address", async () => {
    const mint = await fresh();
    const values: SolValue = new Map([[mint, { raw: 2n, lamports: 1n }]]);
    const low = "11111111111111111111111111111112" as Address;
    const high = "SysvarC1ock11111111111111111111111111111111" as Address;
    expect(firstToSend(plan(mint, 10n, 1n, high), plan(NATIVE_MINT, 5n, 9n, low), values)).toBeLessThan(0);
    expect(firstToSend(plan(mint, 10n, 9n, low), plan(NATIVE_MINT, 5n, 1n, high), values)).toBeGreaterThan(0);
    expect(firstToSend(plan(mint, 10n, 1n, high), plan(NATIVE_MINT, 5n, 1n, low), values)).toBeGreaterThan(0);
  });

  it("sends the most valuable fill first when a tick fills orders in two mints", async () => {
    const [cheapMint, dearMint] = [await fresh(), await fresh()];
    const cheap = await order(cheapMint);
    const dear = await order(dearMint);
    const w = await world([cheap, dear], cheapMint);
    w.quote = async (request, found) => paying(request, found === cheap ? 20_000_000_000n : 50n);
    const strategy = { minProfit: new Map([[cheapMint, FLOOR], [dearMint, FLOOR]]), maxFeeBps: 100 };
    const solValue: SolValue = new Map([
      [cheapMint, { raw: 1_000_000n, lamports: 1n }],
      [dearMint, { raw: 1n, lamports: 1_000n }],
    ]);
    const priced = await w.run({ strategy: { ...strategy, solValue } });
    expect(priced.filled).toHaveLength(2);
    expect(priced.warnings).toBeUndefined();
    expect(w.sends).toEqual([dear.address, cheap.address]);
    w.sends.length = 0;
    const unpriced = await w.run({ strategy });
    expect(unpriced.filled).toHaveLength(2);
    expect(w.sends).toEqual([cheap.address, dear.address]);
    expect(unpriced.warnings).toEqual([unpricedFloor(cheapMint), unpricedFloor(dearMint)]);
  });
});

describe("the cost floor and the mints it can price", () => {
  it("warns for each --min-profit mint that is neither wrapped SOL nor priced", async () => {
    const [priced, unknown] = [await fresh(), await fresh()];
    const floors = new Map<Address, bigint>([[NATIVE_MINT, 1n], [priced, 1n], [unknown, 1n]]);
    const values: SolValue = new Map([[priced, { raw: 1n, lamports: 1n }]]);
    expect(unpricedFloors(floors, values)).toEqual([unpricedFloor(unknown)]);
    expect(unpricedFloors(floors, undefined)).toEqual([unpricedFloor(priced), unpricedFloor(unknown)]);
    expect(unpricedFloors(new Map([[NATIVE_MINT, 1n]]), undefined)).toEqual([]);
    expect(unpricedFloor(unknown)).toContain(`--sol-value ${unknown}=<raw>/<lamports>`);
  });

  it("puts the warning in the tick report only when a floor cannot be priced", async () => {
    const { output, orders } = await many(1);
    const w = await world(orders, output);
    expect((await w.run()).warnings).toEqual([unpricedFloor(output)]);
    const priced = await w.run({ strategy: { minProfit: new Map([[output, FLOOR]]), maxFeeBps: 100, solValue: new Map([[output, { raw: 1n, lamports: 1_000_000n }]]) } });
    expect(priced.warnings).toBeUndefined();
    expect(priced.filled).toHaveLength(1);
  });

  it("nets the documented walkthrough's SOL cost against its profit at the rate the docs state", () => {
    const command = /^intent-engine solve .*$/m.exec(PAGE)?.[0] ?? "";
    const rate = (flag: string): { raw: bigint; lamports: bigint } => {
      const match = new RegExp(`--${flag} (?:"?[1-9A-HJ-NP-Za-km-z]{32,44}:)?\\$TOKEN=(\\d+)/(\\d+)`).exec(command);
      return { raw: BigInt(match?.[1] ?? 0), lamports: BigInt(match?.[2] ?? 0) };
    };
    const issued = rate("issue");
    const valued = rate("sol-value");
    expect(valued.raw).toBeGreaterThan(0n);
    expect(valued).toEqual({ raw: issued.raw, lamports: issued.lamports });
    const floor = BigInt(/--min-profit \$TOKEN=(\d+)/.exec(command)?.[1] ?? 0);
    expect(floor).toBeGreaterThan(0n);
    const net = splitFees(50_000_000n, 5, 0, 0).net;
    expect(net).toBe(49_975_000n);
    const profit = (net * issued.raw) / issued.lamports - 5_000_000_000n;
    expect(profit).toBe(4_995_000_000n);
    const token = "SysvarC1ock11111111111111111111111111111111" as Address;
    const values: SolValue = new Map([[token, valued]]);
    const affordable = ((profit - floor) * valued.lamports) / valued.raw;
    const stake = { intent: { outputMint: token } as Intent, profit };
    expect(netShort(stake, floor, affordable, values)).toBeNull();
    const cost = (affordable + 1n) * valued.raw;
    expect(netShort(stake, floor, affordable + 1n, values)).toBe(netBelowFloor(profit, cost / valued.lamports, affordable + 1n, floor));
    expect(netShort(stake, floor, affordable + 1n, undefined)).toBeNull();
  });
});

describe("the solver doc says what the code does", () => {
  it("ranks by value in lamports and says how unpriced mints rank", () => {
    expect(PAGE).toContain("most valuable first");
    expect(PAGE).toMatch(/Fills in mints without a `--sol-value` come after those, by raw profit/);
  });

  it("nets the SOL cost in the mint the profit is paid in", () => {
    expect(PAGE).toMatch(/profit is paid in the order's output mint/);
  });
});
