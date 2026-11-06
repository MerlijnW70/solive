import { readFile, writeFile } from "node:fs/promises";
import type { Address, TransactionPartialSigner } from "@solana/kit";
import { checkReviewTerms, findIntentPda, MAX_REVIEW_SECS, MIN_REVIEW_SECS, signCommitteeVote } from "@intent-engine/core/internal";
import { isSdkError, type Transport } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { collectable, collectInstruction, envelopeDigest, isDevice, isLedgerPath, loadDeliveryBook } from "@intent-engine/client/internal";
import { workRefusal } from "./reject-check.js";
import { loadEncryptionKeys } from "./sealed-commands.js";
import { previewed } from "./admin-commands.js";
import { claimsAfterDelivery, collectLines, rejectLines } from "./fair-lines.js";
import { parseAddress } from "./arg-values.js";
import type { Command } from "./command-types.js";
import { FlowRefused } from "./flows.js";
import { ReceiptRefused } from "./judge-receipt.js";
import { messageSigner, transactionSigner } from "./ledger-keys.js";
import { authorizeEscrow, CLI_REJECT_NEXT, recorded } from "./receipt-gate.js";
import type { Runtime } from "./runtime.js";

export { reviewLine, reviewPastExpiry } from "./fair-lines.js";

export async function reviewable(transport: Transport, intent: Address, terms: { stake: bigint; reviewSecs: number; killFee: bigint }, floor: bigint | undefined, left: bigint): Promise<void> {
  try {
    checkReviewTerms(terms.reviewSecs, terms.killFee, terms.stake, floor);
  } catch (error) {
    throw new FlowRefused(
      `--review-secs is 0 or ${MIN_REVIEW_SECS} to ${MAX_REVIEW_SECS}, and --kill-fee needs a review window and a stake above 0 and is 0 or at least the rent-exempt minimum: ${error instanceof Error ? error.message : String(error)}; nothing was sent`,
    );
  }
  if ((await loadDeliveryBook(transport, intent)) !== null) {
    throw new FlowRefused(claimsAfterDelivery(intent));
  }
  if (terms.reviewSecs > 0 && left <= BigInt(terms.reviewSecs)) {
    throw new FlowRefused(`escrow ${intent} expires in ${left} seconds, within the review window of ${terms.reviewSecs} seconds, so no claim could arm a review; pass a lower --review-secs, or --review-secs 0; nothing was sent`);
  }
}

type CollectCommand = Extract<Command, { name: "claims-collect" }>;

export async function collectReview(command: CollectCommand, payer: TransactionPartialSigner, transport: Transport, intent: Address, shown: object): Promise<object> {
  const found = await collectable(transport, intent).catch((error: unknown) => {
    throw isSdkError(error, "not-settleable") ? new FlowRefused(`${error.message}; nothing was sent`) : error;
  });
  return previewed(transport, [await collectInstruction(found)], payer, { ...shown, summary: [...collectLines(found), `Pays the fee: ${payer.address}`] }, command.yes);
}

export const REJECT_VOTE_KIND = "reject-vote";

export type RejectVoteFile = { kind: typeof REJECT_VOTE_KIND; intent: Address; committee: Address; announcement: Address; sha256: string; member: Address; signature: string };

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

export function rejectVoteOf(text: string, file: string): RejectVoteFile {
  let parsed: Partial<RejectVoteFile>;
  try {
    parsed = JSON.parse(text) as Partial<RejectVoteFile>;
  } catch {
    throw new FlowRefused(`${file} is not JSON`);
  }
  const vote = ((parsed as { vote?: unknown }).vote ?? parsed) as Partial<RejectVoteFile>;
  if (vote.kind !== REJECT_VOTE_KIND || typeof vote.signature !== "string" || !/^[0-9a-f]{128}$/.test(vote.signature) || typeof vote.sha256 !== "string") {
    throw new FlowRefused(`${file} holds no reject vote`);
  }
  const field = (name: "intent" | "committee" | "announcement" | "member") => parseAddress(String(vote[name] ?? ""), name);
  return { kind: REJECT_VOTE_KIND, intent: field("intent"), committee: field("committee"), announcement: field("announcement"), sha256: vote.sha256, member: field("member"), signature: vote.signature };
}

type RejectCommand = Extract<Command, { name: "reject" }>;

export const REJECT_VOTE_NEXT = "pass the vote files of the committee's threshold to reject --vote, which relays the reject";

