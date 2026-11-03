import type { Address, Base64EncodedWireTransaction } from "@solana/kit";
import { DEFAULT_MAX_RENT, DEFAULT_MAX_SOL_COST } from "./costs.js";
import { bundleSizeFits, badBundleSize, sendBundles } from "./bundle.js";
import { MAX_BUNDLE } from "./jito.js";
import { haltOf } from "./halt.js";
import { firstToSend } from "./rank.js";
import { solValueFits, unpricedFloors } from "./net.js";
import { type Stock } from "./inventory.js";
import { type Hold } from "./holds.js";
import { chainRent } from "./rent.js";
import { listingOf } from "./listing.js";
import { type Floats, floatFits, lowOf } from "./float.js";
import { checkOrder, fillOrder, queueOrder } from "./order-send.js";
import { planOrder } from "./order-plan.js";
import { type Checked, failed, messageOf, type Outcome, type Ready, skipped } from "./outcome.js";
import type { Report, SolverOptions } from "./types.js";

export { BACKOFF_MAX_INTERVALS, type Backoff, backingOff, backoff } from "./backoff.js";
export {
  createdRent,
  DEFAULT_MAX_RENT,
  DEFAULT_MAX_SOL_COST,
  LAMPORTS_PER_SIGNATURE,
  MICRO_LAMPORTS_PER_LAMPORT,
  mintExtensions,
  rentExempt,
  type SolCost,
  signaturesOf,
  solCost,
  TOKEN_2022_ACCOUNT_SPACE,
  TOKEN_2022_PROGRAM,
  TOKEN_ACCOUNT_SPACE,
  tokenAccountSpace,
  tooCostly,
  tooMuchRent,
} from "./costs.js";

export { BALANCES_REFUSED, INVENTORY_SPENT, SIMULATION_REFUSED } from "./order-send.js";
export { ROUTE_ACCOUNT_BUDGETS, tooLarge } from "./order-plan.js";
export type { Chain, Report, Sent, Simulated, SolverOptions } from "./types.js";

export const DEFAULT_CONCURRENCY = 4;

export const MAX_CONCURRENCY = 32;

export const badConcurrency = (value: number): string => `concurrency must be an integer from 1 to ${MAX_CONCURRENCY}, not ${value}`;

export const ALREADY_FILLING = "the order already has a fill in this tick";

