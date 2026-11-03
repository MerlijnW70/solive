import { type Address, getPublicKeyFromAddress, type Instruction, type SignatureBytes, type TransactionSigner, verifySignature } from "@solana/kit";
import {
  attestedSplitDigest,
  attestedSplitMessage,
  buildEd25519CosignInstruction,
  buildFillAttestedSplit,
  signMessageBytes,
  splitCommit,
} from "@intent-engine/core/internal";
import { loadCommittee } from "./client-committee.js";
import { CosignRejected, NotSettleable } from "./client-errors.js";
import { committeeJudged } from "./client-settle.js";
import type { BallotInput, Client, ClientContext, ClientPlans, MessageSigner } from "./client-types.js";
import { type Plan, planOf } from "./plan.js";
import { releaseBasis, type ReleaseTarget } from "./release-plan.js";
import type { ReleasePreview, ReleaseReads } from "./release-preview.js";

export type SplitShare = { wallet: Address; weight: number };

export type SplitBallotInput = BallotInput & { recipients: readonly SplitShare[] };

export type SplitBallot = {
  intent: Address;
  attestor: Address;
  worker: Address;
  splitHash: Uint8Array;
  digest: Uint8Array;
  cosigners: Address[];
  message: Uint8Array;
};

export type CoSignature = { wallet: Address; signature: Uint8Array };

export type SettleSplitInput = SplitBallotInput & { judge: MessageSigner; signatures: readonly CoSignature[]; payer?: TransactionSigner };

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

async function planned(context: ReleaseReads, input: SplitBallotInput, payer: TransactionSigner | undefined) {
  const wallets = input.recipients.map(({ wallet }) => wallet);
  const weights = input.recipients.map(({ weight }) => weight);
  const target: ReleaseTarget = { ...input, payer };
  const basis = await releaseBasis(context, target, () => input.recipients, async (attestor, intent) => {
    if ((await loadCommittee(context.transport, attestor)) !== null) {
      throw new NotSettleable(intent, "committee-judged", committeeJudged(attestor));
    }
    return { feeOwner: attestor, judge: attestor };
  });
  if (!wallets.includes(basis.worker)) {
    throw new NotSettleable(basis.intent, "split-excludes-announcer", `pays only a split that includes ${basis.worker}, who made the announcement; nothing was sent`);
  }
  const terms = { ...basis.terms, splitHash: await splitCommit(wallets, weights) };
  const cosigners = [...wallets, basis.judge];
  const settle = (solver: TransactionSigner) => buildFillAttestedSplit({ ...basis.fill, ...basis.claims, solver, recipients: wallets, weights });
  return { basis, wallets, terms, cosigners, settle, message: await attestedSplitMessage(terms, cosigners) };
}

async function ballotOf(found: Awaited<ReturnType<typeof planned>>): Promise<SplitBallot> {
  const { basis, terms, cosigners, message } = found;
  return { intent: basis.intent, attestor: basis.judge, worker: basis.worker, splitHash: terms.splitHash, digest: await attestedSplitDigest(terms), cosigners, message };
}

export type SplitPreview = { ballot: SplitBallot; preview: ReleasePreview; settle: Instruction };

export async function splitPreview(context: ReleaseReads, input: SplitBallotInput, payer: TransactionSigner): Promise<SplitPreview> {
  const found = await planned(context, input, payer);
  return { ballot: await ballotOf(found), preview: found.basis.preview, settle: await found.settle(payer) };
}

export function splitSettlement(context: ClientContext): SplitSettlement {
  const splitBallot = async (input: SplitBallotInput): Promise<SplitBallot> => ballotOf(await planned(context, input, undefined));

  const settleSplit = async (input: SettleSplitInput): Promise<Plan> => {
    const payer = input.payer ?? input.judge;
    const { basis, wallets, message, settle } = await planned(context, input, payer);
    if (basis.judge !== input.judge.address) {
      throw new NotSettleable(basis.intent, "wrong-judge", `names ${basis.judge} as its judge, not ${input.judge.address}`);
    }
    const given = new Map(input.signatures.map(({ wallet, signature }) => [wallet, signature]));
    const entries = [];
    for (const wallet of wallets) {
      const signature = given.get(wallet);
      if (signature === undefined || !(await signs(wallet, signature, message))) {
        throw new CosignRejected(wallet, basis.intent);
      }
      entries.push({ publicKey: wallet, signature });
    }
    entries.push({ publicKey: input.judge.address, signature: await signMessageBytes(input.judge, message) });
    return planOf({ payer: payer.address, setup: basis.setup, instructions: [buildEd25519CosignInstruction({ entries, message }), await settle(payer)] });
  };

  return { splitBallot, settleSplit };
}
