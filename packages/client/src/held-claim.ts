import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import { InvalidInput } from "@intent-engine/core";
import { buildClaimHeld } from "@intent-engine/core/internal";
import type { ClientContext } from "./client-types.js";
import { acceptsPayout, type HeldShare, heldShareAt } from "./held-shares.js";
import { type Plan, planOf } from "./plan.js";
import { tokenAccountIfMissing } from "./setup.js";

export type ClaimHeldInput = {
  wallet: TransactionSigner;
  announcement: Address;
  index?: number;
  to?: Address;
  payer?: TransactionSigner;
};

export type ClaimHeldPlan = Plan & { share: HeldShare; to: Address };

export const refusingAccount = (to: Address, wallet: Address, mint: Address): string =>
  `${to} cannot take this share: it is not an open token account of ${wallet} for ${mint} that accepts a payout (it is missing, frozen, held by another wallet, requires memos or has another blocking setting)`;

export const canonicalRefuses = (account: Address, wallet: Address, mint: Address): string =>
  `the canonical token account ${account} of ${wallet} still cannot take a payout (it requires memos, is frozen or has another blocking setting); pass to, another token account ${wallet} owns for ${mint}`;

export async function claimHeldPlan(context: ClientContext, input: ClaimHeldInput): Promise<ClaimHeldPlan> {
  const { transport } = context;
  const wallet = input.wallet.address;
  const payer = input.payer ?? input.wallet;
  const share = await heldShareAt(transport, input.announcement, wallet, input.index);
  const { tokenProgram } = await context.mint(share.mint);
  let to: Address;
  let setup: Instruction[] = [];
  if (input.to !== undefined) {
    if (!acceptsPayout(await transport.getAccount(input.to), tokenProgram, share.mint, wallet)) {
      throw new InvalidInput("to", "conflict", refusingAccount(input.to, wallet, share.mint));
    }
    to = input.to;
  } else {
    const canonical = await tokenAccountIfMissing(transport, payer, wallet, share.mint, tokenProgram);
    if (canonical.create.length === 0 && !acceptsPayout(await transport.getAccount(canonical.address), tokenProgram, share.mint, wallet)) {
      throw new InvalidInput("to", "missing", canonicalRefuses(canonical.address, wallet, share.mint));
    }
    to = canonical.address;
    setup = canonical.create;
  }
  const claim = await buildClaimHeld({
    wallet: input.wallet,
    intent: share.intent,
    announcement: share.announcement,
    to,
    inputMint: share.mint,
    inputTokenProgram: tokenProgram,
    index: share.index,
    recipients: share.split.recipients,
    weights: share.split.weights,
    capped: share.capped,
  });
  return { ...planOf({ payer: payer.address, setup, instructions: [claim] }), share, to };
}
