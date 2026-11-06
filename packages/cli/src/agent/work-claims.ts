import { createHash, randomUUID } from "node:crypto";
import type { Address } from "@solana/kit";
import { formatAmount, IntentStatus, NATIVE_MINT } from "@intent-engine/core";
import { buildClaimJob, buildDropClaim, claimCooldown, takeUntil, findIntentPda, formatTime, type LineHandover, MAX_CLAIM_SECS, MAX_CLAIMANTS, MAX_SEALED_RECIPIENTS } from "@intent-engine/core/internal";
import { type ClaimListView, type ClaimsView, isSdkError } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { claimProtection, protectionLines, reviewBoardOf } from "@intent-engine/client/internal";
import { reviewPastExpiry } from "../fair-lines.js";
import { listAccount, listRefusal } from "../claim-lists.js";
import { coolingDown, dropHandover, handedTo, heldBy, noClaims } from "../claim-commands.js";
import { claimNotInvited, sealedInvites } from "../invites.js";
import { type AgentContext, define, specReach } from "./actions.js";
import { type Admit, advanceStep, claimAt, claimBoard, closedEscrow, type EscrowState, escrowState, collectStep, fillsGoing, heldFor, leaveStep, type LineStep, reviewHeld, lineWaitingHere, refusedBy, settleCall, settleStep, standbyStep } from "./claim-line.js";
import type { Call } from "./claims.js";
import { tool } from "./names.js";
import { AgentRefusal } from "./problems.js";
import type { Sale } from "./sales.js";
import { account, amount, choice, flag, InvalidInput, integer, list, nullable, object, optional, text, time } from "./schema.js";
import { preparedView } from "./shapes.js";
import { prepare } from "./prepare.js";
import { access, bookOf, checkSale, deviceOutput, limited, live, PREVIEW_APPROVAL, PREVIEW_APPROVAL_NEXT, refusedBeforeSending, salesOf, signerOf, sent } from "./wallet/guard.js";

export const CLAIM_CHANGED =
  "this claim differs from its preview: the escrow, action, seconds or stake changed, or no approval was given; preview it again and show the user";

const ACTIONS = ["take", "drop", "settle", "collect", "standby", "leave", "advance"] as const;

const escrowRef = {
  owner: account("the wallet that made the escrow"),
  nonce: amount("the escrow intent's nonce"),
};

async function claimsFor(ctx: AgentContext, owner: Address, nonce: bigint) {
  const client = createClient({ url: ctx.url ?? "", transport: ctx.transport });
  const [intent] = await findIntentPda({ owner, nonce });
  return { client, intent, view: await client.claims({ owner, nonce }) };
}

const waitingWorkers = (waiting: number) => `${waiting} ${waiting === 1 ? "worker stands" : "workers stand"} by`;

export const inviteOnly = (invited: readonly Address[]): string =>
  `the job is invite-only: its spec is sealed to ${invited.join(", ")}, and only those wallets can be paid; an invited wallet claims it with ${tool("wallet_claim")} action take before working on it or hosting the work`;

export const listedOnly = (list: ClaimListView): string =>
  list.complete
    ? `only the wallets on the owner's claim list can claim this job: ${list.workers.join(", ")}; a listed wallet claims it with ${tool("wallet_claim")} action take before working on it or hosting the work`
    : `the owner's claim list holds ${list.workers.length} of its ${list.size} wallets, so nobody can claim this job until the owner adds the rest`;

