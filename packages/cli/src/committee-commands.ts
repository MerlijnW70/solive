import { readFile, writeFile } from "node:fs/promises";
import { type Address, createNoopSigner, type Instruction, type MessagePartialSigner, type TransactionPartialSigner, type TransactionSigner } from "@solana/kit";
import { type CommitteeVote, formatAmount, Kind } from "@intent-engine/core";
import { buildCreateCommittee, decodeParams, findIntentPda, isSaltHex, isSha256Hex, signCommitteeVote, signMessageBytes } from "@intent-engine/core/internal";
import { type BallotInput, type CommitteeBallot, isSdkError, type Transport } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import {
  confirmOnBoth,
  firstOpeningIn,
  intentAt,
  isLedgerPath,
  loadAnnouncement,
  loadIntent,
  mintOf,
  PACKET_DATA_SIZE,
  quorumOf,
  releaseReads,
  type SplitShare,
  splitPreview,
} from "@intent-engine/client/internal";
import { decodeLookupTable } from "@intent-engine/solver";
import { committeeFees, heldWarnings } from "./agent/wallet/split.js";
import { previewed } from "./admin-commands.js";
import { prepare, transactionSize } from "./agent/prepare.js";
import { preparedView } from "./agent/shapes.js";
import { NOBODY_ANNOUNCED, refusalNext, skippedLines } from "./announcement-views.js";
import { parseAddress, parseU64 } from "./arg-values.js";
import type { Command } from "./command-types.js";
import { execute, FlowRefused, NOT_SENT } from "./flows.js";
import { checkInvited, InviteRefused } from "./invites.js";
import { messageSigner, transactionSigner } from "./ledger-keys.js";
import type { Runtime } from "./runtime.js";
import { loadEncryptionKeys } from "./sealed-commands.js";
import { TOKEN_NAMES } from "./tokens.js";
import { ReceiptRefused } from "./judge-receipt.js";
import { type Authority, authorizeEscrow, cliRefusal, recorded, type Target } from "./receipt-gate.js";

export const VOTE_KIND = "committee-vote";

export const VOTE_NOT_SIGNED = "nothing was signed; rerun with --yes to sign this vote, then pass the file to committee release";

export const SPLIT_VOTE_NOT_SIGNED =
  "nothing was signed; rerun with --yes to sign this vote, then pass the file to committee release; every co-author signs the envelope and gives committee release its signature with --cosign <wallet>:<128 hex>";

export const MEMBER_KEY_FLAG = "pass the encryption key file of that key with --encryption-keypair";

export const MEMBER_WAIT = "the RPC node does not show every announcement yet; vote again in a few seconds";

export const COSIGN_FLAG = "pass each co-author's signature over the envelope committee vote prints with --cosign <wallet>:<128 hex>; a member's vote counts as its own";

export const committeeTooLarge = (size: number, withTable: boolean): string =>
  `ReleaseTooLarge: this committee release builds a ${size}-byte transaction, over the ${PACKET_DATA_SIZE}-byte limit; ${
    withTable ? "even with the lookup table, so it cannot be sent" : "pass --lookup-table with an address lookup table holding the lookup_accounts this preview prints"
  }; nothing was sent`;

export const splitTooLarge = (size: number, withTable: boolean): string =>
  `ReleaseTooLarge: this split release builds a ${size}-byte transaction, over the ${PACKET_DATA_SIZE}-byte limit; ${
    withTable ? "even with the lookup table, so reduce recipients" : "pass --lookup-table with an address lookup table holding the lookup_accounts this preview prints"
  }; nothing was sent`;

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
  recipients?: SplitShare[];
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

async function invitedPayee(runtime: Runtime, transport: Transport, url: string, intent: Address, payTo: readonly Address[]): Promise<void> {
  await checkInvited(transport, runtime.specFetch, intent, payTo, { lookup: runtime.lookup, rpcUrl: url }).catch((error: unknown) => {
    throw error instanceof InviteRefused ? new FlowRefused(error.message) : error;
  });
}

