import { type Address, createNoopSigner, getAddressDecoder, type Instruction, type TransactionSigner } from "@solana/kit";
import {
  attestedProofMessage,
  buildCommitteeBatch,
  buildFillAttested,
  claimBoardAddress,
  CLAIMS_OPEN,
  getClaimBoardDecoder,
  getClaimBoardDiscriminatorBytes,
  IntentCoreError,
  stakeReceiverOnRelease,
  buildFillAttestedCommittee,
  committeeProofDigest,
  committeeSigners,
  decodeParams,
  feeBpsFor,
  IntentStatus,
  isSha256Hex,
  Kind,
  releaseMemo,
  signEd25519Instruction,
  splitFees,
  verifyCommitteeVote,
} from "@intent-engine/core";
import { chainTime, createdAccount, engineAccount, loadIntent, SYSTEM_PROGRAM_ADDRESS } from "./accounts.js";
import { loadCommittee } from "./client-committee.js";
import { EscrowExpired, NotSettleable, PayeeMoved, PayToNotWallet, VoteRejected } from "./client-errors.js";
import type {
  BallotInput,
  ClientContext,
  CommitteeBallot,
  CommitteeRelease,
  SettleCommitteeInput,
  SettleProofInput,
} from "./client-types.js";
import { memoInstruction } from "./jobs.js";
import type { Transport } from "./transport.js";
import { tokenAccountIfMissing } from "./setup.js";

type ReleaseTarget = {
  owner: Address;
  nonce: bigint;
  payTo: Address;
  result: bigint;
  payer: TransactionSigner;
  deliveredSha256?: string | undefined;
};

async function claimStakeTo(transport: Transport, intent: Address, claims: number, payTo: Address): Promise<Address | null> {
  if (claims !== CLAIMS_OPEN) return null;
  const board = await claimBoardAddress(intent);
  const data = await engineAccount(transport, board, getClaimBoardDiscriminatorBytes(), "claim board");
  const view = getClaimBoardDecoder().decode(data);
  try {
    return stakeReceiverOnRelease(view, await chainTime(transport), [payTo]);
  } catch (error) {
    if (error instanceof IntentCoreError) {
      throw new NotSettleable(intent, `is claimed by ${view.worker} until ${view.until}, so only that worker can be paid until then`);
    }
    throw error;
  }
}

function checkedSha256(deliveredSha256: string | undefined) {
  const lowered = deliveredSha256?.toLowerCase();
  if (lowered !== undefined && !isSha256Hex(lowered)) {
    throw new RangeError("deliveredSha256 must be 64 hex digits");
  }
  return lowered;
}

type Judged<J> = { feeOwner: Address; judge: J };

async function planRelease<J>(
  { transport, mint, config }: ClientContext,
  target: ReleaseTarget,
  judgeOf: (attestor: Address, intent: Address) => Promise<Judged<J>>,
) {
  const { owner, nonce, payTo, result, payer } = target;
  const [{ address, intent: held }, settings] = await Promise.all([loadIntent(transport, owner, nonce), config()]);
  const params = decodeParams(held.kind, Uint8Array.from(held.params));
  if (params.kind !== Kind.AttestedResult) {
    throw new NotSettleable(address, "is not an AttestedResult intent");
  }
  if (params.specHash.every((b) => b === 0)) {
    throw new NotSettleable(address, "commits no spec hash, so it is not a proof intent");
  }
  if (held.status !== IntentStatus.Open) {
    throw new NotSettleable(address, "is not open");
  }
  const { feeOwner, judge } = await judgeOf(params.attestor, address);
  if (held.expiresAt <= (await chainTime(transport))) {
    throw new EscrowExpired(address, held.expiresAt);
  }
  const holder = await transport.getAccount(payTo);
  if (holder !== null && holder.owner !== SYSTEM_PROGRAM_ADDRESS) {
    throw new PayToNotWallet(payTo, holder.owner);
  }
  const stakeTo = await claimStakeTo(transport, address, held.claims, payTo);
  const { tokenProgram } = await mint(held.inputMint);
  const account = (wallet: Address) => tokenAccountIfMissing(transport, payer, wallet, held.inputMint, tokenProgram);
  const amountIn = held.escrowed - held.filled;
  const kindBps = feeBpsFor(settings, held.kind);
  const maxFeeBps = kindBps + held.partnerBps;
  const shares = splitFees(amountIn - params.judgeFee, kindBps, held.partnerBps, held.partnerCutBps);
  const feeRecipient = shares.protocol > 0n ? settings.feeRecipient : undefined;
  const partner = shares.partner > 0n ? held.partner : undefined;
  const paidJudge = params.judgeFee > 0n ? feeOwner : undefined;
  const payee = await account(payTo);
  if (payee.create.length === 0) {
    const existing = await createdAccount(transport, payee.address);
    const data = existing === null || existing.owner !== tokenProgram || existing.data.length < 64 ? null : existing.data;
    if (
      data === null ||
      getAddressDecoder().decode(data.subarray(0, 32)) !== held.inputMint ||
      getAddressDecoder().decode(data.subarray(32, 64)) !== payTo
    ) {
      throw new PayeeMoved(payTo, payee.address);
    }
  }
  const others = await Promise.all([feeRecipient, partner, paidJudge].filter((wallet) => wallet !== undefined).map(account));
  const fields = { amountIn, result, maxFeeBps };
  return {
    intent: address,
    judge,
    proof: {
      ...fields,
      domain: Uint8Array.from(settings.domain),
      intent: address,
      payee: payee.address,
      filled: held.filled,
      revision: held.revision,
      specHash: params.specHash,
    },
    fill: {
      ...fields,
      owner,
      nonce,
      inputMint: held.inputMint,
      inputTokenProgram: tokenProgram,
      payee: payee.address,
      ...(feeRecipient === undefined ? {} : { feeRecipient }),
      ...(partner === undefined ? {} : { partner }),
      ...(paidJudge === undefined ? {} : { judge: paidJudge }),
    },
    setup: [payee, ...others].flatMap(({ create }): Instruction[] => create),
    claims:
      held.claims === CLAIMS_OPEN
        ? { claims: await claimBoardAddress(address), ...(stakeTo === null ? {} : { stakeTo }) }
        : {},
  };
}