function claimsNext(intent: Address, escrow: EscrowState, view: ClaimsView, owner: Address, nonce: bigint, invited: readonly Address[] | undefined): string {
  if (escrow !== "open") {
    return `${closedEscrow(intent, escrow)}; ${settleCall(owner, nonce)} closes its claims board and returns the rent to ${view.owner}`;
  }
  if (view.review?.lapsed === true && view.worker !== null) {
    return `the judge neither released nor rejected the delivery of ${view.worker} by ${view.review.until}; ${tool("wallet_claim")} action collect pays it its stake and the kill fee`;
  }
  if (view.review !== null && view.worker !== null) {
    return `the judge reviews the delivery of ${view.worker} until ${view.review.until}; the job stays held until it releases, rejects or the review ends`;
  }
  if (view.state === "held" && view.worker !== null) {
    return `${view.worker} holds this job's claim for ${view.secondsLeft} more seconds; ${tool("wallet_claim")} action standby joins the line that gets the job next`;
  }
  if (view.line.waiting > 0) {
    return `${waitingWorkers(view.line.waiting)}, so the job goes to them in line order; ${tool("wallet_claim")} action advance hands it to the first, and action standby joins the line`;
  }
  if (view.list !== null) {
    return listedOnly(view.list);
  }
  if (invited !== undefined) {
    return inviteOnly(invited);
  }
  return `the job is free to claim; claim it with ${tool("wallet_claim")} action take before working on it or hosting the work`;
}

export const getClaims = define({
  name: tool("get_claims"),
  title: "Who holds a job's claim",
  description: "Read the claims board of a proof escrow: whether its owner opened claims, whether the escrow is still open, released or gone, and whether the job is free, held by a worker until a time, or held by a claim that lapsed. While a claim holds, only its worker can be paid. review_secs and kill_fee are the protection a holder's first delivery gets, and review its state. claim_list names the only wallets the program lets claim. invited lists the wallets an invite-only job's sealed spec names; only they can be paid. next says what to do about the claim.",
  effect: "read",
  input: object(escrowRef),
  output: object({
    intent: account(),
    takes_claims: flag("false means the owner opened no claims, so anyone can be paid"),
    escrow: choice(["open", "released", "gone"] as const, "open while the escrow can still be paid; released once paid; gone once cancelled, expired or closed"),
    board: optional(account()),
    state: optional(choice(["free", "held", "lapsed"] as const)),
    worker: optional(nullable(account())),
    until: optional(time("when the claim lapses")),
    seconds_left: optional(amount("seconds until the claim lapses, by the chain's clock")),
    stake: optional(amount("lamports a worker stakes to claim")),
    max_secs: optional(integer(1, MAX_CLAIM_SECS, "the longest a claim may run")),
    review_secs: optional(integer(0, MAX_CLAIM_SECS, "seconds the judge has to release or reject the holder's first delivery; 0: no review, so a delivery is unprotected")),
    kill_fee: optional(amount("lamports the holder collects with its stake when the judge neither releases nor rejects in the review window")),
    review: optional(
      nullable(
        object(
          { announcement: account(), until: time("when the review ends"), seconds_left: amount(), lapsed: flag("true once it ended with no release or reject: the holder collects its stake and the kill fee") },
          "the armed review of the holder's delivery, while one runs or waits to be collected",
        ),
      ),
    ),
    owner: optional(account()),
    dropped_by: optional(nullable(account("a worker that dropped its claim and may not claim again until cooldown_until"))),
    cooldown_until: optional(time("when the worker that dropped may claim again")),
    waiting: optional(integer(0, 0xffff_ffff, "workers standing by in the job's line, who get it in order before anyone else can claim it")),
    claim_list: optional(
      object(
        {
          workers: list(account(), MAX_CLAIMANTS, "the wallets listed so far"),
          size: integer(1, MAX_CLAIMANTS, "how many wallets the list names once complete"),
          complete: flag("false while the owner still adds wallets; nobody can claim until then"),
        },
        "present when the owner named who may claim: the program refuses a claim or stand-by from any other wallet",
      ),
    ),
    invited: optional(list(account(), MAX_SEALED_RECIPIENTS, "present on an invite-only job: the wallets its sealed spec names, the only ones a release can pay")),
    next: optional(text()),
  }),
  run: async (ctx, input) => {
    const { client, intent, view } = await claimsFor(ctx, input.owner, input.nonce);
    const escrow = await escrowState(client, input.owner, input.nonce);
    const invited = escrow === "open" ? await sealedInvites(ctx.transport, ctx.fetch ?? fetch, intent, specReach(ctx)) : undefined;
    const named = invited === undefined ? {} : { invited };
    if (view === null) {
      return { intent, takes_claims: false, escrow, ...named, ...(escrow === "open" ? {} : { next: closedEscrow(intent, escrow) }) };
    }
    return {
      intent,
      takes_claims: true,
      escrow,
      board: view.board,
      state: view.state,
      worker: view.worker,
      until: view.until,
      seconds_left: view.secondsLeft,
      stake: view.stake,
      max_secs: view.maxSecs,
      review_secs: view.reviewSecs,
      kill_fee: view.killFee,
      review: view.review === null ? null : { announcement: view.review.announcement, until: view.review.until, seconds_left: view.review.secondsLeft, lapsed: view.review.lapsed },
      owner: view.owner,
      dropped_by: view.cooldown?.worker ?? null,
      ...(view.cooldown === null ? {} : { cooldown_until: view.cooldown.until }),
      waiting: view.line.waiting,
      ...(view.list === null ? {} : { claim_list: { workers: view.list.workers, size: view.list.size, complete: view.list.complete } }),
      ...named,
      next: claimsNext(intent, escrow, view, input.owner, input.nonce, invited),
    };
  },
});

