import type { Address } from "@solana/kit";
import { isMemoUrl } from "@intent-engine/core/internal";
import { isSdkError, NoMessageSigner, NotRefutable } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { BOOK_BATCH, batched, loadAnnouncement, RECLAIM_BATCH, type ReclaimBook, secretInputOf } from "@intent-engine/client/internal";
import { capturing, hex, keptLines } from "../../announcement-views.js";
import { type AgentContext, define } from "../actions.js";
import type { Call } from "../claims.js";
import { tool } from "../names.js";
import { prepare } from "../prepare.js";
import { AgentRefusal, SimulationFailed } from "../problems.js";
import { account, flag, integer, InvalidInput, list, object, optional, text } from "../schema.js";
import { preparedView } from "../shapes.js";
import { sol } from "./costs.js";
import { deviceOutput, PREVIEW_FIRST, sent, signerOf } from "./guard.js";
import { closeEach } from "./worker-books.js";

export const NOT_ANNOUNCEMENT = "is not an announcement of this program";

export const RECLAIM_MORE = `more announcements can close; call ${tool("wallet_reclaim")} again`;

const MAX_CLOSED = 64;

async function refutable<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isSdkError(error, "not-refutable")) {
      throw new AgentRefusal("NotRefutable", error.message);
    }
    if (isSdkError(error, "no-message-signer")) {
      throw new AgentRefusal("NoMessageSigner", error.message);
    }
    throw error;
  }
}

export const walletRefute = define({
  name: tool("wallet_refute"),
  title: "Refute a release with an earlier announcement",
  description: `Records on chain that this wallet announced the same work before the announcement a release paid, by revealing its earlier announcement's salt and key; anyone can check it, and it counts against the standing of every wallet the release paid. Costs the refutation's rent and the fee. ${PREVIEW_FIRST}`,
  effect: "submit",
  input: object({
    earlier: account("this wallet's earlier announcement of the same work"),
    paid: account("the announcement the release paid"),
    url: text("the url this wallet's earlier announcement sealed, exactly as announced"),
    recipients: optional(
      list(object({ wallet: account(), weight: integer(1, 10_000) }), 8, "for a split release: its recipients and weights, as the release paid them"),
    ),
    send: optional(flag("true signs and sends; leave out to preview")),
  }),
  output: object({
    earlier: account(),
    paid: account(),
    intent: account(),
    sha256: text("the work the release paid for, which the earlier announcement also commits to"),
    summary: list(text(), 6),
    ...deviceOutput,
    refutation: optional(account("the refutation account")),
    sent: flag(),
    signature: optional(text()),
    next: optional(text()),
  }),
  run: async (ctx: AgentContext, input, call: Call) => {
    const signer = await signerOf(ctx);
    if (!isMemoUrl(input.url)) {
      throw new InvalidInput([{ path: "url", message: "must be the https url the earlier announcement sealed" }]);
    }
    const [earlier, paid] = await Promise.all([loadAnnouncement(ctx.transport, input.earlier), loadAnnouncement(ctx.transport, input.paid)]);
    if (earlier === null || paid === null) {
      throw new AgentRefusal("NotRefutable", `${earlier === null ? input.earlier : input.paid} ${NOT_ANNOUNCEMENT}`);
    }
    const sha256 = hex(paid.delivered);
    const claim = input.recipients === undefined ? undefined : { recipients: input.recipients.map(({ wallet }) => wallet), weights: input.recipients.map(({ weight }) => weight) };
    const refuting = { earlier: earlier.address, paid: paid.address, sha256, url: input.url, ...(claim === undefined ? {} : { claim }) };
    const probe = capturing(ctx.transport);
    const planned = await refutable(() => createClient({ url: ctx.url ?? "", transport: probe.transport }).refute({ ...refuting, ...secretInputOf(signer) }));
    const view = {
      earlier: earlier.address,
      paid: paid.address,
      intent: paid.intent,
      sha256,
      refutation: planned.refutation,
      summary: [
        `Refutes: the release that paid ${paid.worker} through ${paid.address} (seq ${paid.seq}), with this wallet's earlier announcement ${earlier.address} (seq ${earlier.seq}) of the same work`,
        `Reveals: the earlier announcement's salt and ephemeral key, so anyone can check it opens to ${input.url} and commits to ${sha256}`,
        "Pays: the refutation's rent and the fee, from this wallet",
      ],
      prepared: preparedView(await prepare(ctx.transport, probe.sends[0]?.instructions ?? [], signer.address)),
    };
    return sent(ctx, signer, view, input.send, call, { done: `refuted; ${tool("get_reputation")} of ${paid.worker} counts it once it opens to the work` });
  },
});

export const RECLAIM_BOOKS_NEXT = `closed; a Ledger signs one transaction per call, so call ${tool("wallet_reclaim")} again to close the delivery books whose last announcement this closed`;

export const BOOKS_REFUSED = "the program refused to close the delivery books in unclosed, so they stay; the rest of this reclaim went through";

export const booksLine = (count: number, rent: bigint): string =>
  `Closes: ${count} delivery book(s) whose last announcement closes here, each in a transaction of its own batch, so a refused one stops no other; their ${sol(rent)} of rent returns to the wallets that paid them`;