function recorded(payer: TransactionSigner, deliveredSha256: string | undefined) {
  return deliveredSha256 === undefined ? [] : [memoInstruction(payer, releaseMemo(deliveredSha256))];
}

export function proofSettlement(context: ClientContext) {
  const settleProof = async (input: SettleProofInput) => {
    const { judge } = input;
    const deliveredSha256 = checkedSha256(input.deliveredSha256);
    const payer = input.payer ?? judge;
    const plan = await planRelease(context, { ...input, payer }, async (attestor, intent) => {
      if (attestor !== judge.address) {
        throw new NotSettleable(intent, `names ${attestor} as its judge, not ${judge.address}`);
      }
      return { feeOwner: judge.address, judge: judge.address };
    });
    const message = await attestedProofMessage(judge.address, plan.proof);
    const settle = await buildFillAttested({ ...plan.fill, ...plan.claims, solver: judge });
    return context.send(
      [...plan.setup, await signEd25519Instruction(judge, message), settle, ...recorded(judge, deliveredSha256)],
      payer,
    );
  };
  return settleProof;
}

export function committeeSettlement(context: ClientContext) {
  const planned = async (target: ReleaseTarget) => {
    const plan = await planRelease(context, target, async (attestor, intent) => {
      const committee = await loadCommittee(context.transport, attestor);
      if (committee === null) {
        throw new NotSettleable(intent, `names ${attestor} as its judge, which is not a committee`);
      }
      return { feeOwner: committee.feeWallet, judge: committee };
    });
    return { plan, committee: plan.judge, digest: await committeeProofDigest(plan.proof) };
  };

  const committeeBallot = async (input: BallotInput): Promise<CommitteeBallot> => {
    const { plan, committee, digest } = await planned({ ...input, payer: createNoopSigner(input.payTo) });
    return { intent: plan.intent, committee, payee: plan.proof.payee, digest };
  };

  const prepareCommitteeRelease = async (input: SettleCommitteeInput): Promise<CommitteeRelease> => {
    const deliveredSha256 = checkedSha256(input.deliveredSha256);
    const payer = input.payer ?? input.solver;
    const { plan, committee, digest } = await planned({ ...input, payer });
    for (const vote of input.votes) {
      if (!(await verifyCommitteeVote(vote, digest))) {
        throw new VoteRejected(vote.member, plan.intent);
      }
    }
    if (deliveredSha256 !== undefined && !input.votes.some((vote) => vote.member === input.solver.address)) {
      throw new NotSettleable(plan.intent, `records the delivered work only when a member who voted submits the release, and ${input.solver.address} did not vote`);
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
      instructions: [instruction, settle, ...recorded(input.solver, deliveredSha256)],
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
