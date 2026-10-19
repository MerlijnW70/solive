import {
  type Address,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createNoopSigner,
  getTransactionEncoder,
  partiallySignTransactionMessageWithSigners,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  type Instruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { isDevice, type Transport } from "@intent-engine/client";
import { priorityLamports } from "../compute.js";
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

export type LookupTables = Readonly<Record<Address, Address[]>>;

const withTables = <
  T extends Parameters<typeof compressTransactionMessageUsingAddressLookupTables>[0],
>(
  message: T,
  tables?: LookupTables,
) =>
  tables === undefined || Object.keys(tables).length === 0
    ? message
    : compressTransactionMessageUsingAddressLookupTables(message, tables);

export async function transactionSize(
  transport: Transport,
  instructions: readonly Instruction[],
  feePayer: Address,
  tables?: LookupTables,
): Promise<number> {
  const latest = await transport.latestBlockhash();
  const message = withTables(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    ),
    tables,
  );
  return getTransactionEncoder().encode(compileTransaction(message)).length;
}

const withoutDevices = (instructions: readonly Instruction[]): Instruction[] =>
  instructions.map((ix) =>
    ix.accounts === undefined
      ? ix
      : {
          ...ix,
          accounts: ix.accounts.map((meta) =>
            "signer" in meta && typeof meta.signer === "object" && meta.signer !== null && isDevice(meta.signer) ? { ...meta, signer: createNoopSigner(meta.address) } : meta,
          ),
        },
  );

export async function prepare(
  transport: Transport,
  instructions: readonly Instruction[],
  feePayer: Address,
  tables?: LookupTables,
): Promise<Prepared> {
  const budgeted = await transport.budget(withoutDevices(instructions), feePayer, tables);
  const latest = await transport.latestBlockhash();
  const message = withTables(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
      (m) => appendTransactionMessageInstructions(budgeted, m),
    ),
    tables,
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
