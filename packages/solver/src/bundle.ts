import type { Address, Base64EncodedWireTransaction, Blockhash, Instruction, TransactionSigner } from "@solana/kit";
import { accountsOf, bytesFit, compile, type FillContext, fillInstructions, locksFit, wireSize } from "./build.js";
import { MAX_BUNDLE } from "./jito.js";
import type { Plan } from "./plan.js";

export const badBundleSize = (value: number): string => `bundle size must be an integer from 1 to ${MAX_BUNDLE}, not ${value}`;

export const bundleSizeFits = (value: number): boolean => Number.isInteger(value) && value >= 1 && value <= MAX_BUNDLE;

export async function withoutTip(
  plan: Plan,
  tipped: FillContext,
  solver: TransactionSigner,
  latest: { blockhash: Blockhash; lastValidBlockHeight: bigint },
  tables: Readonly<Record<Address, Address[]>>,
  unitPrice: (instructions: readonly Instruction[]) => Promise<bigint>,
): Promise<{ context: FillContext; probe: Base64EncodedWireTransaction } | { bytes: number | null; accounts: number }> {
  const bare = { ...tipped, tip: null, unitPrice: 0n };
  const context = { ...bare, unitPrice: await unitPrice(await fillInstructions(plan, bare)) };
  const instructions = await fillInstructions(plan, context);
  const accounts = accountsOf(instructions, solver.address);
  if (!locksFit(accounts)) {
    return { bytes: null, accounts };
  }
  const probe = await compile(instructions, solver, latest, tables);
  const bytes = wireSize(probe);
  return bytesFit(bytes) ? { context, probe } : { bytes, accounts };
}

export type Bundled<T, O> = { item: T; signature: string } | { item: T; error: string } | { item: T; refused: O };

export async function sendBundles<T extends { wire: Base64EncodedWireTransaction }, O extends object>(
  queue: readonly T[],
  size: number,
  sendBundle: (wires: readonly Base64EncodedWireTransaction[]) => Promise<string>,
  last: (item: T) => Promise<Base64EncodedWireTransaction | O>,
): Promise<Bundled<T, O>[]> {
  if (!bundleSizeFits(size)) {
    throw new RangeError(badBundleSize(size));
  }
  const done: Bundled<T, O>[] = [];
  for (const bundle of queue.flatMap((_, at) => (at % size === 0 ? [queue.slice(at, at + size)] : []))) {
    const wires = bundle.map((item) => item.wire);
    for (let tail = bundle.at(-1); tail !== undefined; tail = bundle.at(-1)) {
      const wire = await last(tail);
      if (typeof wire === "string") {
        wires[wires.length - 1] = wire;
        break;
      }
      done.push({ item: tail, refused: wire });
      bundle.pop();
      wires.pop();
    }
    if (bundle.length === 0) {
      continue;
    }
    try {
      const signature = await sendBundle(wires);
      done.push(...bundle.map((item) => ({ item, signature })));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      done.push(...bundle.map((item) => ({ item, error: message })));
    }
  }
  return done;
}
