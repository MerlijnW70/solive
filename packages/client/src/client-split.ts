import { type Address, getPublicKeyFromAddress, type Instruction, type SignatureBytes, type TransactionSigner, verifySignature } from "@solana/kit";
import type { CommitteeVote } from "@intent-engine/core";
import {
  attestedSplitDigest,
  attestedSplitMessage,
  buildEd25519CosignInstruction,
  buildFillAttestedSplit,
  buildFillAttestedSplitCommittee,
  committeeMask,
  signMessageBytes,
  splitCommit,
} from "@intent-engine/core/internal";
import { loadCommittee, quorumOf } from "./client-committee.js";
import { CosignRejected, NotSettleable, VoteRejected } from "./client-errors.js";
import { committeeJudged } from "./client-settle.js";
import type { BallotInput, Client, ClientContext, ClientPlans, CommitteeView, MessageSigner } from "./client-types.js";
import { type Plan, planOf } from "./plan.js";
import { releaseBasis, type ReleaseTarget } from "./release-plan.js";
import type { ReleasePreview, ReleaseReads } from "./release-preview.js";

export { quorumOf };

export type SplitShare = { wallet: Address; weight: number };

export type SplitBallotInput = BallotInput & { recipients: readonly SplitShare[] };

export type SplitBallot = {
  intent: Address;
  attestor: Address;
  committee: CommitteeView | null;
  worker: Address;
  splitHash: Uint8Array;
  digest: Uint8Array;
  cosigners: Address[];
  message: Uint8Array;
};

export type CoSignature = { wallet: Address; signature: Uint8Array };

export type SettleSplitInput = SplitBallotInput & { signatures: readonly CoSignature[]; payer?: TransactionSigner } &
  ({ judge: MessageSigner; solver?: undefined; votes?: undefined } | { solver: TransactionSigner; votes: readonly CommitteeVote[]; judge?: undefined });

export const splitPayer = (input: SettleSplitInput): TransactionSigner => input.payer ?? input.judge ?? input.solver;

async function signs(wallet: Address, signature: Uint8Array, message: Uint8Array): Promise<boolean> {
  if (signature.length !== 64) {
    return false;
  }
  try {
    return await verifySignature(await getPublicKeyFromAddress(wallet), signature as SignatureBytes, message);
  } catch {
    return false;
  }
}

export type SplitSettlement = Pick<ClientPlans, "settleSplit"> & Pick<Client, "splitBallot">;

type SplitJudge = { attestor: Address; committee: CommitteeView | null };

async function planned(context: ReleaseReads, input: SplitBallotInput, payer: TransactionSigner | undefined) {
  const wallets = input.recipients.map(({ wallet }) => wallet);
  const weights = input.recipients.map(({ weight }) => weight);
  const target: ReleaseTarget = { ...input, payer };
  const basis = await releaseBasis(context, target, () => input.recipients, async (attestor): Promise<{ feeOwner: Address; judge: SplitJudge }> => {
    const committee = await loadCommittee(context.transport, attestor);
    return { feeOwner: committee?.feeWallet ?? attestor, judge: { attestor, committee } };
  });
  if (!wallets.includes(basis.worker)) {
    throw new NotSettleable(basis.intent, "split-excludes-announcer", `pays only a split that includes ${basis.worker}, who made the announcement; nothing was sent`);
  }
  const { committee } = basis.judge;
  const terms = { ...basis.terms, splitHash: await splitCommit(wallets, weights) };
  const cosigners = [...new Set([...wallets, ...(committee?.members ?? [basis.judge.attestor])])];
  const settle = (solver: TransactionSigner, signers: number) => {
    const fill = { ...basis.fill, ...basis.claims, solver, recipients: wallets, weights };
    return committee === null ? buildFillAttestedSplit(fill) : buildFillAttestedSplitCommittee({ ...fill, committee: committee.address, signers });
  };
  return { basis, wallets, terms, cosigners, settle, message: await attestedSplitMessage(terms, cosigners) };
}

