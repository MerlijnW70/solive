import { readFile, writeFile } from "node:fs/promises";
import type { Address, MessagePartialSigner } from "@solana/kit";
import { type CommitteeVote, Kind } from "@intent-engine/core";
import { buildCreateCommittee, decodeParams, findIntentPda, isSaltHex, isSha256Hex, signCommitteeVote } from "@intent-engine/core/internal";
import { type BallotInput, type CommitteeBallot, isSdkError, type Transport } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { confirmOnBoth, firstOpeningIn, isLedgerPath, loadAnnouncement, loadIntent } from "@intent-engine/client/internal";
import { previewed } from "./admin-commands.js";
import { NOBODY_ANNOUNCED, refusalNext } from "./announcement-views.js";
import { parseAddress, parseU64 } from "./arg-values.js";
import type { Command } from "./command-types.js";
import { FlowRefused } from "./flows.js";
import { checkInvited, InviteRefused } from "./invites.js";
import { messageSigner, transactionSigner } from "./ledger-keys.js";
import type { Runtime } from "./runtime.js";
import { loadEncryptionKeys } from "./sealed-commands.js";

export const VOTE_KIND = "committee-vote";

export const VOTE_NOT_SIGNED = "nothing was signed; rerun with --yes to sign this vote, then pass the file to committee release";

export const MEMBER_KEY_FLAG = "pass the encryption key file of that key with --encryption-keypair";

export const MEMBER_WAIT = "the RPC node does not show every announcement yet; vote again in a few seconds";

export type VoteFile = {
  kind: typeof VOTE_KIND;
  intent: Address;
  committee: Address;
  owner: Address;
  nonce: string;
  announcement: Address;
  sha256: string;
  salt: string;
  result: string;
  member: Address;
  signature: string;
};

export type Ballot = { owner: Address; nonce: bigint; announcement: Address; sha256: string; salt: string; result: bigint };

type CommitteeCommand = Extract<Command, { name: "committee-create" | "committee-show" | "committee-vote" | "committee-release" }>;

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

export const ballotInput = (target: Ballot): BallotInput => ({
  intent: { owner: target.owner, nonce: target.nonce },
  announcement: target.announcement,
  opening: { sha256: target.sha256, salt: target.salt },
  result: target.result,
});

async function invitedPayee(runtime: Runtime, transport: Transport, url: string, intent: Address, payTo: Address): Promise<void> {
  await checkInvited(transport, runtime.specFetch, intent, [payTo], { lookup: runtime.lookup, rpcUrl: url }).catch((error: unknown) => {
    throw error instanceof InviteRefused ? new FlowRefused(error.message) : error;
  });
}

async function workerOf(transport: Transport, announcement: Address): Promise<Address> {
  const found = await loadAnnouncement(transport, announcement);
  if (found === null) {
    throw new FlowRefused(`${announcement} is not an announcement of this program; nothing was signed or sent`);
  }
  return found.worker;
}

function ballotLines(ballot: CommitteeBallot, target: Ballot, worker: Address): string[] {
  return [
    `Releases: proof escrow ${ballot.intent} to ${worker} (token account ${ballot.payee}), who made the announcement ${target.announcement}, with result ${target.result}`,
    `Pays for: the work with sha256 ${target.sha256}`,
    `Judged by: committee ${ballot.committee.address}, ${ballot.committee.threshold} of ${ballot.committee.members.length} members must sign`,
  ];
}

export async function memberVote(member: MessagePartialSigner, ballot: CommitteeBallot, target: Ballot): Promise<VoteFile> {
  if (!ballot.committee.members.includes(member.address)) {
    throw new FlowRefused(`${member.address} is not a member of committee ${ballot.committee.address}; nothing was signed`);
  }
  const { signature } = await signCommitteeVote(member, ballot.digest, ballot.committee.members);
  return {
    kind: VOTE_KIND,
    intent: ballot.intent,
    committee: ballot.committee.address,
    owner: target.owner,
    nonce: target.nonce.toString(),
    announcement: target.announcement,
    sha256: target.sha256,
    salt: target.salt,
    result: target.result.toString(),
    member: member.address,
    signature: hex(signature),
  };
}

