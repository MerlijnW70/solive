import { type Address, type Instruction, isSignerRole, type Signature, type TransactionSigner } from "@solana/kit";
import { InvalidInput } from "@intent-engine/core";
import type { LookupTables } from "./rpc-shapes.js";

export type Plan = {
  payer: Address;
  setup: Instruction[];
  setupSigners: Address[][];
  instructions: Instruction[];
  signers: Address[][];
  lookupTables: LookupTables;
};

export type PlanParts = { payer: Address; setup?: readonly Instruction[]; instructions: readonly Instruction[] };

export type Sends = (instructions: readonly Instruction[], signer: TransactionSigner) => Promise<Signature>;

export const PAYER_DIFFERS = "the plan names another payer than the signer given to send it";

export function signersOf(instruction: Instruction): Address[] {
  const found: Address[] = [];
  for (const meta of instruction.accounts ?? []) {
    if (isSignerRole(meta.role) && !found.includes(meta.address)) {
      found.push(meta.address);
    }
  }
  return found;
}

export function planOf({ payer, setup = [], instructions }: PlanParts): Plan {
  return {
    payer,
    setup: [...setup],
    setupSigners: setup.map(signersOf),
    instructions: [...instructions],
    signers: instructions.map(signersOf),
    lookupTables: {},
  };
}

export const plansNothing = (plan: Plan): boolean => plan.setup.length === 0 && plan.instructions.length === 0;

export function payerFor(plan: Plan, payer: TransactionSigner): TransactionSigner {
  if (payer.address !== plan.payer) {
    throw new InvalidInput("payer", "conflict", `${PAYER_DIFFERS}: ${plan.payer}, not ${payer.address}`);
  }
  return payer;
}

export async function submit(send: Sends, plan: Plan, signer: TransactionSigner): Promise<Signature> {
  const payer = payerFor(plan, signer);
  if (plan.setup.length > 0) {
    await send(plan.setup, payer);
  }
  return send(plan.instructions, payer);
}

export async function submitted(send: Sends, plan: Plan, payer: TransactionSigner): Promise<Signature | null> {
  return plansNothing(plan) ? null : submit(send, plan, payer);
}