async function ballotOf(found: Awaited<ReturnType<typeof planned>>): Promise<SplitBallot> {
  const { basis, terms, cosigners, message } = found;
  const { attestor, committee } = basis.judge;
  return { intent: basis.intent, attestor, committee, worker: basis.worker, splitHash: terms.splitHash, digest: await attestedSplitDigest(terms), cosigners, message };
}

export type SplitPreview = { ballot: SplitBallot; preview: ReleasePreview; settle: Instruction };

const firstQuorum = (committee: CommitteeView | null): number => (committee === null ? 0 : (1 << committee.threshold) - 1);

export async function splitPreview(context: ReleaseReads, input: SplitBallotInput, payer: TransactionSigner): Promise<SplitPreview> {
  const found = await planned(context, input, payer);
  return { ballot: await ballotOf(found), preview: found.basis.preview, settle: await found.settle(payer, firstQuorum(found.basis.judge.committee)) };
}

async function judgeSignatures(found: Awaited<ReturnType<typeof planned>>, input: SettleSplitInput) {
  const { basis, message } = found;
  const { attestor, committee } = basis.judge;
  if (input.votes === undefined) {
    if (committee !== null) {
      throw new NotSettleable(basis.intent, "committee-judged", committeeJudged(attestor));
    }
    if (attestor !== input.judge.address) {
      throw new NotSettleable(basis.intent, "wrong-judge", `names ${attestor} as its judge, not ${input.judge.address}`);
    }
    return { signed: [{ wallet: attestor, signature: await signMessageBytes(input.judge, message) }], mask: 0, solver: splitPayer(input) };
  }
  const { needed, mask } = await splitQuorum({ intent: basis.intent, attestor, committee, message }, input.votes);
  const signed = needed.map(({ member, signature }) => ({ wallet: member, signature }));
  return { signed, mask, solver: input.solver };
}

export async function splitQuorum(ballot: Pick<SplitBallot, "intent" | "attestor" | "committee" | "message">, votes: readonly CommitteeVote[]) {
  const { intent, attestor, committee, message } = ballot;
  if (committee === null) {
    throw new NotSettleable(intent, "not-a-committee", `names ${attestor} as its judge, which is not a committee`);
  }
  for (const vote of votes) {
    if (!committee.members.includes(vote.member) || !(await signs(vote.member, vote.signature, message))) {
      throw new VoteRejected(vote.member, intent);
    }
  }
  const needed = quorumOf(committee, votes);
  return { needed, mask: committeeMask(committee, needed.map(({ member }) => member)) };
}

export async function checkCosigns(ballot: Pick<SplitBallot, "intent" | "message">, signatures: readonly CoSignature[]): Promise<void> {
  for (const { wallet, signature } of signatures) {
    if (!(await signs(wallet, signature, ballot.message))) {
      throw new CosignRejected(wallet, ballot.intent);
    }
  }
}

export function splitSettlement(context: ClientContext): SplitSettlement {
  const splitBallot = async (input: SplitBallotInput): Promise<SplitBallot> => ballotOf(await planned(context, input, undefined));

  const settleSplit = async (input: SettleSplitInput): Promise<Plan> => {
    const payer = splitPayer(input);
    const found = await planned(context, input, payer);
    const { basis, wallets, message, settle } = found;
    const { signed, mask, solver } = await judgeSignatures(found, input);
    const entries = new Map(signed.map(({ wallet, signature }) => [wallet, signature]));
    const given = new Map(input.signatures.map(({ wallet, signature }) => [wallet, signature]));
    for (const wallet of wallets.filter((one) => !entries.has(one))) {
      const signature = given.get(wallet);
      if (signature === undefined || !(await signs(wallet, signature, message))) {
        throw new CosignRejected(wallet, basis.intent);
      }
      entries.set(wallet, signature);
    }
    const cosign = buildEd25519CosignInstruction({ entries: [...entries].map(([publicKey, signature]) => ({ publicKey, signature })), message });
    return planOf({ payer: payer.address, setup: basis.setup, instructions: [cosign, await settle(solver, mask)] });
  };

  return { splitBallot, settleSplit };
}