const rentOfBooks = (books: readonly ReclaimBook[]): bigint => books.reduce((sum, { rent }) => sum + rent, 0n);

async function firstShelf(ctx: AgentContext, payer: Address, shelves: readonly ReclaimBook[][]) {
  const skipped: ReclaimBook[] = [];
  for (const shelf of shelves) {
    try {
      return { shelf, skipped, prepared: preparedView(await prepare(ctx.transport, shelf.map(({ instruction }) => instruction), payer)) };
    } catch (error) {
      if (!(error instanceof SimulationFailed)) {
        throw error;
      }
      skipped.push(...shelf);
    }
  }
  return { shelf: undefined, skipped, prepared: undefined };
}

export const walletReclaim = define({
  name: tool("wallet_reclaim"),
  title: "Close finished announcements for their rent",
  description: `Closes up to ${RECLAIM_BATCH} of this wallet's announcements that may close now, those of escrows no longer open and past any refutation window, then each delivery book left empty; each one's rent returns to the wallet that paid it; reasons says why each other one stays. ${PREVIEW_FIRST}`,
  effect: "submit",
  input: object({ send: optional(flag("true signs and sends; leave out to preview")) }),
  output: object({
    closing: list(account(), RECLAIM_BATCH, "the announcements this call closes"),
    closable: integer(0, Number.MAX_SAFE_INTEGER, "how many of this wallet's announcements may close now"),
    books: list(account(), MAX_CLOSED, "the delivery books this call closes once their last announcement has closed; each one's rent returns to the wallet that paid it"),
    unclosed: optional(list(account(), MAX_CLOSED, "delivery books the program refused to close; the announcements and other books still closed")),
    kept: list(account(), MAX_CLOSED, "announcements that stay: their escrow is open, the refutation window has not passed, they can still refute a paid release, or they hold a co-author's split share until it is claimed"),
    reasons: list(object({ announcement: account(), reason: text() }), MAX_CLOSED, "why each kept announcement stays, and until when if that ends"),
    summary: list(text(), 4),
    ...deviceOutput,
    sent: flag(),
    signature: optional(text()),
    next: optional(text()),
  }),
  run: async (ctx: AgentContext, input, call: Call) => {
    const signer = await signerOf(ctx);
    const planned = await createClient({ url: ctx.url ?? "", transport: ctx.transport }).plan.reclaim({ worker: signer });
    const closing = planned.closed.slice(0, RECLAIM_BATCH);
    const closes = planned.batches[0] ?? [];
    const reasons = planned.reasons.slice(0, MAX_CLOSED);
    const device = signer.device !== undefined;
    const ready = planned.books.filter(({ after }) => after.every((announcement) => closing.includes(announcement)));
    const shelves = batched(ready, BOOK_BATCH);
    const opened = closes.length > 0 ? undefined : await firstShelf(ctx, signer.address, shelves);
    const skipped = opened?.skipped ?? [];
    const books = device ? (closes.length > 0 ? [] : (opened?.shelf ?? [])) : ready.filter((book) => !skipped.includes(book));
    if (closing.length === 0 && books.length === 0 && skipped.length === 0) {
      throw new AgentRefusal("NothingToReclaim", [`none of ${planned.kept.length} announcements of this wallet can close now`, ...keptLines(reasons)].join("; "));
    }
    const more = planned.closed.length > closing.length || books.length < planned.books.length - skipped.length;
    const next = device && closes.length > 0 && ready.length > 0 ? RECLAIM_BOOKS_NEXT : more ? RECLAIM_MORE : skipped.length > 0 ? BOOKS_REFUSED : "closed";
    const view = {
      closing,
      closable: planned.closed.length,
      books: books.map(({ book }) => book),
      ...(skipped.length === 0 ? {} : { unclosed: skipped.map(({ book }) => book) }),
      kept: reasons.map(({ announcement }) => announcement),
      reasons,
      summary: [
        ...(closing.length === 0 ? [] : [`Closes: ${closing.length} announcement(s) of this wallet; each one's rent returns to the wallet that paid it`]),
        ...(books.length === 0 ? [] : [booksLine(books.length, rentOfBooks(books))]),
      ],
    };
    const prepared = closes.length > 0 ? preparedView(await prepare(ctx.transport, closes, signer.address)) : opened?.prepared;
    if (prepared === undefined) {
      return { ...view, sent: false, next: BOOKS_REFUSED };
    }
    if (input.send !== true || device) {
      return sent(ctx, signer, { ...view, prepared }, input.send, call, { done: next });
    }
    const done = closes.length === 0 ? undefined : await sent(ctx, signer, { ...view, prepared }, true, call, { done: next });
    const shut = await closeEach(ctx.transport, signer, shelves.filter((shelf) => !shelf.some((book) => skipped.includes(book))), ({ instruction }) => instruction);
    const signature = shut.signature ?? (done !== undefined && "signature" in done ? done.signature : undefined);
    const refused = [...skipped, ...shut.unclosed].map(({ book }) => book);
    return {
      ...view,
      books: shut.closed.map(({ book }) => book),
      ...(refused.length === 0 ? {} : { unclosed: refused }),
      sent: signature !== undefined,
      ...(signature === undefined ? {} : { signature }),
      next: refused.length === 0 ? next : BOOKS_REFUSED,
    };
  },
});
