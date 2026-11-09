import type { Address, Instruction, MessagePartialSigner, SignatureBytes } from "@solana/kit";
import { COMPUTE_BUDGET_ADDRESS, computeUnitLimit, computeUnitPrice, MAX_COMPUTE_UNITS } from "@intent-engine/core/internal";
import { packed, PACKET_DATA_SIZE } from "@intent-engine/client/internal";
import type { AgentContext } from "../actions.js";
import { AgentRefusal } from "../problems.js";
import { transactionSize } from "../prepare.js";

export type Tables = Record<Address, Address[]> | undefined;

export type Parts = { setup: readonly Instruction[]; release: readonly Instruction[] };

export const RELEASE_TAIL = 2;

export const STAND_IN = new Uint8Array(64) as SignatureBytes;

export const standIn = (address: Address): MessagePartialSigner => ({
  address,
  signMessages: async (messages) => messages.map(() => ({ [address]: STAND_IN })),
});

export const SETUP_SEPARATE = "Setup: sent in its own transaction before the release, because the release does not fit in one transaction with it";

export const attestTooLarge = (size: number): string =>
  `this release builds a ${size}-byte transaction, over the ${PACKET_DATA_SIZE}-byte limit even with its setup sent first in a transaction of its own, so it cannot be sent`;

export const sizeOf = async (ctx: AgentContext, instructions: readonly Instruction[], payer: Address, tables: Tables): Promise<number> =>
  transactionSize(ctx.transport, await ctx.transport.budget(instructions, payer, tables), payer, tables);

export async function fitted(ctx: AgentContext, instructions: readonly Instruction[], payer: Address, tables: Tables, tooLarge: (size: number) => string): Promise<Instruction[]> {
  const budgeted = await ctx.transport.budget(instructions, payer, tables);
  const size = await transactionSize(ctx.transport, budgeted, payer, tables);
  if (size > PACKET_DATA_SIZE) {
    throw new AgentRefusal("ReleaseTooLarge", tooLarge(size));
  }
  return budgeted;
}

export const boundOf = async (ctx: AgentContext, instructions: readonly Instruction[], payer: Address, tables: Tables): Promise<number> =>
  transactionSize(
    ctx.transport,
    instructions.some((ix) => ix.programAddress === COMPUTE_BUDGET_ADDRESS) ? instructions : [...instructions, computeUnitLimit(MAX_COMPUTE_UNITS), computeUnitPrice(1n)],
    payer,
    tables,
  );

export async function packedRelease(ctx: AgentContext, payer: Address, parts: Parts, tables?: Tables, exact = true) {
  const measure = exact ? sizeOf : boundOf;
  const sends = await packed((instructions) => measure(ctx, instructions, payer, tables), parts.setup, parts.release);
  return { ...sends, size: await measure(ctx, sends.instructions, payer, tables) };
}
