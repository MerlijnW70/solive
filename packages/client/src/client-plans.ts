import type { Signature } from "@solana/kit";
import { announcementPlan } from "./announce.js";
import { announcementPlans } from "./announcement-sends.js";
import { committeePlans } from "./client-committee.js";
import { createIntentPlan } from "./client-create.js";
import { intentPlans } from "./client-intents.js";
import { committeeSettlement, proofSettlement } from "./client-settle.js";
import { splitSettlement } from "./client-split.js";
import type { Client, ClientContext, ClientPlans } from "./client-types.js";
import { planOf, type Sends, submit, submitted } from "./plan.js";
import { feedbackInstructions } from "./reputation.js";

export function clientPlans(context: ClientContext): ClientPlans {
  const intents = intentPlans(context);
  const announcements = announcementPlans(context);
  return {
    createIntent: (input) => createIntentPlan(context, input),
    cancel: intents.cancel,
    fill: intents.fill,
    expire: intents.expire,
    close: intents.close,
    settleProof: proofSettlement(context),
    settleCommittee: committeeSettlement(context).settleCommittee,
    settleSplit: splitSettlement(context).settleSplit,
    announce: (input) => announcementPlan(context, input),
    refute: announcements.refute,
    reclaim: announcements.reclaim,
    closeBook: announcements.closeBook,
    feedback: async (input) => planOf({ payer: input.owner.address, instructions: await feedbackInstructions(context.transport, input) }),
    createCommittee: committeePlans(context).createCommittee,
    unwrap: intents.unwrap,
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
  | "refute"
  | "reclaim"
  | "closeBook"
  | "feedback"
  | "createCommittee"
  | "unwrap"
>;

export function planWrites(send: Sends, plan: ClientPlans): PlanWrites {
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
    settleCommittee: async (input) => submit(send, await plan.settleCommittee(input), input.payer ?? input.solver),
    settleSplit: async (input) => submit(send, await plan.settleSplit(input), input.payer ?? input.judge),
    refute: async (input) => {
      const planned = await plan.refute(input);
      return { refutation: planned.refutation, signature: await submit(send, planned, input.payer ?? input.worker) };
    },
    reclaim: async (input) => {
      const planned = await plan.reclaim(input);
      const signatures: Signature[] = [];
      for (const batch of planned.batches) {
        signatures.push(await submit(send, planOf({ payer: planned.payer, instructions: batch }), input.payer ?? input.worker));
      }
      return { closed: planned.closed, kept: planned.kept, signatures };
    },
    closeBook: async (intent, by) => submit(send, await plan.closeBook(intent, by), by),
    feedback: async (input) => submit(send, await plan.feedback(input), input.owner),
    createCommittee: async (input) => {
      const planned = await plan.createCommittee(input);
      return { committee: planned.committee, signature: await submitted(send, planned, input.payer) };
    },
    unwrap: async (signer) => submitted(send, await plan.unwrap(signer), signer),
  };
}
