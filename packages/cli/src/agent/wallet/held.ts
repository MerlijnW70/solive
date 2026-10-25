import type { Address } from "@solana/kit";
import { formatAmount } from "@intent-engine/core";
import { type HeldShare, isSdkError } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { mintOf } from "@intent-engine/client/internal";
import { TOKEN_NAMES } from "../../tokens.js";
import { type AgentContext, define } from "../actions.js";
import type { Call } from "../claims.js";
import { tool } from "../names.js";
import { prepare } from "../prepare.js";
import { AgentRefusal } from "../problems.js";
import { account, flag, integer, InvalidInput, list, object, optional, text } from "../schema.js";
import { preparedView } from "../shapes.js";
import { deviceOutput, PREVIEW_APPROVAL, PREVIEW_APPROVAL_NEXT, sent, signerOf, termsApproval } from "./guard.js";

export const MAX_HELD_LISTED = 16;

export const CLAIM_HELD_CHANGED = "this claim differs from its preview: the share, its amount or the receiving account changed, or no approval was given; preview it again and show the user";

export const NOTHING_HELD = "no split share is held for this wallet; a release holds a co-author's share only when its token account cannot take it";

export const pickHeld = (count: number): string => `${count} shares are held for this wallet; pass announcement, and index if one announcement holds more, to claim one`;

export const claimedHeld = (amount: string, token: string, to: Address): string => `claimed; ${amount} ${token} landed in ${to}; ${tool("wallet_balance")} shows it`;

const heldItem = object({
  intent: account("the escrow that holds the share"),
  announcement: account("the paid announcement whose release held it; pass it to claim"),
  index: integer(0, 7, "this wallet's place in the split"),
  amount: text("whole tokens held for this wallet"),
  token: text("SOL, TEST or the mint"),
  account: account("the token account the release could not pay"),
  release: text("the release transaction that held it"),
});

async function heldRefused<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isSdkError(error, "no-held-share")) {
      throw new AgentRefusal("NoShareHeld", error.message);
    }
    if (isSdkError(error, "invalid-input")) {
      throw new InvalidInput([{ path: error.field, message: error.message }]);
    }
    throw error;
  }
}

async function shown(ctx: AgentContext, share: HeldShare) {
  const { decimals } = await mintOf(ctx.transport, share.mint);
  return {
    intent: share.intent,
    announcement: share.announcement,
    index: share.index,
    amount: formatAmount(share.amount, decimals),
    token: TOKEN_NAMES[share.mint] ?? share.mint,
    account: share.account,
    release: share.release,
  };
}

export const walletClaimHeld = define({
  name: tool("wallet_claim_held"),
  title: "Claim a split share held for this wallet",
  description: `Lists the split shares a release held for this wallet because its token account could not take them (it required memos, was frozen or closed), and claims one into a token account this wallet owns. Without announcement it only lists. ${PREVIEW_APPROVAL}`,
  effect: "submit",
  destructive: false,
  input: object({
    announcement: optional(account("the paid announcement holding the share, from the listing")),
    index: optional(integer(0, 7, "this wallet's place in the split, when one announcement holds more than one share for it")),
    to: optional(account("a token account this wallet owns for the escrow's token; default its canonical account, if that can take the payout now")),
    approval: optional(text("the approval the preview returned; needed with send")),
    send: optional(flag("true signs and sends the claim; leave out to preview")),
  }),
  output: object({
    shares: list(heldItem, MAX_HELD_LISTED, "the shares held for this wallet"),
    complete: flag("false when some paid announcement holding a share could not be read in full"),
    claiming: optional(heldItem),
    to: optional(account("the token account the claim pays into")),
    approval: optional(text("pass it back with send: true; a send that would differ from this preview is refused")),
    summary: list(text(), 6),
    ...deviceOutput,
    sent: flag(),
    signature: optional(text()),
    next: optional(text()),
  }),
  run: async (ctx: AgentContext, input, call: Call) => {
    const signer = await signerOf(ctx);
    const client = createClient({ url: ctx.url ?? "", transport: ctx.transport });
    const listed = await heldRefused(() => client.heldShares(signer.address));
    const shares = await Promise.all(listed.shares.slice(0, MAX_HELD_LISTED).map((share) => shown(ctx, share)));
    if (input.announcement === undefined) {
      if (input.send === true) {
        throw new InvalidInput([{ path: "announcement", message: "give the announcement whose share to claim" }]);
      }
      const next = shares.length === 0 ? NOTHING_HELD : shares.length === 1 ? `pass announcement ${shares[0]?.announcement ?? ""} to preview the claim` : pickHeld(shares.length);
      return { shares, complete: listed.complete, summary: listed.reasons.slice(0, 6), sent: false, next };
    }
    const announcement = input.announcement;
    const planned = await heldRefused(() =>
      client.plan.claimHeld({ wallet: signer, announcement, ...(input.index === undefined ? {} : { index: input.index }), ...(input.to === undefined ? {} : { to: input.to }) }),
    );
    const claiming = await shown(ctx, planned.share);
    const approval = termsApproval({ action: "claim_held", wallet: signer.address, announcement, index: planned.share.index, amount: planned.share.amount, mint: planned.share.mint, to: planned.to });
    if (input.send === true && input.approval !== approval) {
      throw new AgentRefusal("ReleaseChanged", CLAIM_HELD_CHANGED);
    }
    const view = {
      shares,
      complete: listed.complete,
      claiming,
      to: planned.to,
      approval,
      summary: [
        `Claims: ${claiming.amount} ${claiming.token} held for this wallet by escrow ${planned.share.intent} since its release ${planned.share.release}`,
        `Pays into: ${planned.to}, a token account of this wallet${planned.setup.length === 0 ? "" : ", created first at this wallet's cost"}`,
        `Why held: the release could not pay ${planned.share.account}`,
      ],
      prepared: preparedView(await prepare(ctx.transport, [...planned.setup, ...planned.instructions], signer.address)),
    };
    return sent(ctx, signer, view, input.send, call, { preview: PREVIEW_APPROVAL_NEXT, done: claimedHeld(claiming.amount, claiming.token, planned.to) });
  },
});