async function cliAuthority(runtime: Runtime, transport: Transport, at: Omit<Target, "cluster" | "specSha256">, judges: readonly Address[], override: string | undefined): Promise<Authority> {
  try {
    return await authorizeEscrow(runtime.home, transport, at, judges, override);
  } catch (error) {
    throw error instanceof ReceiptRefused ? new FlowRefused(cliRefusal(error)) : error;
  }
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

const voteFile = (ballot: { intent: Address; committee: Address }, target: Ballot, member: Address, signature: Uint8Array): VoteFile => ({
  kind: VOTE_KIND,
  intent: ballot.intent,
  committee: ballot.committee,
  owner: target.owner,
  nonce: target.nonce.toString(),
  announcement: target.announcement,
  sha256: target.sha256,
  salt: target.salt,
  result: target.result.toString(),
  member,
  signature: hex(signature),
});

export async function memberVote(member: MessagePartialSigner, ballot: CommitteeBallot, target: Ballot): Promise<VoteFile> {
  if (!ballot.committee.members.includes(member.address)) {
    throw new FlowRefused(`${member.address} is not a member of committee ${ballot.committee.address}; nothing was signed`);
  }
  const { signature } = await signCommitteeVote(member, ballot.digest, ballot.committee.members);
  return voteFile({ intent: ballot.intent, committee: ballot.committee.address }, target, member.address, signature);
}

function sharesIn(value: unknown, file: string): SplitShare[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new FlowRefused(`${file} holds a committee vote whose recipients are not a list of wallets and weights`);
  }
  return value.map((one: { wallet?: unknown; weight?: unknown }) => {
    if (typeof one.wallet !== "string" || typeof one.weight !== "number" || !Number.isInteger(one.weight) || one.weight < 1 || one.weight > 10_000) {
      throw new FlowRefused(`${file} holds a committee vote whose recipients are not a list of wallets and weights`);
    }
    return { wallet: parseAddress(one.wallet, "recipients"), weight: one.weight };
  });
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
  const field = (name: Exclude<keyof VoteFile, "recipients">) => {
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
    ...(vote.recipients === undefined ? {} : { recipients: sharesIn(vote.recipients, file) }),
  };
}

export const BALLOT_FIELDS = ["intent", "committee", "owner", "nonce", "announcement", "sha256", "salt", "result"] as const;

const splitOfVote = (vote: VoteFile): string => (vote.recipients === undefined ? "no split" : vote.recipients.map((r) => `${r.wallet}:${r.weight}`).join(","));

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
    if (splitOfVote(vote) !== splitOfVote(first)) {
      throw new FlowRefused(`${files[i]} votes on the split ${splitOfVote(vote)}, but ${files[0]} votes on ${splitOfVote(first)}`);
    }
  });
  return { owner: first.owner, nonce: BigInt(first.nonce), announcement: first.announcement, sha256: first.sha256, salt: first.salt, result: BigInt(first.result) };
}

async function splitView(transport: Transport, target: Ballot, recipients: readonly SplitShare[], payer: TransactionSigner) {
  const found = await splitPreview(releaseReads(transport), { ...ballotInput(target), recipients }, payer);
  const { ballot, preview } = found;
  const { committee } = ballot;
  if (committee === null) {
    throw new FlowRefused(`proof escrow ${ballot.intent} is judged by a single key, not a committee, so its judge releases the split; nothing was signed or sent`);
  }
  const held = await intentAt(transport, ballot.intent);
  if (held === null) {
    throw new FlowRefused(`${ballot.intent} is no longer an open escrow; nothing was signed or sent`);
  }
  const mint = held.inputMint;
  const { decimals, tokenProgram } = await mintOf(transport, mint);
  const name = TOKEN_NAMES[mint] ?? mint;
  const paid = recipients.map((r, i) => ({ wallet: r.wallet, weight: r.weight, amount: formatAmount(preview.payees[i]?.amount ?? 0n, decimals) }));
  const lines = [
    `Splits: ${formatAmount(preview.net, decimals)} of ${name} from proof escrow ${ballot.intent} among ${recipients.length} co-authors, with result ${target.result}`,
    ...paid.map((r) => `  ${r.wallet}: ${r.weight} bps -> ${r.amount} of ${name}`),
    `Pays for: the work with sha256 ${target.sha256}, announced in ${target.announcement} by ${ballot.worker}`,
    `Judged by: committee ${committee.address}, ${committee.threshold} of ${committee.members.length} members must sign`,
    ...committeeFees(preview, committee.feeWallet, name, decimals),
    ...heldWarnings(preview),
  ];
  return { ...found, committee, lines, paid, tokenProgram };
}