export async function tick(o: SolverOptions): Promise<Report> {
  const concurrency = o.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new RangeError(badConcurrency(concurrency));
  }
  const bundleSize = o.bundleSize ?? MAX_BUNDLE;
  if (!bundleSizeFits(bundleSize)) {
    throw new RangeError(badBundleSize(bundleSize));
  }
  const invalid = solValueFits(o.strategy.solValue);
  if (invalid !== null) {
    throw new RangeError(invalid);
  }
  const unpriced = unpricedFloors(o.strategy.minProfit, o.strategy.solValue);
  const unfloated = floatFits(o.inventoryOwner, o.solver.address, o.chain);
  if (unfloated !== null) {
    throw new RangeError(unfloated);
  }
  const [config, now, { intents, unreadable }, rate] = await Promise.all([o.chain.config(), o.chain.now(), listingOf(o.chain), chainRent(o.chain)]);
  const caps = { cost: o.maxSolCost ?? DEFAULT_MAX_SOL_COST, rent: o.maxRent ?? DEFAULT_MAX_RENT, rate };
  const mints = new Map<Address, Promise<Uint8Array | null>>();
  const mintData = (mint: Address): Promise<Uint8Array | null> => {
    const known = mints.get(mint);
    if (known !== undefined) {
      return known;
    }
    const loaded = o.chain.mintData?.(mint) ?? Promise.resolve(null);
    mints.set(mint, loaded);
    return loaded;
  };
  const outcomes: (Outcome | undefined)[] = intents.map(() => undefined);
  const readied: ({ index: number; ready: Ready } | undefined)[] = intents.map(() => undefined);
  let limited: string | null = null;
  const work = intents.entries();
  const planner = async (): Promise<void> => {
    while (limited === null) {
      const step = work.next();
      if (step.done === true) {
        return;
      }
      const [index, { address, intent }] = step.value;
      try {
        const result = await planOrder(o, config, now, address, intent);
        if (result.kind === "ready") {
          readied[index] = { index, ready: result.ready };
        } else {
          outcomes[index] = result;
        }
      } catch (error) {
        const stop = haltOf(error);
        if (stop !== null) {
          limited ??= stop;
          outcomes[index] = skipped(address, stop);
        } else {
          outcomes[index] = failed(address, messageOf(error));
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, intents.length) }, planner));
  if (limited !== null) {
    for (const [index, { address }] of work) {
      outcomes[index] = skipped(address, limited);
    }
  }
  const planned = readied.filter((entry) => entry !== undefined).sort((a, b) => firstToSend(a.ready.plan, b.ready.plan, o.strategy.solValue));
  const filling = new Set<Address>();
  const stock: Stock = new Map();
  const floats: Floats | undefined = o.inventoryOwner === undefined ? undefined : new Map();
  const queue: { index: number; ready: Ready; wire: Base64EncodedWireTransaction; entry: Checked["entry"]; holds?: Hold }[] = [];
  let halted: string | null = null;
  for (const { index, ready } of planned) {
    const address = ready.plan.address;
    if (halted !== null) {
      outcomes[index] = skipped(address, halted);
      continue;
    }
    if (filling.has(address)) {
      outcomes[index] = skipped(address, ALREADY_FILLING);
      continue;
    }
    filling.add(address);
    try {
      if (o.sendBundle === undefined) {
        outcomes[index] = await fillOrder(o, caps, mintData, ready, stock, floats);
      } else {
        const checked = await queueOrder(o, caps, mintData, ready, stock, floats);
        if (checked.kind === "checked") {
          queue.push({ index, ready, wire: checked.wire, entry: checked.entry, ...(checked.holds === undefined ? {} : { holds: checked.holds }) });
        } else {
          outcomes[index] = checked;
        }
      }
    } catch (error) {
      const stop = haltOf(error);
      if (stop !== null) {
        halted = stop;
        outcomes[index] = skipped(address, halted);
      } else {
        outcomes[index] = failed(address, messageOf(error));
      }
    }
  }
  if (o.sendBundle !== undefined) {
    const last = async (item: (typeof queue)[number]): Promise<Base64EncodedWireTransaction | Outcome> => {
      const { ready, wire } = item;
      if (o.tip === null) {
        return wire;
      }
      try {
        const checked = await checkOrder(o, caps, mintData, ready, new Map());
        if (checked.kind !== "checked") {
          return checked;
        }
        item.entry = checked.entry;
        return checked.wire;
      } catch (error) {
        const stop = haltOf(error);
        return stop === null ? failed(ready.plan.address, messageOf(error)) : skipped(ready.plan.address, stop);
      }
    };
    for (const done of await sendBundles(queue, bundleSize, o.sendBundle, last)) {
      outcomes[done.item.index] =
        "refused" in done
          ? done.refused
          : "error" in done
            ? failed(done.item.ready.plan.address, done.error)
            : { kind: "sent", entry: { ...done.item.entry, signature: done.signature, ...(done.item.holds === undefined ? {} : { holds: done.item.holds }) } };
    }
  }
  const report: Report = { filled: [], sent: [], skipped: unreadable.map(({ address, reason }) => ({ intent: address, reason })), failed: [] };
  for (const outcome of outcomes) {
    if (outcome?.kind === "skipped") {
      report.skipped.push(outcome.entry);
    } else if (outcome?.kind === "failed") {
      report.failed.push(outcome.entry);
    } else if (outcome !== undefined) {
      report[outcome.kind].push(outcome.entry);
    }
  }
  Object.assign(report, lowOf(floats, stock));
  if (unpriced.length > 0) {
    report.warnings = unpriced;
  }
  if (o.backoff !== undefined) {
    const known = new Map(intents.map(({ address, intent }) => [address, intent]));
    for (const { intent } of report.failed) {
      const state = known.get(intent);
      if (state !== undefined) {
        o.backoff.failed(intent, state);
      }
    }
    for (const { intent } of report.filled) {
      o.backoff.succeeded(intent);
    }
  }
  return report;
}