export const REJECT_NOT_SENT = "nothing was signed or sent; rerun with --yes to reject";

export const REJECTED = "rejected; the worker sees it in its history and gets back the stake of a claim under review";

export async function rejectCommand(command: RejectCommand, runtime: Runtime, transport: Transport): Promise<object> {
  const [intent] = await findIntentPda({ owner: command.owner, nonce: command.nonce });
  const client = createClient({ url: command.url, transport });
  const target = { intent, announcement: command.announcement };
  const refused = (error: unknown): never => {
    throw isSdkError(error, "not-settleable") || isSdkError(error, "vote-rejected") ? new FlowRefused(`${error.message}; nothing was signed or sent`) : error;
  };
  const ballot = await client.rejectBallot(target).catch(refused);
  const shown = { intent, announcement: command.announcement, worker: ballot.worker, ...(ballot.review === null ? {} : { review_until: ballot.review.until }), summary: rejectLines(ballot, command.sha256) };
  if (command.votes.length > 0) {
    const relayer = await transactionSigner(runtime, command.keypair);
    const files = await Promise.all(command.votes.map(async (file) => rejectVoteOf(await readFile(file, "utf8"), file)));
    const other = files.find((vote) => vote.intent !== intent || vote.announcement !== command.announcement || vote.sha256 !== command.sha256);
    if (other !== undefined) {
      throw new FlowRefused(`the vote of ${other.member} rejects another escrow, announcement or work than this reject; nothing was sent`);
    }
    const votes = files.map((vote) => ({ member: vote.member, signature: Uint8Array.from(Buffer.from(vote.signature, "hex")) }));
    const plan = await client.plan.rejectCommittee({ ...target, relayer, votes }).catch(refused);
    return previewed(transport, plan.instructions, relayer, { ...shown, voters: plan.voters }, command.yes);
  }
  const signer = await messageSigner(runtime, command.keypair);
  const judges = ballot.committee?.members ?? [ballot.attestor];
  if (!judges.includes(signer.address)) {
    throw new FlowRefused(`${signer.address} is not the judge of escrow ${intent}${ballot.committee === null ? "" : " nor a member of its committee"}; nothing was signed or sent`);
  }
  const openers = [...(isLedgerPath(command.keypair) ? [] : [await runtime.loadKeypair(command.keypair)]), ...(await loadEncryptionKeys(runtime, command.encryptionKeypairs))];
  const unchecked = await workRefusal(transport, command.announcement, command.sha256, openers);
  if (unchecked !== undefined) {
    throw new FlowRefused(unchecked);
  }
  const authority = await authorizeEscrow(runtime.home, transport, { owner: command.owner, nonce: command.nonce, intent, deliveredSha256: command.sha256, announcement: command.announcement }, [signer.address], command.withoutReceipt, "fail").catch(
    (error: unknown) => {
      throw error instanceof ReceiptRefused ? new FlowRefused(`${error.why}; ${CLI_REJECT_NEXT}`) : error;
    },
  );
  const checked = { ...shown, ...recorded(authority), digest: ballot.committee === null ? envelopeDigest(ballot.message) : hex(ballot.digest) };
  if (ballot.committee !== null) {
    if (!command.yes) {
      return { ...checked, sent: false, next: "nothing was signed; rerun with --yes to sign this member's reject vote" };
    }
    const signed = await signCommitteeVote(signer, ballot.digest, ballot.committee.members);
    const vote: RejectVoteFile = { kind: REJECT_VOTE_KIND, intent, committee: ballot.committee.address, announcement: command.announcement, sha256: command.sha256, member: signed.member, signature: hex(signed.signature) };
    if (command.out !== undefined) {
      await writeFile(command.out, `${JSON.stringify(vote, null, 2)}\n`);
    }
    return { ...checked, vote, sent: false, next: REJECT_VOTE_NEXT };
  }
  if (!command.yes && isDevice(signer)) {
    return { ...checked, sent: false, next: `${REJECT_NOT_SENT}; the Ledger shows digest when it signs the reject message` };
  }
  if (isDevice(signer)) {
    return { ...checked, sent: true, signature: await client.reject({ ...target, judge: signer }).catch(refused), next: REJECTED };
  }
  const plan = await client.plan.reject({ ...target, judge: signer }).catch(refused);
  const done = await previewed(transport, plan.instructions, signer, checked, command.yes);
  return command.yes ? { ...done, next: REJECTED } : done;
}