async function splitVoteCommand(member: MessagePartialSigner, transport: Transport, target: Ballot, recipients: readonly SplitShare[], command: { yes: boolean; out: string | undefined }, authority: Authority) {
  const { ballot, committee, lines, paid } = await splitView(transport, target, recipients, createNoopSigner(member.address));
  if (!committee.members.includes(member.address)) {
    throw new FlowRefused(`${member.address} is not a member of committee ${committee.address}; nothing was signed`);
  }
  const shown = { intent: ballot.intent, announcement: target.announcement, digest: hex(ballot.digest), envelope: hex(ballot.message), paid, summary: lines, ...recorded(authority) };
  if (!command.yes) {
    return { ...shown, signed: false, next: SPLIT_VOTE_NOT_SIGNED };
  }
  const vote = { ...voteFile({ intent: ballot.intent, committee: committee.address }, target, member.address, await signMessageBytes(member, ballot.message)), recipients: [...recipients] };
  if (command.out !== undefined) {
    await writeFile(command.out, `${JSON.stringify(vote, null, 2)}\n`);
  }
  return { ...shown, signed: true, vote, ...(command.out === undefined ? {} : { written: command.out }) };
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
  const skipped = opening.skipped.length === 0 ? {} : { skipped: skippedLines(opening) };
  const at = { owner: command.owner, nonce: command.nonce, intent, deliveredSha256: opening.sha256, announcement: opening.announcement };
  const authority = await cliAuthority(runtime, transport, at, [member.address], command.withoutReceipt);
  if (command.split !== undefined) {
    const { recipients, weights } = command.split;
    const shares = recipients.map((wallet, i) => ({ wallet, weight: weights[i] ?? 0 }));
    await invitedPayee(runtime, transport, command.url, intent, recipients);
    return { ...(await splitVoteCommand(member, transport, target, shares, command, authority)), seq: opening.seq, ...skipped };
  }
  const ballot = await client.committeeBallot(ballotInput(target));
  if (!ballot.committee.members.includes(member.address)) {
    throw new FlowRefused(`${member.address} is not a member of committee ${ballot.committee.address}; nothing was signed`);
  }
  await invitedPayee(runtime, transport, command.url, ballot.intent, [opening.worker]);
  const summary = ballotLines(ballot, target, opening.worker);
  if (!command.yes) {
    return { intent: ballot.intent, announcement: opening.announcement, seq: opening.seq, digest: hex(ballot.digest), summary, ...skipped, ...recorded(authority), signed: false, next: VOTE_NOT_SIGNED };
  }
  const vote = await memberVote(member, ballot, target);
  if (command.out !== undefined) {
    await writeFile(command.out, `${JSON.stringify(vote, null, 2)}\n`);
  }
  return { summary, ...skipped, ...recorded(authority), signed: true, vote, ...(command.out === undefined ? {} : { written: command.out }) };
}

async function sentWith(transport: Transport, instructions: Instruction[], solver: TransactionPartialSigner, tables: Record<Address, Address[]> | undefined, shown: object, yes: boolean): Promise<object> {
  const prepared = await prepare(transport, instructions, solver.address, tables);
  if (!yes) {
    return { ...shown, sent: false, units_consumed: prepared.unitsConsumed, next: NOT_SENT };
  }
  return { ...shown, sent: true, signature: await execute(transport, preparedView(prepared), solver) };
}

async function lookupTableAt(transport: Transport, table: Address): Promise<Record<Address, Address[]>> {
  const view = await transport.getAccount(table);
  if (view === null) {
    throw new FlowRefused(`no lookup table ${table} on this cluster; nothing was sent`);
  }
  return { [table]: decodeLookupTable(view.data) };
}

type ReleaseCommand = Extract<CommitteeCommand, { name: "committee-release" }>;

async function splitReleaseCommand(command: ReleaseCommand, runtime: Runtime, transport: Transport, votes: readonly VoteFile[], target: Ballot, recipients: readonly SplitShare[]) {
  const client = createClient({ url: command.url, transport });
  const solver = await transactionSigner(runtime, command.keypair);
  const { ballot, committee, lines, paid, settle, tokenProgram } = await splitView(transport, target, recipients, solver);
  const [first] = votes;
  if (first !== undefined && (first.intent !== ballot.intent || first.committee !== committee.address)) {
    throw new FlowRefused(`the votes are for escrow ${first.intent} and committee ${first.committee}, not ${ballot.intent} and ${committee.address}`);
  }
  const wallets = recipients.map(({ wallet }) => wallet);
  await invitedPayee(runtime, transport, command.url, ballot.intent, wallets);
  const cast: CommitteeVote[] = votes.map((v) => ({ member: v.member, signature: Uint8Array.from(Buffer.from(v.signature, "hex")) }));
  const given = new Map([...cast.map((v): [Address, Uint8Array] => [v.member, v.signature]), ...command.cosigns.map((c): [Address, Uint8Array] => [c.wallet, Uint8Array.from(Buffer.from(c.signature, "hex"))])]);
  const signatures = wallets.flatMap((wallet) => {
    const signature = given.get(wallet);
    return signature === undefined ? [] : [{ wallet, signature }];
  });
  const plan = await client.plan.settleSplit({ ...ballotInput(target), recipients, solver, votes: cast, signatures }).catch((error: unknown) => {
    throw isSdkError(error, "cosign-rejected") ? new FlowRefused(`${error.message}; ${COSIGN_FLAG}`) : error;
  });
  if (command.confirmUrl !== undefined) {
    const keypair = isLedgerPath(command.keypair) ? undefined : await runtime.loadKeypair(command.keypair);
    await confirmOnBoth(transport, runtime.transport(command.confirmUrl), { intent: ballot.intent, attestor: committee.address, sha256: target.sha256, payees: wallets, keypair });
  }
  const tables = command.lookupTable === undefined ? undefined : await lookupTableAt(transport, command.lookupTable);
  const budgeted = await transport.budget(plan.instructions, solver.address, tables);
  const size = await transactionSize(transport, budgeted, solver.address, tables);
  const voters = quorumOf(committee, cast).map(({ member }) => member);
  const invoked = new Set<Address>([solver.address, settle.programAddress, tokenProgram]);
  const shown = {
    intent: ballot.intent,
    committee: committee.address,
    announcement: target.announcement,
    signers: voters,
    envelope: hex(ballot.message),
    paid,
    lookup_accounts: [...new Set((settle.accounts ?? []).map((a) => a.address))].filter((a) => !invoked.has(a)),
    summary: [
      ...lines,
      `Signed by: ${voters.join(", ")}, ${voters.length} of committee ${committee.address}, which needs ${committee.threshold}, and every co-author`,
      `Pays the fee: ${solver.address}`,
      ...(plan.setup.length === 0 ? [] : ["Sets up first, in its own transaction: the token accounts the release pays into"]),
    ],
  };
  if (size > PACKET_DATA_SIZE) {
    if (command.yes) {
      throw new FlowRefused(splitTooLarge(size, tables !== undefined));
    }
    return { ...shown, sent: false, next: splitTooLarge(size, tables !== undefined) };
  }
  if (plan.setup.length === 0) {
    return sentWith(transport, budgeted, solver, tables, shown, command.yes);
  }
  if (!command.yes) {
    return previewed(transport, plan.setup, solver, shown, false);
  }
  const prepared = await previewed(transport, plan.setup, solver, {}, true);
  const sent = await sentWith(transport, budgeted, solver, tables, shown, true);
  return { ...sent, setup_signature: (prepared as { signature?: string }).signature };
}