export const walletClaim = define({
  name: tool("wallet_claim"),
  title: "Claim, drop or queue for a job",
  description: `Reserves a job: take stakes what the owner asks so only this wallet is paid for secs seconds, lost if it lapses; drop returns it. standby queues, leave quits, advance passes a lapsed job on, collect takes lapsed review pay, settle returns a finished board's rent. ${PREVIEW_APPROVAL}`,
  effect: "submit",
  input: object({
    ...escrowRef,
    action: choice(
      ACTIONS,
      "take claims the job; drop gives up this wallet's claim and its stake returns; standby joins the line for a job another worker holds; leave quits the line, returning the entry's stake and rent; advance hands a lapsed job to the first in line; settle moves a lapsed claim's stake to the owner, or a lapsed review's stake and kill fee to its holder; collect pays the holder its stake and the kill fee once the judge's review of its delivery ended with no release or reject; settle, once the escrow is released or gone, closes the claims board and returns its rent to the owner",
    ),
    secs: optional(integer(1, MAX_CLAIM_SECS, "how long to hold the claim; needed with take and standby")),
    seq: optional(integer(0, 0xffff_ffff, "with leave: the line entry to return, needed once the claims board is closed")),
    approval: optional(text("the approval the preview returned; needed with send")),
    send: optional(flag("true sends the claim; leave out to preview")),
  }),
  output: object({
    intent: account(),
    action: choice(ACTIONS),
    approval: text(),
    summary: list(text(), 6),
    ...deviceOutput,
    sent: flag(),
    signature: optional(text()),
    next: optional(text()),
  }),
  run: async (ctx: AgentContext, input, call: Call) => {
    const signer = await signerOf(ctx);
    const { client, intent, view } = await claimsFor(ctx, input.owner, input.nonce);
    const escrow = { owner: input.owner, nonce: input.nonce, intent };
    const admit: Admit = async () => {
      const invited = await sealedInvites(ctx.transport, ctx.fetch ?? fetch, intent, specReach(ctx));
      if (invited !== undefined && !invited.includes(signer.address)) {
        throw new AgentRefusal("NotInvited", claimNotInvited(signer.address, intent));
      }
      const unlisted = view === null ? undefined : listRefusal(view.list, signer.address, intent);
      if (unlisted !== undefined && view !== null && view.list !== null) {
        throw new AgentRefusal(view.list.complete ? "NotListed" : "ClaimListIncomplete", unlisted);
      }
    };
    let step: LineStep;
    if (input.action === "leave") {
      step = await leaveStep(client, ctx.transport, escrow, view, signer, input.seq);
    } else if (view === null) {
      throw new AgentRefusal("ClaimsMissing", noClaims(intent));
    } else if (input.action === "settle") {
      step = await settleStep(client, ctx.transport, escrow, view, signer.address);
    } else if (input.action === "collect") {
      step = await collectStep(ctx.transport, intent, signer.address);
    } else if (input.action === "standby") {
      step = await standbyStep(client, ctx.transport, escrow, view, signer, needSecs(input.secs, input.action), admit);
    } else if (input.action === "advance") {
      step = await advanceStep(client, ctx.transport, escrow, view, signer.address);
    } else if (input.action === "take") {
      step = await takeStep(client, escrow, view, signer, needSecs(input.secs, input.action), admit);
    } else {
      step = await dropStep(ctx, client, escrow, view, signer);
    }
    const now = step.locks === undefined ? undefined : await stakeAllowed(ctx, client, step.locks);
    const approval = createHash("sha256").update(`${intent}:${input.action}:${step.key}`).digest("hex").slice(0, 16);
    if (input.send === true && input.approval !== approval) {
      throw new AgentRefusal("ReleaseChanged", CLAIM_CHANGED);
    }
    const shown = {
      intent,
      action: input.action,
      approval,
      summary: step.summary,
      prepared: input.send === true || signer.device !== undefined ? preparedView(await prepare(ctx.transport, [step.instruction], signer.address)) : undefined,
    };
    const next = { preview: PREVIEW_APPROVAL_NEXT, done: step.done };
    if (input.send !== true || step.locks === undefined || now === undefined) {
      return sent(ctx, signer, shown, input.send, call, next);
    }
    return stakeSent(ctx, signer, shown, call, next, step.locks, now);
  },
});

