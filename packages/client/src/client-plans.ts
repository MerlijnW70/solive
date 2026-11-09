import type { Address, Signature } from "@solana/kit";
import { announcementPlan } from "./announce.js";
import { announcementPlans } from "./announcement-sends.js";
import { committeePlans } from "./client-committee.js";
import { createIntentPlan } from "./client-create.js";
import { intentPlans } from "./client-intents.js";
import { committeeSettlement, proofSettlement } from "./client-settle.js";
import { splitPayer, splitSettlement } from "./client-split.js";
import { claimHeldPlan } from "./held-claim.js";
import { collectPlan, requestCancelPlan } from "./fair-close.js";
import { rejectPlans } from "./fair-reject.js";
import type { Client, ClientContext, ClientPlans } from "./client-types.js";
import { type Plan, planOf, type Sends, submit, submitted } from "./plan.js";
import { PACKET_DATA_SIZE } from "./budget.js";
import { NotSettleable } from "./client-errors.js";
import { intentAddress, type IntentRef } from "./intent-ref.js";
import { BOOK_BATCH, batched, type ReclaimBook } from "./reclaim-books.js";
import { feedbackInstructions } from "./reputation.js";

export function clientPlans(context: ClientContext): ClientPlans {
  const intents = intentPlans(context);
  const announcements = announcementPlans(context);
  const rejects = rejectPlans(context);
  return {
    createIntent: (input) => createIntentPlan(context, input),
    cancel: intents.cancel,
    fill: intents.fill,
    expire: intents.expire,
    close: intents.close,
    settleProof: proofSettlement(context),
    settleCommittee: committeeSettlement(context).settleCommittee,
    settleSplit: splitSettlement(context).settleSplit,
    claimHeld: (input) => claimHeldPlan(context, input),
    announce: (input) => announcementPlan(context, input),
    refute: announcements.refute,
    reclaim: announcements.reclaim,
    closeBook: announcements.closeBook,
    feedback: async (input) => planOf({ payer: input.owner.address, instructions: await feedbackInstructions(context.transport, input) }),
    createCommittee: committeePlans(context).createCommittee,
    unwrap: intents.unwrap,
    requestCancel: requestCancelPlan(context),
    reject: rejects.reject,
    rejectCommittee: rejects.rejectCommittee,
    collect: collectPlan(context),
  };
}

export type PlanWrites = Pick<
  Client,
  | "createIntent"
  | "cancel"
  | "fill"
  | "expire"
  | "close"
  | "settleProof"
  | "settleCommittee"
  | "settleSplit"
  | "claimHeld"
  | "refute"
  | "reclaim"
  | "closeBook"
  | "feedback"
  | "createCommittee"
  | "unwrap"
  | "requestCancel"
  | "reject"
  | "rejectCommittee"
  | "collect"
>;

export const releaseTooLarge = (bytes: number): string =>
  `builds a ${bytes}-byte release transaction, over the ${PACKET_DATA_SIZE}-byte packet limit; send it through an address lookup table holding its accounts; nothing was sent`;

export function planWrites(send: Sends, plan: ClientPlans, bytes: ClientContext["bytes"]): PlanWrites {
  const fitting = async <T extends Plan>(intent: IntentRef, planned: T, payer: Address): Promise<T> => {
    const size = await bytes(planned.instructions, payer);
    if (size > PACKET_DATA_SIZE) {
      throw new NotSettleable(await intentAddress(intent), "too-large", releaseTooLarge(size));
    }
    return planned;
  };
  return {
    createIntent: async (input) => {
      const planned = await plan.createIntent(input);
      return { signature: await submit(send, planned, input.signer), intent: planned.intent, nonce: planned.nonce };
    },
    cancel: async (signer, intent) => submit(send, await plan.cancel(signer, intent), signer),
    fill: async (input) => submit(send, await plan.fill(input), input.solver),
    expire: async (cranker, intent) => submit(send, await plan.expire(cranker, intent), cranker),
    close: async (cranker, intent) => submit(send, await plan.close(cranker, intent), cranker),
    settleProof: async (input) => submit(send, await plan.settleProof(input), input.payer ?? input.judge),
    settleCommittee: async (input) => {
      const by = input.payer ?? input.solver;
      return submit(send, await fitting(input.intent, await plan.settleCommittee(input), by.address), by);
    },
    settleSplit: async (input) => {
      const by = splitPayer(input);
      return submit(send, await fitting(input.intent, await plan.settleSplit(input), by.address), by);
    },
    claimHeld: async (input) => submit(send, await plan.claimHeld(input), input.payer ?? input.wallet),
    refute: async (input) => {
      const planned = await plan.refute(input);
      return { refutation: planned.refutation, signature: await submit(send, planned, input.payer ?? input.worker) };
    },
    reclaim: async (input) => {
      const planned = await plan.reclaim(input);
      const signatures: Signature[] = [];
      const by = input.payer ?? input.worker;
      for (const batch of planned.batches) {
        signatures.push(await submit(send, planOf({ payer: planned.payer, instructions: batch }), by));
      }
      const books: Address[] = [];
      const unclosed: Address[] = [];
      const closeOf = async (shelf: readonly ReclaimBook[]): Promise<boolean> => {
        try {
          signatures.push(await submit(send, planOf({ payer: planned.payer, instructions: shelf.map(({ instruction }) => instruction) }), by));
          books.push(...shelf.map(({ book }) => book));
          return true;
        } catch {
          return false;
        }
      };
      for (const shelf of batched(planned.books, BOOK_BATCH)) {
        if (await closeOf(shelf)) {
          continue;
        }
        for (const one of shelf) {
          if (shelf.length === 1 || !(await closeOf([one]))) {
            unclosed.push(one.book);
          }
        }
      }
      return { closed: planned.closed, kept: planned.kept, reasons: planned.reasons, books, unclosed, signatures };
    },
    closeBook: async (intent, by) => submit(send, await plan.closeBook(intent, by), by),
    feedback: async (input) => submit(send, await plan.feedback(input), input.owner),
    createCommittee: async (input) => {
      const planned = await plan.createCommittee(input);
      return { committee: planned.committee, signature: await submitted(send, planned, input.payer) };
    },
    unwrap: async (signer) => submitted(send, await plan.unwrap(signer), signer),
    requestCancel: async (signer, intent) => submit(send, await plan.requestCancel(signer, intent), signer),
    reject: async (input) => submit(send, await plan.reject(input), input.payer ?? input.judge),
    rejectCommittee: async (input) => submit(send, await plan.rejectCommittee(input), input.relayer),
    collect: async (payer, intent) => submit(send, await plan.collect(payer, intent), payer),
  };
}