export function voteOf(text: string, file: string): VoteFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new FlowRefused(`${file} is not JSON`);
  }
  const held = (parsed as { vote?: unknown }).vote ?? parsed;
  const vote = held as Partial<VoteFile>;
  if (vote.kind !== VOTE_KIND || typeof vote.signature !== "string" || !/^[0-9a-f]{128}$/.test(vote.signature)) {
    throw new FlowRefused(`${file} holds no committee vote`);
  }
  const field = (name: keyof VoteFile) => {
    const value = vote[name];
    if (typeof value !== "string") {
      throw new FlowRefused(`${file} holds a committee vote without ${name}`);
    }
    return value;
  };
  const sha256 = field("sha256");
  const salt = field("salt");
  if (!isSha256Hex(sha256)) {
    throw new FlowRefused(`${file} holds a sha256 that is not 64 lowercase hex digits`);
  }
  if (!isSaltHex(salt)) {
    throw new FlowRefused(`${file} holds a salt that is not 32 lowercase hex digits`);
  }
  return {
    kind: VOTE_KIND,
    intent: parseAddress(field("intent"), "intent"),
    committee: parseAddress(field("committee"), "committee"),
    owner: parseAddress(field("owner"), "owner"),
    nonce: parseU64(field("nonce"), "nonce").toString(),
    announcement: parseAddress(field("announcement"), "announcement"),
    sha256,
    salt,
    result: parseU64(field("result"), "result").toString(),
    member: parseAddress(field("member"), "member"),
    signature: vote.signature,
  };
}

export const BALLOT_FIELDS = ["intent", "committee", "owner", "nonce", "announcement", "sha256", "salt", "result"] as const;

export function sameBallot(votes: readonly VoteFile[], files: readonly string[]): Ballot {
  const [first] = votes;
  if (first === undefined) {
    throw new FlowRefused("committee release needs at least one --vote");
  }
  votes.forEach((vote, i) => {
    for (const name of BALLOT_FIELDS) {
      if (vote[name] !== first[name]) {
        throw new FlowRefused(`${files[i]} votes on ${name} ${vote[name]}, but ${files[0]} votes on ${first[name]}`);
      }
    }
  });
  return { owner: first.owner, nonce: BigInt(first.nonce), announcement: first.announcement, sha256: first.sha256, salt: first.salt, result: BigInt(first.result) };
}

async function memberVoteCommand(command: Extract<CommitteeCommand, { name: "committee-vote" }>, runtime: Runtime, transport: Transport): Promise<object> {
  const client = createClient({ url: command.url, transport });
  const member = await messageSigner(runtime, command.keypair);
  const openers = [...(isLedgerPath(command.keypair) ? [] : [await runtime.loadKeypair(command.keypair)]), ...(await loadEncryptionKeys(runtime, command.encryptionKeypairs))];
  const { address: intent, intent: held } = await loadIntent(transport, command.owner, command.nonce);
  const params = decodeParams(held.kind, Uint8Array.from(held.params));
  const judging = params.kind === Kind.AttestedResult ? await client.committee(params.attestor) : null;
  if (judging !== null && !judging.members.includes(member.address)) {
    throw new FlowRefused(`${member.address} is not a member of committee ${judging.address}; nothing was signed`);
  }
  const { list, opening } = await firstOpeningIn(transport, { intent, sha256: command.sha256, keypair: openers });
  if (isSdkError(opening, "first-opening-refused")) {
    throw new FlowRefused(`${opening.message}; ${refusalNext(opening, { key: MEMBER_KEY_FLAG, wait: MEMBER_WAIT, nobody: NOBODY_ANNOUNCED }, list.announcements.length > 0)}`);
  }
  const target: Ballot = { owner: command.owner, nonce: command.nonce, announcement: opening.announcement, sha256: opening.sha256, salt: opening.salt, result: command.result };
  const ballot = await client.committeeBallot(ballotInput(target));
  if (!ballot.committee.members.includes(member.address)) {
    throw new FlowRefused(`${member.address} is not a member of committee ${ballot.committee.address}; nothing was signed`);
  }
  await invitedPayee(runtime, transport, command.url, ballot.intent, opening.worker);
  const summary = ballotLines(ballot, target, opening.worker);
  const skipped = opening.skipped.length === 0 ? {} : { skipped: opening.skipped };
  if (!command.yes) {
    return { intent: ballot.intent, announcement: opening.announcement, seq: opening.seq, digest: hex(ballot.digest), summary, ...skipped, signed: false, next: VOTE_NOT_SIGNED };
  }
  const vote = await memberVote(member, ballot, target);
  if (command.out !== undefined) {
    await writeFile(command.out, `${JSON.stringify(vote, null, 2)}\n`);
  }
  return { summary, ...skipped, signed: true, vote, ...(command.out === undefined ? {} : { written: command.out }) };
}

