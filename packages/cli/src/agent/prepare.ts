import {
  type Address,
  appendTransactionMessageInstructions,
  compileTransaction,
  getTransactionEncoder,
  partiallySignTransactionMessageWithSigners,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  type Instruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { priorityLamports } from "../compute.js";
import type { Transport } from "../transport.js";
import { LOG_LINE_LIMIT, LOG_TAIL, SimulationFailed, simulationProblem, untrusted } from "./problems.js";

export type Prepared = {
  transaction: string;
  instructions: Instruction[];
  priorityLamports: bigint;
  feePayer: Address;
  signers: Address[];
  lastValidBlockHeight: bigint;
  unitsConsumed: bigint | null;
  logs: string[];
};

export async function transactionSize(
  transport: Transport,
  instructions: readonly Instruction[],
  feePayer: Address,
): Promise<number> {
  const latest = await transport.latestBlockhash();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return getTransactionEncoder().encode(compileTransaction(message)).length;
}

export async function prepare(
  transport: Transport,
  instructions: readonly Instruction[],
  feePayer: Address,
): Promise<Prepared> {
  const budgeted = await transport.budget(instructions, feePayer);
  const latest = await transport.latestBlockhash();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstructions(budgeted, m),
  );
  const compiled = await partiallySignTransactionMessageWithSigners(message);
  const transaction = getBase64EncodedWireTransaction(compiled);
  const simulation = await transport.simulate(transaction);
  if (simulation.err !== null) {
    throw new SimulationFailed(simulationProblem(simulation.err, simulation.logs));
  }
  return {
    transaction,
    instructions: budgeted,
    priorityLamports: priorityLamports(budgeted),
    feePayer,
    signers: Object.entries(compiled.signatures)
      .filter(([, signature]) => signature === null)
      .map(([signer]) => signer as Address),
    lastValidBlockHeight: latest.lastValidBlockHeight,
    unitsConsumed: simulation.unitsConsumed,
    logs: simulation.logs.slice(-LOG_TAIL).map((line) => untrusted(line).slice(0, LOG_LINE_LIMIT)),
  };
}
