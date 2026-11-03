import type { Address } from "@solana/kit";
import { compile, fillInstructions, headroom } from "./build.js";
import { createdRent, signaturesOf, solCost, tooCostly, tooMuchRent } from "./costs.js";
import { ALLOWANCE_SPENT, asked, type Floats, liveStock } from "./float.js";
import { type Hold, unheld } from "./holds.js";
import { netShort } from "./net.js";
import { spend, type Stock, stockLeft } from "./inventory.js";
import { type Caps, type Checked, failed, type Outcome, type Ready, skipped } from "./outcome.js";
import { untipped } from "./order-plan.js";
import type { SolverOptions } from "./types.js";

export const SIMULATION_REFUSED = "the fill failed in simulation, so it was not sent";

export const BALANCES_REFUSED = "the fill would leave the solver with less of a token than planned, so it was not sent";

export const INVENTORY_SPENT = "the solver no longer holds enough of the output token for this fill";

export async function checkOrder(
  o: SolverOptions,
  caps: Caps,
  mintData: (mint: Address) => Promise<Uint8Array | null>,
  ready: Ready,
  stock: Stock,
  floats?: Floats,
): Promise<Outcome | Checked> {
  const { plan, context, tables, probe, latest, solverInput, solverOutput } = ready;
  const address = plan.address;
  const before = await Promise.all([o.chain.tokenAmount(solverInput), o.chain.tokenAmount(solverOutput)]);
  const live = await liveStock(o.chain, o.inventoryOwner, o.solver.address, solverOutput, before[1] ?? 0n);
  const free = unheld(live, o.held?.(solverOutput) ?? 0n);
  const left = stockLeft(stock, solverOutput, free);
  asked(floats, solverOutput, free, plan.required);
  if (plan.route.inventory === true && left < plan.required) {
    return skipped(address, `${o.inventoryOwner === undefined ? INVENTORY_SPENT : ALLOWANCE_SPENT}: ${left} left, ${plan.required} needed`);
  }
  const disagreed = await o.confirm?.(address, [solverInput, solverOutput]);
  if (disagreed !== undefined && disagreed !== null) {
    return skipped(address, disagreed);
  }
  const simulated = await o.simulate(probe, [solverInput, solverOutput]);
  if (simulated.err !== null) {
    return failed(address, `${SIMULATION_REFUSED}: ${simulated.err}`);
  }
  const [inputAfter, outputAfter] = simulated.balances;
  const least =
    plan.route.inventory === true
      ? [(before[0] ?? 0n) + plan.fees.net, (before[1] ?? 0n) - plan.required]
      : [before[0] ?? 0n, (before[1] ?? 0n) + plan.profit];
  if (inputAfter === null || inputAfter === undefined || outputAfter === null || outputAfter === undefined || inputAfter < (least[0] ?? 0n) || outputAfter < (least[1] ?? 0n)) {
    return failed(
      address,
      `${BALANCES_REFUSED}: input ${before[0]} to ${inputAfter}, output ${before[1]} to ${outputAfter}, expected at least ${least[0]} and ${least[1]}`,
    );
  }
  const final = simulated.unitsConsumed === null ? context : { ...context, computeUnits: headroom(simulated.unitsConsumed) };
  const instructions = await fillInstructions(plan, final);
  const wire = simulated.unitsConsumed === null ? probe : await compile(instructions, o.solver, latest, tables);
  const cost = solCost({
    signatures: signaturesOf(wire),
    unitPrice: final.unitPrice,
    computeUnits: final.computeUnits,
    tip: final.tip?.lamports ?? 0n,
  });
  const rent = await createdRent(instructions, (account) => o.chain.exists(account), mintData, caps.rate);
  const kept = rent > 0n ? rent : undefined;
  if (cost > caps.cost) {
    return skipped(address, tooCostly(cost, caps.cost), kept);
  }
  if (rent > caps.rent) {
    return skipped(address, tooMuchRent(rent, caps.rent), kept);
  }
  const short = netShort(plan, o.strategy.minProfit.get(plan.intent.outputMint) ?? 0n, cost, o.strategy.solValue);
  if (short !== null) {
    return skipped(address, short, kept);
  }
  if (wire !== probe) {
    const checked = await o.simulate(wire, [solverInput, solverOutput]);
    if (checked.err !== null) {
      return failed(address, `${SIMULATION_REFUSED}: ${checked.err}`);
    }
  }
  return {
    kind: "checked",
    wire,
    entry: { intent: address, profit: plan.profit, cost, ...(kept === undefined ? {} : { rent: kept }) },
    ...(plan.route.inventory === true ? { holds: { account: solverOutput, amount: plan.required } } : {}),
    spend: () => {
      if (plan.route.inventory === true) {
        spend(stock, solverOutput, free, plan.required);
      }
    },
  };
}

export async function fillOrder(
  o: SolverOptions,
  caps: Caps,
  mintData: (mint: Address) => Promise<Uint8Array | null>,
  ready: Ready,
  stock: Stock,
  floats?: Floats,
): Promise<Outcome> {
  const checked = await checkOrder(o, caps, mintData, ready, stock, floats);
  if (checked.kind !== "checked") {
    return checked;
  }
  const sent = await o.send(checked.wire);
  checked.spend();
  const holds = !sent.confirmed && checked.holds !== undefined ? { holds: checked.holds } : {};
  return { kind: sent.confirmed ? "filled" : "sent", entry: { ...checked.entry, signature: sent.signature, ...holds } };
}

export async function queueOrder(
  o: SolverOptions,
  caps: Caps,
  mintData: (mint: Address) => Promise<Uint8Array | null>,
  ready: Ready,
  stock: Stock,
  floats?: Floats,
): Promise<Outcome | Checked> {
  const bare = await untipped(o, ready);
  if (bare.kind !== "ready") {
    return bare;
  }
  const checked = await checkOrder(o, caps, mintData, bare.ready, stock, floats);
  if (checked.kind === "checked") {
    checked.spend();
  }
  return checked;
}
