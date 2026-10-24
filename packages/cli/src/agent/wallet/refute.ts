import { isMemoUrl } from "@intent-engine/core";
import { createClient, loadAnnouncement, NoMessageSigner, NotRefutable, RECLAIM_BATCH } from "@intent-engine/client";
import { capturing, hex } from "../../announcement-views.js";
import { type AgentContext, define } from "../actions.js";
import type { Call } from "../claims.js";
import { tool } from "../names.js";
import { prepare } from "../prepare.js";
import { AgentRefusal } from "../problems.js";
import { account, flag, integer, InvalidInput, list, object, optional, text } from "../schema.js";
import { preparedView } from "../shapes.js";
import { deviceOutput, PREVIEW_FIRST, sent, signerOf } from "./guard.js";

export const NOT_ANNOUNCEMENT = "is not an announcement of this program";

export const RECLAIM_MORE = `more announcements can close; call ${tool("wallet_reclaim")} again`;

const MAX_CLOSED = 64;

async function refutable<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof NotRefutable) {
      throw new AgentRefusal("NotRefutable", error.message);
    }
    if (error instanceof NoMessageSigner) {
      throw new AgentRefusal("NoMessageSigner", error.message);
    }
    throw error;
  }
}

export const walletRefute = define({
  name: tool("wallet_refute"),
  title: "Refute a release with an earlier announcement",
  description: `Records on chain that this wallet announced the same work before the announcement a release paid, by revealing its earlier announcement's salt and key; anyone can check it, and it counts against the paid worker's standing. Costs the refutation's rent and the fee. ${PREVIEW_FIRST}`,
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
    const refuting = { worker: signer, earlier: earlier.address, paid: paid.address, sha256, url: input.url, ...(claim === undefined ? {} : { claim }) };
    const probe = capturing(ctx.transport);
    const planned = await refutable(() => createClient({ url: ctx.url ?? "", transport: probe.transport }).refute(refuting));
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

export const walletReclaim = define({
  name: tool("wallet_reclaim"),
  title: "Close finished announcements for their rent",
  description: `Closes up to ${RECLAIM_BATCH} of this wallet's announcements that may close now, those of escrows no longer open and past any refutation window; each one's rent returns to the wallet that paid it. ${PREVIEW_FIRST}`,
  effect: "submit",
  input: object({ send: optional(flag("true signs and sends; leave out to preview")) }),
  output: object({
    closing: list(account(), RECLAIM_BATCH, "the announcements this call closes"),
    closable: integer(0, Number.MAX_SAFE_INTEGER, "how many of this wallet's announcements may close now"),
    kept: list(account(), MAX_CLOSED, "announcements that stay: their escrow is open or the refutation window has not passed"),
    summary: list(text(), 4),
    ...deviceOutput,
    sent: flag(),
    signature: optional(text()),
    next: optional(text()),
  }),
  run: async (ctx: AgentContext, input, call: Call) => {
    const signer = await signerOf(ctx);
    const probe = capturing(ctx.transport);
    const planned = await createClient({ url: ctx.url ?? "", transport: probe.transport }).reclaim({ worker: signer });
    const closing = planned.closed.slice(0, RECLAIM_BATCH);
    if (closing.length === 0) {
      throw new AgentRefusal("NothingToReclaim", `none of ${planned.kept.length} announcements of this wallet can close now`);
    }
    const view = {
      closing,
      closable: planned.closed.length,
      kept: planned.kept.slice(0, MAX_CLOSED),
      summary: [`Closes: ${closing.length} announcement(s) of this wallet; each one's rent returns to the wallet that paid it`],
      prepared: preparedView(await prepare(ctx.transport, probe.sends[0]?.instructions ?? [], signer.address)),
    };
    return sent(ctx, signer, view, input.send, call, { done: planned.closed.length > closing.length ? RECLAIM_MORE : "closed" });
  },
});