async function stakeAllowed(ctx: AgentContext, client: ReturnType<typeof createClient>, locks: bigint): Promise<bigint> {
  const wallet = access(ctx);
  const now = await client.chainTime();
  checkSale(wallet.limits, NATIVE_MINT, 9, locks, now, await salesOf(wallet, now));
  return now;
}

async function stakeSent(ctx: AgentContext, signer: Signer, shown: Record<string, unknown>, call: Call, next: { preview: string; done: string }, locks: bigint, now: bigint) {
  const wallet = access(ctx);
  const guard = wallet.limits;
  const path = limited(guard) ? await bookOf(wallet) : undefined;
  const sale: Sale = { id: randomUUID(), mint: NATIVE_MINT, at: now, amount: locks };
  if (path !== undefined) {
    await guard.book.update(path, (sales) => {
      const kept = live(sales, now);
      checkSale(guard, NATIVE_MINT, 9, locks, now, kept);
      return { sales: [...kept, sale], value: undefined };
    });
  }
  try {
    return await sent(ctx, signer, shown, true, call, next);
  } catch (error) {
    if (path !== undefined && refusedBeforeSending(error)) {
      await guard.book.update(path, (sales) => ({ sales: sales.filter((s) => s.id !== sale.id), value: undefined })).catch(() => undefined);
    }
    throw error;
  }
}

function needSecs(secs: number | undefined, action: string): number {
  if (secs === undefined) {
    throw new InvalidInput([{ path: "secs", message: `give secs with action ${action}` }]);
  }
  return secs;
}

type Signer = Awaited<ReturnType<typeof signerOf>>;

type Escrow = { owner: Address; nonce: bigint; intent: Address };

