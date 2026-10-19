import {
  type Address,
  appendTransactionMessageInstructions,
  getBase64Encoder,
  type Base64EncodedWireTransaction,
  type Blockhash,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  type Instruction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type TransactionSigner,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { getCreateAssociatedTokenIdempotentInstructionAsync } from "@solana-program/token";
import {
  buildFlashFill,
  computeUnitLimit,
  computeUnitPrice,
  findAssociatedTokenAddress,
  findConfigPda,
  findEventAuthorityPda,
  INSTRUCTIONS_SYSVAR_ADDRESS,
} from "@intent-engine/core";
import { JITO_TIP_ACCOUNTS } from "./jito.js";
import type { Plan } from "./plan.js";

export {
  COMPUTE_BUDGET_ADDRESS,
  computeUnitLimit,
  computeUnitPrice,
  headroom,
  MAX_COMPUTE_UNITS,
  MAX_MICRO_LAMPORTS,
  UNIT_HEADROOM_DIVISOR,
  UNIT_HEADROOM_FLOOR,
} from "@intent-engine/core";

export type Tip = { account: Address; lamports: bigint };

export type FillContext = {
  solver: TransactionSigner;
  feeRecipient: Address;
  inputTokenProgram: Address;
  outputTokenProgram: Address;
  computeUnits: number;
  unitPrice: bigint;
  createSolverInput: boolean;
  createSolverOutput: boolean;
  tip: Tip | null;
  inventoryOwner?: Address;
};

export async function payoutAccounts(
  plan: Pick<Plan, "intent" | "fees">,
  feeRecipient: Address,
  inputTokenProgram: Address,
): Promise<{ name: string; address: Address }[]> {
  const intent = plan.intent;
  const owners = [
    ...(plan.fees.protocol > 0n ? [{ name: "fee", owner: feeRecipient }] : []),
    ...(plan.fees.partner > 0n ? [{ name: "partner", owner: intent.partner }] : []),
    ...(intent.agentFee > 0n ? [{ name: "agent", owner: intent.rentPayer }] : []),
  ];
  return Promise.all(
    owners.map(async ({ name, owner }) => ({
      name,
      address: await findAssociatedTokenAddress({ owner, mint: intent.inputMint, tokenProgram: inputTokenProgram }),
    })),
  );
}

export async function fillInstructions(plan: Plan, ctx: FillContext): Promise<Instruction[]> {
  const intent = plan.intent;
  const owner = ctx.inventoryOwner ?? ctx.solver.address;
  const solverInput = await findAssociatedTokenAddress({
    owner,
    mint: intent.inputMint,
    tokenProgram: ctx.inputTokenProgram,
  });
  const solverOutput = await findAssociatedTokenAddress({
    owner,
    mint: intent.outputMint,
    tokenProgram: ctx.outputTokenProgram,
  });
  const flash = await buildFlashFill({
    solver: ctx.solver,
    owner: intent.owner,
    nonce: intent.nonce,
    inputMint: intent.inputMint,
    outputMint: intent.outputMint,
    inputTokenProgram: ctx.inputTokenProgram,
    outputTokenProgram: ctx.outputTokenProgram,
    receiver: intent.receiver,
    solverInput,
    solverOutput,
    ...(plan.fees.protocol > 0n ? { feeRecipient: ctx.feeRecipient } : {}),
    ...(plan.fees.partner > 0n ? { partner: intent.partner } : {}),
    mandate: intent.mandate,
    ...(intent.agentFee > 0n ? { agent: intent.rentPayer } : {}),
    amountIn: plan.amountIn,
    amountOut: plan.required,
    maxFeeBps: plan.feeBps + intent.partnerBps,
    prefix: [
      computeUnitLimit(ctx.computeUnits),
      ...(ctx.unitPrice > 0n ? [computeUnitPrice(ctx.unitPrice)] : []),
      ...(ctx.createSolverInput
        ? [
            await getCreateAssociatedTokenIdempotentInstructionAsync({
              payer: ctx.solver,
              owner,
              mint: intent.inputMint,
              tokenProgram: ctx.inputTokenProgram,
            }),
          ]
        : []),
      ...(ctx.createSolverOutput
        ? [
            await getCreateAssociatedTokenIdempotentInstructionAsync({
              payer: ctx.solver,
              owner,
              mint: intent.outputMint,
              tokenProgram: ctx.outputTokenProgram,
            }),
          ]
        : []),
    ],
    route: [...plan.route.instructions, ...(plan.arbitrage?.instructions ?? [])],
  });
  const tip =
    ctx.tip === null
      ? []
      : [getTransferSolInstruction({ source: ctx.solver, destination: ctx.tip.account, amount: ctx.tip.lamports })];
  return [...flash, ...tip];
}

export function lookupTablesOf(plan: Plan, own: readonly Address[] = []): Address[] {
  return [...new Set([...own, ...plan.route.lookupTables, ...(plan.arbitrage?.lookupTables ?? [])])];
}

export const TOKEN_PROGRAMS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
] as Address[];

export async function solverTableAccounts(
  solver: Address,
  feeRecipient: Address,
  mints: readonly { mint: Address; tokenProgram: Address }[],
): Promise<Address[]> {
  const [config] = await findConfigPda();
  const [events] = await findEventAuthorityPda();
  const owned = [];
  for (const { mint, tokenProgram } of mints) {
    for (const owner of [feeRecipient, solver]) {
      owned.push(await findAssociatedTokenAddress({ owner, mint, tokenProgram }));
    }
  }
  return [...new Set([config, events, INSTRUCTIONS_SYSVAR_ADDRESS, ...TOKEN_PROGRAMS, ...JITO_TIP_ACCOUNTS, ...owned])];
}

export const PACKET_DATA_SIZE = 1_232;
export const MAX_TX_ACCOUNTS = 64;

export function accountsOf(instructions: readonly Instruction[], payer: Address): number {
  return new Set([payer, ...instructions.flatMap((ix) => [ix.programAddress, ...(ix.accounts ?? []).map((m) => m.address)])]).size;
}

export const locksFit = (accounts: number): boolean => accounts <= MAX_TX_ACCOUNTS;

export const bytesFit = (bytes: number): boolean => bytes <= PACKET_DATA_SIZE;

export function wireSize(wire: Base64EncodedWireTransaction): number {
  return getBase64Encoder().encode(wire).length;
}

export async function compile(
  instructions: readonly Instruction[],
  payer: TransactionSigner,
  latest: { blockhash: Blockhash; lastValidBlockHeight: bigint },
  tables: Readonly<Record<Address, Address[]>>,
): Promise<Base64EncodedWireTransaction> {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
    (m) => compressTransactionMessageUsingAddressLookupTables(m, tables),
  );
  return getBase64EncodedWireTransaction(await signTransactionMessageWithSigners(message));
}
