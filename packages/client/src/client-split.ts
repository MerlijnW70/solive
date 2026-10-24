import { type Address, getPublicKeyFromAddress, type SignatureBytes, type TransactionSigner, verifySignature } from "@solana/kit";
import {
  attestedSplitDigest,
  attestedSplitMessage,
  buildEd25519CosignInstruction,
  buildFillAttestedSplit,
  signMessageBytes,
  splitCommit,
} from "@intent-engine/core";
import { loadCommittee } from "./client-committee.js";
import { CosignRejected, NotSettleable } from "./client-errors.js";
import { committeeJudged } from "./client-settle.js";
import type { BallotInput, Client, ClientContext, ClientPlans, MessageSigner } from "./client-types.js";
import { type Plan, planOf } from "./plan.js";
import { releaseBasis, type ReleaseTarget } from "./release-plan.js";

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

export function splitSettlement(context: ClientContext): SplitSettlement {
  const planned = async (input: SplitBallotInput, payer: TransactionSigner | undefined) => {
    const wallets = input.recipients.map(({ wallet }) => wallet);
    const weights = input.recipients.map(({ weight }) => weight);
    const target: ReleaseTarget = { ...input, payer };
    const basis = await releaseBasis(context, target, () => wallets, async (attestor, intent) => {
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
    return { basis, wallets, weights, terms, cosigners, message: await attestedSplitMessage(terms, cosigners) };
  };

  const splitBallot = async (input: SplitBallotInput): Promise<SplitBallot> => {
    const { basis, terms, cosigners, message } = await planned(input, undefined);
    return { intent: basis.intent, attestor: basis.judge, worker: basis.worker, splitHash: terms.splitHash, digest: await attestedSplitDigest(terms), cosigners, message };
  };

  const settleSplit = async (input: SettleSplitInput): Promise<Plan> => {
    const payer = input.payer ?? input.judge;
    const { basis, wallets, weights, message } = await planned(input, payer);
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
    const recipients = await Promise.all(wallets.map(basis.account));
    const setup = [...recipients.flatMap(({ create }) => create), ...basis.setup];
    const settle = await buildFillAttestedSplit({ ...basis.fill, ...basis.claims, solver: payer, recipients: wallets, weights });
    return planOf({ payer: payer.address, setup, instructions: [buildEd25519CosignInstruction({ entries, message }), settle] });
  };

  return { splitBallot, settleSplit };
}