async function releaseCommand(command: Extract<CommitteeCommand, { name: "committee-release" }>, runtime: Runtime, transport: Transport): Promise<object> {
  const client = createClient({ url: command.url, transport });
  const solver = await transactionSigner(runtime, command.keypair);
  const votes = await Promise.all(command.votes.map(async (file) => voteOf(await readFile(file, "utf8"), file)));
  const target = sameBallot(votes, command.votes);
  const [escrow] = await findIntentPda({ owner: target.owner, nonce: target.nonce });
  const worker = await workerOf(transport, target.announcement);
  await invitedPayee(runtime, transport, command.url, escrow, worker);
  const cast: CommitteeVote[] = votes.map((v) => ({ member: v.member, signature: Uint8Array.from(Buffer.from(v.signature, "hex")) }));
  const release = await client.plan.settleCommittee({ ...ballotInput(target), solver, votes: cast });
  const [first] = votes;
  if (first !== undefined && (first.intent !== release.intent || first.committee !== release.committee.address)) {
    throw new FlowRefused(`the votes are for escrow ${first.intent} and committee ${first.committee}, not ${release.intent} and ${release.committee.address}`);
  }
  if (command.confirmUrl !== undefined) {
    const keypair = isLedgerPath(command.keypair) ? undefined : await runtime.loadKeypair(command.keypair);
    const confirmed = { intent: release.intent, attestor: release.committee.address, sha256: target.sha256, payees: [worker], keypair };
    await confirmOnBoth(transport, runtime.transport(command.confirmUrl), confirmed);
  }
  const summary = [
    `Releases: proof escrow ${release.intent} to ${worker} (token account ${release.payee}), who made the announcement ${target.announcement}, with result ${target.result}`,
    `Signed by: ${release.voters.join(", ")}, ${release.voters.length} of committee ${release.committee.address}, which needs ${release.committee.threshold}`,
    `Pays the fee: ${solver.address}`,
  ];
  const shown = { intent: release.intent, committee: release.committee.address, announcement: target.announcement, signers: release.voters };
  if (release.setup.length === 0) {
    return previewed(transport, release.instructions, solver, { ...shown, summary }, command.yes);
  }
  const setupSummary = "Sets up first, in its own transaction: the token accounts the release pays into";
  if (!command.yes) {
    return previewed(transport, release.setup, solver, { ...shown, summary: [...summary, setupSummary] }, false);
  }
  const prepared = await previewed(transport, release.setup, solver, {}, true);
  const sent = await previewed(transport, release.instructions, solver, { ...shown, summary: [...summary, setupSummary] }, true);
  return { ...sent, setup_signature: (prepared as { signature?: string }).signature };
}

export async function committeeCommand(command: CommitteeCommand, runtime: Runtime, transport: Transport): Promise<object> {
  const client = createClient({ url: command.url, transport });
  switch (command.name) {
    case "committee-create": {
      const payer = await runtime.loadSigner(command.keypair);
      const terms = { members: command.members, threshold: command.threshold, feeWallet: command.feeWallet };
      const { committee, instruction } = await buildCreateCommittee({ ...terms, payer });
      const shown = {
        committee: committee.address,
        members: committee.members,
        threshold: committee.threshold,
        fee_wallet: committee.feeWallet,
      };
      if ((await client.committee(committee.address)) !== null) {
        return { ...shown, sent: false, exists: true };
      }
      const summary = [
        `Creates: committee ${committee.address}; any ${committee.threshold} of its ${committee.members.length} members release an escrow that names it`,
        `Pays judge fees to: ${committee.feeWallet}`,
        `Pays rent: ${payer.address}`,
      ];
      return previewed(transport, [instruction], payer, { ...shown, summary }, command.yes);
    }
    case "committee-show": {
      const found = await client.committee(command.committee);
      if (found === null) {
        throw new FlowRefused(`${command.committee} is not a committee`);
      }
      return {
        committee: found.address,
        members: found.members,
        threshold: found.threshold,
        fee_wallet: found.feeWallet,
        id: hex(found.id),
        created_at: found.createdAt,
      };
    }
    case "committee-vote":
      return memberVoteCommand(command, runtime, transport);
    case "committee-release":
      return releaseCommand(command, runtime, transport);
  }
}