async function releaseCommand(command: ReleaseCommand, runtime: Runtime, transport: Transport): Promise<object> {
  const votes = await Promise.all(command.votes.map(async (file) => voteOf(await readFile(file, "utf8"), file)));
  const target = sameBallot(votes, command.votes);
  const recipients = votes[0]?.recipients;
  if (recipients !== undefined) {
    return splitReleaseCommand(command, runtime, transport, votes, target, recipients);
  }
  const client = createClient({ url: command.url, transport });
  const solver = await transactionSigner(runtime, command.keypair);
  const [escrow] = await findIntentPda({ owner: target.owner, nonce: target.nonce });
  const worker = await workerOf(transport, target.announcement);
  await invitedPayee(runtime, transport, command.url, escrow, [worker]);
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
  const table = command.lookupTable;
  const tables = table === undefined ? undefined : await lookupTableAt(transport, table);
  const budgeted = await transport.budget(release.instructions, solver.address, tables);
  const size = await transactionSize(transport, budgeted, solver.address, tables);
  const held = await intentAt(transport, release.intent);
  const settle = release.instructions.at(-1);
  const invoked = new Set<Address>([solver.address, ...(settle === undefined ? [] : [settle.programAddress]), ...(held === null ? [] : [(await mintOf(transport, held.inputMint)).tokenProgram])]);
  const summary = [
    `Releases: proof escrow ${release.intent} to ${worker} (token account ${release.payee}), who made the announcement ${target.announcement}, with result ${target.result}`,
    `Signed by: ${release.voters.join(", ")}, ${release.voters.length} of committee ${release.committee.address}, which needs ${release.committee.threshold}`,
    `Pays the fee: ${solver.address}`,
    ...(table === undefined ? [] : [`Looks up: accounts in the address lookup table ${table}`]),
    ...(release.setup.length === 0 ? [] : ["Sets up first, in its own transaction: the token accounts the release pays into"]),
  ];
  const shown = {
    intent: release.intent,
    committee: release.committee.address,
    announcement: target.announcement,
    signers: release.voters,
    ...(table === undefined ? {} : { lookup_table: table }),
    lookup_accounts: [...new Set((settle?.accounts ?? []).map((a) => a.address))].filter((a) => !invoked.has(a)),
    summary,
  };
  if (size > PACKET_DATA_SIZE) {
    if (command.yes) {
      throw new FlowRefused(committeeTooLarge(size, tables !== undefined));
    }
    return { ...shown, sent: false, next: committeeTooLarge(size, tables !== undefined) };
  }
  if (release.setup.length === 0) {
    return sentWith(transport, budgeted, solver, tables, shown, command.yes);
  }
  if (!command.yes) {
    return previewed(transport, release.setup, solver, shown, false);
  }
  const prepared = await previewed(transport, release.setup, solver, {}, true);
  const sent = await sentWith(transport, budgeted, solver, tables, shown, true);
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