export async function takeStep(client: ReturnType<typeof createClient>, escrow: Escrow, view: ClaimsView, signer: Signer, secs: number, admit: Admit = async () => undefined): Promise<LineStep> {
  const { intent } = escrow;
  const now = await client.chainTime();
  const found = await client.intent({ owner: escrow.owner, nonce: escrow.nonce });
  if (found === null || found.intent.status !== IntentStatus.Open || now >= found.intent.expiresAt) {
    throw new AgentRefusal("InvalidTransition", `escrow ${intent} is no longer open, so its job cannot be claimed`);
  }
  await fillsGoing(client, escrow);
  await admit();
  const board = claimBoard(view);
  let until = 0n;
  const refused = refusedBy(() => {
    until = takeUntil(board, signer.address, { maxSecs: view.maxSecs, secs, expiresAt: found.intent.expiresAt }, now);
  });
  if (refused === "LineWaiting") {
    throw new AgentRefusal("LineWaiting", lineWaitingHere(intent, view.line.waiting));
  }
  if (refused === "ReviewPastExpiry") {
    throw new AgentRefusal("ReviewPastExpiry", reviewPastExpiry(intent, secs, view.reviewSecs, found.intent.expiresAt).replace("--secs", "secs"));
  }
  if (refused === "ClaimHeld") {
    const held = `${heldBy(intent, board.worker, heldFor(view, now))}${reviewHeld(view)}`;
    throw new AgentRefusal("ClaimHeld", board.worker === signer.address ? held : `${held}; join the line with ${tool("wallet_claim")} action standby`);
  }
  const cooling = claimCooldown(board, now);
  if (refused === "ClaimCooldown" && cooling !== null) {
    throw new AgentRefusal("ClaimCooldown", coolingDown(intent, signer.address, cooling.until));
  }
  if (refused === "ClaimTerms") {
    throw new AgentRefusal(
      "ClaimTerms",
      secs > view.maxSecs ? `escrow ${intent} lets a worker hold its claim for at most ${view.maxSecs} seconds; give a lower secs` : `a claim of ${secs} seconds would outlive escrow ${intent}`,
    );
  }
  const stake = `${formatAmount(view.stake, 9)} SOL`;
  const slot = claimAt(view, now);
  return {
    locks: view.stake,
    instruction: await buildClaimJob({ worker: signer, intent, owner: view.owner, secs, ...listAccount(view.list) }),
    summary: [
      `Claims: escrow ${intent} until ${formatTime(until)}, ${until - now} seconds from now; until then only this wallet ${signer.address} can be paid`,
      `Stakes: ${stake}, returned when a release pays this wallet or it drops the claim, and lost to the owner if the claim lapses first`,
      ...(slot.state === "lapsed" ? [`Ends: the lapsed claim of ${slot.worker}, whose stake goes to the owner ${view.owner}`] : []),
      ...protectionLines(claimProtection(reviewBoardOf(view), found.intent.expiresAt, until, null), (lamports) => `${formatAmount(lamports, 9)} SOL`),
    ],
    key: `${secs}:${view.stake}:${view.reviewSecs}:${view.killFee}`,
    done: `you hold ${intent}; do the work, then ${tool("wallet_deliver")} before it lapses`,
  };
}

export async function dropStep(ctx: AgentContext, client: ReturnType<typeof createClient>, escrow: Escrow, view: ClaimsView, signer: Signer): Promise<LineStep> {
  const { intent } = escrow;
  const slot = claimAt(view, await client.chainTime());
  if (slot.state !== "held" || slot.worker !== signer.address) {
    throw new AgentRefusal("NotClaimant", `this wallet ${signer.address} holds no claim on escrow ${intent}`);
  }
  const handover: LineHandover = await dropHandover(client, ctx.transport, escrow.owner, escrow.nonce, intent, view);
  return {
    instruction: await buildDropClaim({ worker: signer, intent, ...handover }),
    summary: [`Drops: this wallet's claim on escrow ${intent}`, `Returns: its stake of ${formatAmount(view.stake, 9)} SOL to ${signer.address}`, ...handedTo(handover)],
    key: `:${view.stake}`,
    done: `dropped; stake returned, job ${handover.nextWorker === undefined ? "free for others" : `handed to ${handover.nextWorker}, next in line`}`,
  };
}
