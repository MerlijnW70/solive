import { createNoopSigner } from "@solana/kit";
import { findAssociatedTokenPda, getCloseAccountInstruction, getTokenDecoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { formatAmount, NATIVE_MINT } from "@intent-engine/core";
import { type AgentContext, define } from "../actions.js";
import type { Call } from "../claims.js";
import { tool } from "../names.js";
import { AgentRefusal } from "../problems.js";
import { account, flag, list, object, optional, text } from "../schema.js";
import { preparedView } from "../shapes.js";
import { prepare } from "../prepare.js";
import { deviceOutput, PREVIEW_FIRST, signerOf, sent } from "./guard.js";

const SOL_DECIMALS = 9;

export const NOTHING_WRAPPED = "this wallet has no wrapped SOL account to unwrap";

export const walletUnwrap = define({
  name: tool("wallet_unwrap"),
  title: "Turn wrapped SOL into SOL",
  description: `Closes this wallet's wrapped SOL account, where escrow payouts in SOL arrive, so its whole balance and the account's rent return to the wallet as plain SOL. ${PREVIEW_FIRST}`,
  effect: "submit",
  destructive: false,
  input: object({ send: optional(flag("true signs and sends; leave out to preview")) }),
  output: object({
    account: account("the wrapped SOL account this closes"),
    wrapped: text("whole SOL the account holds"),
    summary: list(text(), 4),
    ...deviceOutput,
    sent: flag(),
    signature: optional(text()),
    next: optional(text()),
  }),
  run: async (ctx: AgentContext, input, call: Call) => {
    const signer = await signerOf(ctx);
    const [wrappedAccount] = await findAssociatedTokenPda({ owner: signer.address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const held = await ctx.transport.getAccount(wrappedAccount);
    if (held === null || held.owner !== TOKEN_PROGRAM_ADDRESS) {
      throw new AgentRefusal("NotFound", NOTHING_WRAPPED);
    }
    const wrapped = formatAmount(getTokenDecoder().decode(held.data).amount, SOL_DECIMALS);
    const close = getCloseAccountInstruction({ account: wrappedAccount, destination: signer.address, owner: createNoopSigner(signer.address) });
    const view = {
      account: wrappedAccount,
      wrapped,
      summary: [`Unwraps: ${wrapped} wrapped SOL in ${wrappedAccount}, and the account's rent, into plain SOL in this wallet`, "Costs: the transaction fee"],
      prepared: preparedView(await prepare(ctx.transport, [close], signer.address)),
    };
    return sent(ctx, signer, view, input.send, call, { done: `unwrapped; ${tool("wallet_balance")} shows the SOL` });
  },
});
