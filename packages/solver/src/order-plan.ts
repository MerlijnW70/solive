import type { Address } from "@solana/kit";
import { type Config, findAssociatedTokenAddress, type Intent } from "@intent-engine/core";
import { backingOff } from "./backoff.js";
import {
  accountsOf,
  bytesFit,
  compile,
  type FillContext,
  fillInstructions,
  locksFit,
  lookupTablesOf,
  MAX_COMPUTE_UNITS,
  MAX_TX_ACCOUNTS,
  PACKET_DATA_SIZE,
  payoutAccounts,
  wireSize,
} from "./build.js";
import { withoutTip } from "./bundle.js";
import { INVENTORY_ONLY, ownIntent } from "./float.js";
import { decide, standing } from "./plan.js";
import { freshly, fromCache } from "./quote-cache.js";
import { type Planned, type Ready, skipped } from "./outcome.js";
import type { SolverOptions } from "./types.js";

export const ROUTE_ACCOUNT_BUDGETS = [40, 30, 20] as const;

export const tooLarge = (bytes: number | null, accounts: number): string =>
  `even the smallest route makes the fill ${bytes === null ? "lock" : `${bytes} bytes with`} ${accounts} accounts; a transaction holds ${PACKET_DATA_SIZE} bytes and ${MAX_TX_ACCOUNTS} accounts`;

export async function planOrder(o: SolverOptions, config: Config, now: bigint, address: Address, intent: Intent): Promise<Planned> {
  const ready = standing(intent, config, now, o.strategy);
  if (typeof ready === "string") {
    return skipped(address, ready);
  }
  const waiting = o.backoff?.waiting(address, intent) ?? null;
  if (waiting !== null) {
    return skipped(address, backingOff(waiting.failures, waiting.seconds));
  }
  const [inputTokenProgram, outputTokenProgram] = await Promise.all([o.chain.tokenProgram(intent.inputMint), o.chain.tokenProgram(intent.outputMint)]);
  const payable = async (draft: Parameters<typeof payoutAccounts>[0]) => {
    const payouts = await payoutAccounts(draft, config.feeRecipient, inputTokenProgram);
    const found = await Promise.all(payouts.map((payout) => o.chain.exists(payout.address)));
    const missing = payouts.filter((_, i) => !found[i]).map((payout) => payout.name);
    return missing.length === 0 ? null : `no ${missing.join(" or ")} account to pay into`;
  };
  const holder = o.inventoryOwner ?? o.solver.address;
  const solverInput = await findAssociatedTokenAddress({ owner: holder, mint: intent.inputMint, tokenProgram: inputTokenProgram });
  const solverOutput = await findAssociatedTokenAddress({ owner: holder, mint: intent.outputMint, tokenProgram: outputTokenProgram });
  const own = ownIntent(o.inventoryOwner, intent, solverOutput);
  if (own !== null) {
    return skipped(address, own);
  }
  const [inputExists, outputExists, latest] = await Promise.all([
    o.chain.exists(solverInput),
    o.chain.exists(solverOutput),
    o.chain.blockhash(),
  ]);
  const draft: FillContext = {
    solver: o.solver,
    feeRecipient: config.feeRecipient,
    inputTokenProgram,
    outputTokenProgram,
    computeUnits: MAX_COMPUTE_UNITS,
    unitPrice: 0n,
    createSolverInput: !inputExists,
    createSolverOutput: !outputExists,
    tip: o.tip,
    ...(o.inventoryOwner === undefined ? {} : { inventoryOwner: o.inventoryOwner }),
  };
  o.planned?.(address);
  let size: { bytes: number | null; accounts: number } = { bytes: null, accounts: 0 };
  for (const routeAccounts of ROUTE_ACCOUNT_BUDGETS) {
    const budget = { ...o.strategy, routeAccounts };
    const first = await decide(address, intent, config, now, o.pricer, o.solver.address, budget, payable);
    const decision =
      first.kind === "fill" && fromCache(first.plan.route)
        ? await decide(address, intent, config, now, freshly(o.pricer), o.solver.address, budget, payable)
        : first;
    if (decision.kind === "skip") {
      return skipped(address, decision.reason);
    }
    const plan = decision.plan;
    if (o.inventoryOwner !== undefined && (plan.route.inventory !== true || plan.arbitrage !== null)) {
      return skipped(address, INVENTORY_ONLY);
    }
    const context = { ...draft, unitPrice: await o.unitPrice(await fillInstructions(plan, draft)) };
    const instructions = await fillInstructions(plan, context);
    const accounts = accountsOf(instructions, o.solver.address);
    if (!locksFit(accounts)) {
      size = { bytes: null, accounts };
      continue;
    }
    const tables = await o.chain.lookupTables(lookupTablesOf(plan, o.lookupTables));
    const probe = await compile(instructions, o.solver, latest, tables);
    const bytes = wireSize(probe);
    size = { bytes, accounts };
    if (bytesFit(bytes)) {
      return { kind: "ready", ready: { plan, context, tables, probe, latest, solverInput, solverOutput } };
    }
  }
  return skipped(address, tooLarge(size.bytes, size.accounts));
}

export async function untipped(o: SolverOptions, ready: Ready): Promise<Planned> {
  if (ready.context.tip === null) {
    return { kind: "ready", ready };
  }
  const bare = await withoutTip(ready.plan, ready.context, o.solver, ready.latest, ready.tables, o.unitPrice);
  return "probe" in bare ? { kind: "ready", ready: { ...ready, ...bare } } : skipped(ready.plan.address, tooLarge(bare.bytes, bare.accounts));
}
