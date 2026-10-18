import { readFile, writeFile } from "node:fs/promises";
import type { Address, KeyPairSigner } from "@solana/kit";
import { buildCreateCommittee, type CommitteeVote, signCommitteeVote } from "@intent-engine/core";
import { type CommitteeBallot, confirmOnBoth, createClient, type Transport } from "@intent-engine/client";
import { previewed } from "./admin-commands.js";
import { parseAddress, parseU64 } from "./arg-values.js";
import type { Command } from "./command-types.js";
import { FlowRefused } from "./flows.js";
import type { Runtime } from "./runtime.js";

export const VOTE_KIND = "committee-vote";

export const VOTE_NOT_SIGNED = "nothing was signed; rerun with --yes to sign this vote, then pass the file to committee release";

export type VoteFile = {
  kind: typeof VOTE_KIND;
  intent: Address;
  committee: Address;
  owner: Address;
  nonce: string;
  pay_to: Address;
  result: string;
  member: Address;
  signature: string;
};

export type Ballot = { owner: Address; nonce: bigint; payTo: Address; result: bigint };

type CommitteeCommand = Extract<
  Command,
  { name: "committee-create" | "committee-show" | "committee-vote" | "committee-release" }
>;

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

function ballotLines(ballot: CommitteeBallot, target: Ballot): string[] {
  return [
    `Releases: proof escrow ${ballot.intent} to ${target.payTo} (token account ${ballot.payee}) with result ${target.result}`,
    `Judged by: committee ${ballot.committee.address}, ${ballot.committee.threshold} of ${ballot.committee.members.length} members must sign`,
  ];
}

export async function memberVote(member: KeyPairSigner, ballot: CommitteeBallot, target: Ballot): Promise<VoteFile> {
  if (!ballot.committee.members.includes(member.address)) {
    throw new FlowRefused(`${member.address} is not a member of committee ${ballot.committee.address}; nothing was signed`);
  }
  const { signature } = await signCommitteeVote(member, ballot.digest);
  return {
    kind: VOTE_KIND,
    intent: ballot.intent,
    committee: ballot.committee.address,
    owner: target.owner,
    nonce: target.nonce.toString(),
    pay_to: target.payTo,
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
  return {
    kind: VOTE_KIND,
    intent: parseAddress(field("intent"), "intent"),
    committee: parseAddress(field("committee"), "committee"),
    owner: parseAddress(field("owner"), "owner"),
    nonce: parseU64(field("nonce"), "nonce").toString(),
    pay_to: parseAddress(field("pay_to"), "pay_to"),
    result: parseU64(field("result"), "result").toString(),
    member: parseAddress(field("member"), "member"),
    signature: vote.signature,
  };
}

export function sameBallot(votes: readonly VoteFile[], files: readonly string[]): Ballot {
  const [first] = votes;
  if (first === undefined) {
    throw new FlowRefused("committee release needs at least one --vote");
  }
  votes.forEach((vote, i) => {
    for (const name of ["intent", "committee", "owner", "nonce", "pay_to", "result"] as const) {
      if (vote[name] !== first[name]) {
        throw new FlowRefused(`${files[i]} votes on ${name} ${vote[name]}, but ${files[0]} votes on ${first[name]}`);
      }
    }
  });
  return { owner: first.owner, nonce: BigInt(first.nonce), payTo: first.pay_to, result: BigInt(first.result) };
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
    case "committee-vote": {
      const member = await runtime.loadSigner(command.keypair);
      const target = { owner: command.owner, nonce: command.nonce, payTo: command.payTo, result: command.result };
      const ballot = await client.committeeBallot(target);
      if (!ballot.committee.members.includes(member.address)) {
        throw new FlowRefused(`${member.address} is not a member of committee ${ballot.committee.address}; nothing was signed`);
      }
      const summary = ballotLines(ballot, target);
      if (!command.yes) {
        return { intent: ballot.intent, digest: hex(ballot.digest), summary, signed: false, next: VOTE_NOT_SIGNED };
      }
      const vote = await memberVote(member, ballot, target);
      if (command.out !== undefined) {
        await writeFile(command.out, `${JSON.stringify(vote, null, 2)}\n`);
      }
      return { summary, signed: true, vote, ...(command.out === undefined ? {} : { written: command.out }) };
    }
    case "committee-release": {
      const solver = await runtime.loadSigner(command.keypair);
      const votes = await Promise.all(command.votes.map(async (file) => voteOf(await readFile(file, "utf8"), file)));
      const target = sameBallot(votes, command.votes);
      const cast: CommitteeVote[] = votes.map((v) => ({ member: v.member, signature: Uint8Array.from(Buffer.from(v.signature, "hex")) }));
      const release = await client.prepareCommitteeRelease({
        ...target,
        solver,
        votes: cast,
        ...(command.sha256 === undefined ? {} : { deliveredSha256: command.sha256 }),
      });
      const [first] = votes;
      if (first !== undefined && (first.intent !== release.intent || first.committee !== release.committee.address)) {
        throw new FlowRefused(`the votes are for escrow ${first.intent} and committee ${first.committee}, not ${release.intent} and ${release.committee.address}`);
      }
      if (command.confirmUrl !== undefined) {
        await confirmOnBoth(transport, runtime.transport(command.confirmUrl), { intent: release.intent, attestor: release.committee.address, sha256: command.sha256, payees: [target.payTo] });
      }
      const summary = [
        `Releases: proof escrow ${release.intent} to ${target.payTo} (token account ${release.payee}) with result ${target.result}`,
        `Signed by: ${release.signers.join(", ")}, ${release.signers.length} of committee ${release.committee.address}, which needs ${release.committee.threshold}`,
        `Pays the fee: ${solver.address}`,
      ];
      const shown = { intent: release.intent, committee: release.committee.address, signers: release.signers };
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
  }
}
