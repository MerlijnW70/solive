import type { Address, Base64EncodedWireTransaction, Blockhash, Instruction, TransactionSigner } from "@solana/kit";
import { type Config, findAssociatedTokenAddress, type Intent } from "@intent-engine/core";
import {
  accountsOf,
  bytesFit,
  compile,
  type FillContext,
  fillInstructions,
  headroom,
  locksFit,
  lookupTablesOf,
  MAX_COMPUTE_UNITS,
  MAX_TX_ACCOUNTS,
  PACKET_DATA_SIZE,
  payoutAccounts,
  type Tip,
  wireSize,
} from "./build.js";
import { RateLimited } from "./jupiter.js";
import type { Pricer } from "./market.js";
import { decide, type Plan, standing, type Strategy } from "./plan.js";

export type Chain = {
  config(): Promise<Config>;
  intents(): Promise<{ address: Address; intent: Intent }[]>;
  now(): Promise<bigint>;
  tokenProgram(mint: Address): Promise<Address>;
  exists(address: Address): Promise<boolean>;
  lookupTables(addresses: readonly Address[]): Promise<Record<Address, Address[]>>;
  blockhash(): Promise<{ blockhash: Blockhash; lastValidBlockHeight: bigint }>;
  tokenAmount(address: Address): Promise<bigint>;
};

export type Simulated = { err: string | null; unitsConsumed: bigint | null; balances: readonly (bigint | null)[] };

export type Sent = { signature: string; confirmed: boolean };

export type SolverOptions = {
  chain: Chain;
  pricer: Pricer;
  solver: TransactionSigner;
  strategy: Strategy;
  tip: Tip | null;
  lookupTables?: readonly Address[];
  unitPrice(instructions: readonly Instruction[]): Promise<bigint>;
  simulate(wire: Base64EncodedWireTransaction, watch: readonly Address[]): Promise<Simulated>;
  send(wire: Base64EncodedWireTransaction): Promise<Sent>;
};

export type Report = {
  filled: { intent: Address; profit: bigint; signature: string }[];
  sent: { intent: Address; profit: bigint; signature: string }[];
  skipped: { intent: Address; reason: string }[];
  failed: { intent: Address; error: string }[];
};

export const SIMULATION_REFUSED = "the fill failed in simulation, so it was not sent";

export const BALANCES_REFUSED = "the fill would leave the solver with less of a token than planned, so it was not sent";

export const ROUTE_ACCOUNT_BUDGETS = [40, 30, 20] as const;

export const tooLarge = (bytes: number | null, accounts: number): string =>
  `even the smallest route makes the fill ${bytes === null ? "lock" : `${bytes} bytes with`} ${accounts} accounts; a transaction holds ${PACKET_DATA_SIZE} bytes and ${MAX_TX_ACCOUNTS} accounts`;

export async function tick(o: SolverOptions): Promise<Report> {
  const report: Report = { filled: [], sent: [], skipped: [], failed: [] };
  const [config, now, intents] = await Promise.all([o.chain.config(), o.chain.now(), o.chain.intents()]);
  let limited: string | null = null;
  for (const { address, intent } of intents) {
    if (limited !== null) {
      report.skipped.push({ intent: address, reason: limited });
      continue;
    }
    const ready = standing(intent, config, now, o.strategy);
    if (typeof ready === "string") {
      report.skipped.push({ intent: address, reason: ready });
      continue;
    }
    try {
      const inputTokenProgram = await o.chain.tokenProgram(intent.inputMint);
      const payable = async (draft: Parameters<typeof payoutAccounts>[0]) => {
        const missing = [];
        for (const payout of await payoutAccounts(draft, config.feeRecipient, inputTokenProgram)) {
          if (!(await o.chain.exists(payout.address))) {
            missing.push(payout.name);
          }
        }
        return missing.length === 0 ? null : `no ${missing.join(" or ")} account to pay into`;
      };
      const solverInput = await findAssociatedTokenAddress({
        owner: o.solver.address,
        mint: intent.inputMint,
        tokenProgram: inputTokenProgram,
      });
      const outputTokenProgram = await o.chain.tokenProgram(intent.outputMint);
      const solverOutput = await findAssociatedTokenAddress({
        owner: o.solver.address,
        mint: intent.outputMint,
        tokenProgram: outputTokenProgram,
      });
      const draft: FillContext = {
        solver: o.solver,
        feeRecipient: config.feeRecipient,
        inputTokenProgram,
        outputTokenProgram,
        computeUnits: MAX_COMPUTE_UNITS,
        unitPrice: 0n,
        createSolverInput: !(await o.chain.exists(solverInput)),
        createSolverOutput: !(await o.chain.exists(solverOutput)),
        tip: o.tip,
      };
      let fitting: { plan: Plan; context: FillContext; tables: Record<Address, Address[]>; probe: Base64EncodedWireTransaction } | null =
        null;
      let skipped: string | null = null;
      let size: { bytes: number | null; accounts: number } = { bytes: null, accounts: 0 };
      const latest = await o.chain.blockhash();
      for (const routeAccounts of ROUTE_ACCOUNT_BUDGETS) {
        const decision = await decide(address, intent, config, now, o.pricer, o.solver.address, { ...o.strategy, routeAccounts }, payable);
        if (decision.kind === "skip") {
          skipped = decision.reason;
          break;
        }
        const plan = decision.plan;
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
          fitting = { plan, context, tables, probe };
          break;
        }
      }
      if (skipped !== null || fitting === null) {
        report.skipped.push({ intent: address, reason: skipped ?? tooLarge(size.bytes, size.accounts) });
        continue;
      }
      const { plan, context, tables, probe } = fitting;
      const before = [await o.chain.tokenAmount(solverInput), await o.chain.tokenAmount(solverOutput)];
      const simulated = await o.simulate(probe, [solverInput, solverOutput]);
      if (simulated.err !== null) {
        report.failed.push({ intent: address, error: `${SIMULATION_REFUSED}: ${simulated.err}` });
        continue;
      }
      const [inputAfter, outputAfter] = simulated.balances;
      const least = [before[0] ?? 0n, (before[1] ?? 0n) + plan.profit];
      if (inputAfter === null || inputAfter === undefined || outputAfter === null || outputAfter === undefined || inputAfter < (least[0] ?? 0n) || outputAfter < (least[1] ?? 0n)) {
        report.failed.push({
          intent: address,
          error: `${BALANCES_REFUSED}: input ${before[0]} to ${inputAfter}, output ${before[1]} to ${outputAfter}, expected at least ${least[0]} and ${least[1]}`,
        });
        continue;
      }
      const wire =
        simulated.unitsConsumed === null
          ? probe
          : await compile(
              await fillInstructions(plan, { ...context, computeUnits: headroom(simulated.unitsConsumed) }),
              o.solver,
              latest,
              tables,
            );
      const sent = await o.send(wire);
      (sent.confirmed ? report.filled : report.sent).push({ intent: address, profit: plan.profit, signature: sent.signature });
    } catch (error) {
      if (error instanceof RateLimited) {
        limited = error.message;
        report.skipped.push({ intent: address, reason: limited });
        continue;
      }
      report.failed.push({ intent: address, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
}
