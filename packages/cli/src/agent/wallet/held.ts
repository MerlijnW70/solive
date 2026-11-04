import type { Address } from "@solana/kit";
import { formatAmount } from "@intent-engine/core";
import { type HeldShare, type HeldShares, isSdkError } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { HELD_ANNOUNCEMENTS, HELD_READS, heldPastLimit, heldReadsSpent, mintOf } from "@intent-engine/client/internal";
import { NOTHING_HELD } from "../../delivery-shared.js";
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

const MAX_HELD_REASONS = 6;

const HELD_ANNOUNCEMENTS_MAX = 512;

const HELD_READS_MAX = 128;

export const heldIncomplete = (raise: readonly string[]): string =>
  raise.length > 0
    ? `no held share found, but the read stopped at its bounds: raise ${raise.join(" and ")} to read more; summary says why`
    : "no held share found, but some releases or announcement accounts could not be read, and wider bounds would not change that: summary says which";

const heldMore = (count: number): string => `${count} more announcements could not be read in full, so their held shares are not listed`;

const heldUnreadable = (count: number): string => `${count} announcement accounts could not be decoded, so their held shares are not listed`;

const isPastLimit = (reason: string, limit: number): boolean => /^\d+ /.test(reason) && reason === heldPastLimit(Number.parseInt(reason, 10), limit);

const SPENT = /^the history of (\S+) needs more than /;

const isReadsSpent = (reason: string, reads: number): boolean => reason === heldReadsSpent((SPENT.exec(reason)?.[1] ?? "") as Address, reads);

const widenable = (reasons: readonly string[], limit: number, reads: number): string[] => [
  ...(reasons.some((reason) => isPastLimit(reason, limit)) ? ["announcements"] : []),
  ...(reasons.some((reason) => isReadsSpent(reason, reads)) ? ["reads"] : []),
];

function heldReasons(listed: Pick<HeldShares, "reasons" | "unreadable">, limit: number): string[] {
  const first = [...listed.reasons.filter((reason) => isPastLimit(reason, limit)), ...(listed.unreadable.length === 0 ? [] : [heldUnreadable(listed.unreadable.length)])];
  const rest = listed.reasons.filter((reason) => !isPastLimit(reason, limit));
  const room = MAX_HELD_REASONS - first.length;
  return [...first, ...(rest.length <= room ? rest : [...rest.slice(0, room - 1), heldMore(rest.length - room + 1)])];
}

export const CLAIM_HELD_CHANGED = "this claim differs from its preview: the share, its amount or the receiving account changed, or no approval was given; preview it again and show the user";

export { NOTHING_HELD } from "../../delivery-shared.js";

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
    announcements: optional(integer(1, HELD_ANNOUNCEMENTS_MAX, `paid announcements holding shares to read, this wallet's own first; default ${HELD_ANNOUNCEMENTS}; raise it when complete is false`)),
    reads: optional(integer(1, HELD_READS_MAX, `history reads per announcement to find its release; default ${HELD_READS}; raise it when complete is false`)),
    approval: optional(text("the approval the preview returned; needed with send")),
    send: optional(flag("true signs and sends the claim; leave out to preview")),
  }),
  output: object({
    shares: list(heldItem, MAX_HELD_LISTED, "the shares held for this wallet"),
    complete: flag("false when the read was incomplete, so shares may be missing; summary says why"),
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
    const limit = input.announcements ?? HELD_ANNOUNCEMENTS;
    const reads = input.reads ?? HELD_READS;
    const listed = await heldRefused(() => client.heldShares(signer.address, { announcements: limit, reads }));
    const shares = await Promise.all(listed.shares.slice(0, MAX_HELD_LISTED).map((share) => shown(ctx, share)));
    if (input.announcement === undefined) {
      if (input.send === true) {
        throw new InvalidInput([{ path: "announcement", message: "give the announcement whose share to claim" }]);
      }
      const none = listed.complete ? NOTHING_HELD : heldIncomplete(widenable(listed.reasons, limit, reads));
      const next = shares.length === 0 ? none : shares.length === 1 ? `pass announcement ${shares[0]?.announcement ?? ""} to preview the claim` : pickHeld(shares.length);
      return { shares, complete: listed.complete, summary: heldReasons(listed, limit), sent: false, next };
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
