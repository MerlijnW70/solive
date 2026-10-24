import { type Address, createNoopSigner } from "@solana/kit";
import {
  attestedDeliveryFields,
  attestedDeliveryPreimage,
  attestedProofMessage,
  buildCommitteeBatch,
  buildFillAttested,
  buildFillAttestedCommittee,
  committeeProofDigest,
  committeeSigners,
  signEd25519Instruction,
  verifyCommitteeVote,
} from "@intent-engine/core";
import { loadCommittee } from "./client-committee.js";
import { NotSettleable, VoteRejected } from "./client-errors.js";
import type {
  BallotInput,
  ClientContext,
  CommitteeBallot,
  CommitteeRelease,
  ProofBallot,
  SettleCommitteeInput,
  SettleProofInput,
} from "./client-types.js";
import { planRelease, type ReleaseTarget } from "./release-plan.js";

const digestOf = async (bytes: Uint8Array): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice()));

const ballotTarget = (input: BallotInput): ReleaseTarget => ({ ...input, payer: createNoopSigner(input.owner) });

export function proofSettlement(context: ClientContext) {
  return async (input: SettleProofInput) => {
    const { judge } = input;
    const payer = input.payer ?? judge;
    const plan = await planRelease(context, { ...input, payer }, async (attestor, intent) => {
      if (attestor !== judge.address) {
        throw new NotSettleable(intent, "wrong-judge", `names ${attestor} as its judge, not ${judge.address}`);
      }
      return { feeOwner: judge.address, judge: judge.address };
    });
    const message = await attestedProofMessage(judge.address, plan.proof);
    const settle = await buildFillAttested({ ...plan.fill, ...plan.claims, solver: payer });
    return context.send([...plan.setup, await signEd25519Instruction(judge, message), settle], payer);
  };
}

export const committeeJudged = (attestor: Address): string =>
  `names committee ${attestor} as its judge, so its members sign committee votes, not this release`;

export function proofBallotOf(context: ClientContext) {
  return async (input: BallotInput): Promise<ProofBallot> => {
    const plan = await planRelease(context, ballotTarget(input), async (attestor, intent) => {
      if ((await loadCommittee(context.transport, attestor)) !== null) {
        throw new NotSettleable(intent, "committee-judged", committeeJudged(attestor));
      }
      return { feeOwner: attestor, judge: attestor };
    });
    const digest = await digestOf(attestedDeliveryPreimage(await attestedDeliveryFields(plan.proof)));
    return { intent: plan.intent, attestor: plan.judge, payee: plan.proof.payee, digest, message: await attestedProofMessage(plan.judge, plan.proof) };
  };
}

export function committeeSettlement(context: ClientContext) {
  const planned = async (target: ReleaseTarget) => {
    const plan = await planRelease(context, target, async (attestor, intent) => {
      const committee = await loadCommittee(context.transport, attestor);
      if (committee === null) {
        throw new NotSettleable(intent, "not-a-committee", `names ${attestor} as its judge, which is not a committee`);
      }
      return { feeOwner: committee.feeWallet, judge: committee };
    });
    return { plan, committee: plan.judge, digest: await committeeProofDigest(plan.proof) };
  };

  const committeeBallot = async (input: BallotInput): Promise<CommitteeBallot> => {
    const { plan, committee, digest } = await planned(ballotTarget(input));
    return { intent: plan.intent, committee, payee: plan.proof.payee, digest };
  };

  const prepareCommitteeRelease = async (input: SettleCommitteeInput): Promise<CommitteeRelease> => {
    const payer = input.payer ?? input.solver;
    const { plan, committee, digest } = await planned({ ...input, payer });
    for (const vote of input.votes) {
      if (!(await verifyCommitteeVote(vote, digest, committee.members))) {
        throw new VoteRejected(vote.member, plan.intent);
      }
    }
    const needed = [...input.votes]
      .sort((a, b) => committee.members.indexOf(a.member) - committee.members.indexOf(b.member))
      .slice(0, committee.threshold);
    const { instruction, mask } = buildCommitteeBatch(committee, digest, needed);
    const settle = await buildFillAttestedCommittee({
      ...plan.fill,
      ...plan.claims,
      solver: input.solver,
      committee: committee.address,
      signers: mask,
    });
    return {
      intent: plan.intent,
      committee,
      payee: plan.proof.payee,
      signers: committeeSigners(committee, mask),
      payer,
      setup: plan.setup,
      instructions: [instruction, settle],
    };
  };

  const settleCommittee = async (input: SettleCommitteeInput) => {
    const { setup, instructions, payer } = await prepareCommitteeRelease(input);
    if (setup.length > 0) {
      await context.send(setup, payer);
    }
    return context.send(instructions, payer);
  };

  return { committeeBallot, prepareCommitteeRelease, settleCommittee };
}
