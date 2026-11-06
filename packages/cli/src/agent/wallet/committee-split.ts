import { createHash } from "node:crypto";
import { type Address, getBase16Decoder } from "@solana/kit";
import { formatAmount, Kind } from "@intent-engine/core";
import { buildEd25519CosignInstruction, decodeParams, findIntentPda } from "@intent-engine/core/internal";
import { isSdkError } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { checkCosigns, type CoSignature, intentAt, mintOf, PACKET_DATA_SIZE, releaseReads, splitPreview, splitQuorum } from "@intent-engine/client/internal";
import type { AgentContext } from "../actions.js";
import type { Call } from "../claims.js";
import { tool } from "../names.js";
import { AgentRefusal } from "../problems.js";
import { InvalidInput, optional, text } from "../schema.js";
import { preparedView } from "../shapes.js";
import { prepare } from "../prepare.js";
import { SIGNATURE_FORMAT, signatureBytes } from "../../delivery-shared.js";
import { TOKEN_NAMES } from "../../tokens.js";
import { PREVIEW_APPROVAL_NEXT, sent, sha256Of, walletOpeners, type WalletSigner } from "./guard.js";
import { firstOpeningFor, skippedField } from "./openings.js";
import { confirmedRelease } from "./delivery.js";
import { approvalOf, invitedPayees, RELEASE_CHANGED, settleRefused, walletAuthority } from "./attest.js";
import { boundApproval, recorded } from "../../receipt-gate.js";
import {
  checkedShares,
  committeeFees,
  coSignatures,
  fitted,
  heldWarnings,
  lookupAccountsOf,
  lookupTablesOf,
  notInSplit,
  paidOutput,
  paidShares,
  setupLine,
  shareLines,
  sizeOf,
  splitTooLarge,
} from "./split.js";

export const VOTE_CHANGED = "this vote differs from its preview: the escrow, payee, result or delivered work changed, or no approval was given; preview it again and show the user";

export const NOT_A_MEMBER = "this server's wallet is not a member of the committee this escrow names, so it has no vote";

export const SINGLE_JUDGED = `this escrow is judged by a single key, not a committee; its judge releases a split with ${tool("wallet_attest_split")}`;

export const SPLIT_VOTE_NEXT = `call again with send: true and this approval to sign the vote; every co-author signs the same envelope; pass the votes and the co-authors' signatures to ${tool("wallet_committee_release")}`;

export const COSIGN_NEEDED = `every co-author signs the envelope ${tool("wallet_committee_vote")} returns for this split; pass each signature here; a member's vote counts as its own`;

export const SIGN_FIRST =
  "this Ledger wallet is a co-author of this split: this send signs only its co-author signature over the envelope on the device, one step at a time; the device shows the envelope's digest: compare it with digest before approving; pass the signature as this wallet's in recipients, then preview again";

export const SIGNS_AT_SEND = "Signs: this wallet's co-author signature over the envelope, only when sent";

export const SETUP_FIRST = "this Ledger send creates the token accounts only, one transaction at a time; once it lands, preview again to release";

export const hex = (bytes: Uint8Array) => getBase16Decoder().decode(bytes).toLowerCase();

export type BallotArgs = { owner: Address; nonce: bigint; result: bigint; delivered_sha256: string; without_receipt?: string | undefined };

export async function memberOnly(ctx: AgentContext, intent: Address, judge: Address): Promise<void> {
  const held = await intentAt(ctx.transport, intent);
  const params = held === null ? null : decodeParams(held.kind, Uint8Array.from(held.params));
  const client = createClient({ url: ctx.url ?? "", transport: ctx.transport });
  const judging = params === null || params.kind !== Kind.AttestedResult ? null : await client.committee(params.attestor);
  if (judging !== null && !judging.members.includes(judge)) {
    throw new AgentRefusal("Unauthorized", NOT_A_MEMBER);
  }
}

export async function splitBallotOf(ctx: AgentContext, input: BallotArgs, signer: WalletSigner, recipients: readonly { wallet: Address; weight: number }[], voting: boolean) {
  const delivered = sha256Of(input.delivered_sha256, "delivered_sha256");
  const shares = await checkedShares(ctx, recipients);
  const wallets = shares.map(({ wallet }) => wallet);
  const [intent] = await findIntentPda({ owner: input.owner, nonce: input.nonce });
  if (voting) {
    await memberOnly(ctx, intent, signer.address);
  }
  const { opening, skipped } = await firstOpeningFor(ctx, signer.address, intent, delivered, signer.device !== undefined);
  if (!wallets.includes(opening.worker)) {
    throw new AgentRefusal("NotEarliestAnnouncer", notInSplit(opening.worker, delivered));
  }
  const target = { intent: { owner: input.owner, nonce: input.nonce }, announcement: opening.announcement, opening: { sha256: delivered, salt: opening.salt }, result: input.result, recipients: shares };
  const { ballot, preview, settle } = await splitPreview(releaseReads(ctx.transport), target, signer).catch(settleRefused);
  const { committee } = ballot;
  if (committee === null) {
    throw new AgentRefusal("KindMismatch", SINGLE_JUDGED);
  }
  const at = { owner: input.owner, nonce: input.nonce, intent, deliveredSha256: delivered, announcement: opening.announcement };
  const authority = voting ? await walletAuthority(ctx, at, [signer.address], input.without_receipt) : undefined;
  await invitedPayees(ctx, intent, wallets);
  await confirmedRelease(ctx, { intent, attestor: committee.address, sha256: delivered, payees: wallets, keypair: await walletOpeners(ctx) });
  const held = await intentAt(ctx.transport, intent);
  if (held === null) {
    throw new AgentRefusal("NotFound", `no intent ${intent}; it was settled, cancelled and closed, or never made`);
  }
  const mint = held.inputMint;
  const token = await mintOf(ctx.transport, mint);
  const name = TOKEN_NAMES[mint] ?? mint;
  const summary = [
    `Splits: ${formatAmount(preview.net, token.decimals)} of ${name} from escrow ${intent} among ${shares.length} co-authors, with result ${input.result}`,
    ...shareLines(preview, shares, name, token.decimals),
    `For: the work with sha256 ${delivered}, announced by ${opening.worker} in ${opening.announcement} (seq ${opening.seq}), the first that opens to it`,
    `Judged by: committee ${committee.address}, any ${committee.threshold} of its ${committee.members.length} members`,
    ...committeeFees(preview, committee.feeWallet, name, token.decimals),
    ...heldWarnings(preview),
  ];
  const shown = {
    intent,
    committee: committee.address,
    announcement: opening.announcement,
    worker: opening.worker,
    seq: opening.seq,
    digest: hex(ballot.digest),
    envelope: hex(ballot.message),
    paid: paidShares(preview, shares, token.decimals),
    ...skippedField(skipped),
    ...recorded(authority),
  };
  return { target, ballot, committee, shares, wallets, summary, shown, settle, token, preview, authority, at };
}

export const releaseApproval = (digest: Uint8Array, setup: readonly string[]) =>
  createHash("sha256").update(digest).update(JSON.stringify(setup)).digest("hex").slice(0, 16);

export const splitOutput = {
  envelope: optional(text("for a split: the one message every member who votes and every co-author signs, as hex")),
  paid: optional(paidOutput),
};

export const votesOf = (votes: readonly { member: Address; signature: string }[]) =>
  votes.map((vote, i) => {
    const signature = signatureBytes(vote.signature);
    if (signature === undefined) {
      throw new InvalidInput([{ path: `votes.${i}.signature`, message: SIGNATURE_FORMAT }]);
    }
    return { member: vote.member, signature };
  });

export async function splitVote(ctx: AgentContext, input: BallotArgs & { approval?: string | undefined; send?: boolean | undefined }, signer: WalletSigner, recipients: readonly { wallet: Address; weight: number }[]): Promise<Record<string, unknown>> {
  const { ballot, committee, summary, shown, authority } = await splitBallotOf(ctx, input, signer, recipients, true);
  if (!committee.members.includes(signer.address)) {
    throw new AgentRefusal("Unauthorized", NOT_A_MEMBER);
  }
  const approval = boundApproval(approvalOf(ballot.message), authority);
  const view = { ...shown, approval, summary };
  if (input.send !== true) {
    return { ...view, signed: false, next: SPLIT_VOTE_NEXT };
  }
  if (input.approval !== approval) {
    throw new AgentRefusal("ReleaseChanged", VOTE_CHANGED);
  }
  return { ...view, signed: true, vote: { member: signer.address, signature: hex(new Uint8Array(await signer.signBytes(ballot.message))) } };
}

export type SplitReleaseArgs = BallotArgs & {
  votes: readonly { member: Address; signature: string }[];
  recipients: readonly { wallet: Address; weight: number; signature?: string | undefined }[];
  lookup_table?: Address | undefined;
  approval?: string | undefined;
  send?: boolean | undefined;
};

export const sigRefused = (error: unknown): never => {
  if (isSdkError(error, "vote-rejected") || isSdkError(error, "cosign-rejected")) {
    throw new AgentRefusal("SigMessage", error.message);
  }
  return settleRefused(error);
};

export async function splitRelease(ctx: AgentContext, input: SplitReleaseArgs, signer: WalletSigner, call: Call): Promise<Record<string, unknown>> {
  const { target, ballot, committee, shares, summary, shown, settle, token, preview, at } = await splitBallotOf(ctx, input, signer, input.recipients, false);
  const votes = votesOf(input.votes);
  const voted = (wallet: Address) => input.votes.find(({ member }) => member === wallet)?.signature;
  const given = input.recipients.map((r) => ({ wallet: r.wallet, signature: r.signature ?? voted(r.wallet) }));
  const unsigned = (r: { wallet: Address; signature?: string | undefined }) => r.wallet === signer.address && r.signature === undefined;
  const selfSigns = given.some(unsigned);
  const authority = selfSigns && committee.members.includes(signer.address) ? await walletAuthority(ctx, at, [signer.address], input.without_receipt) : undefined;
  const others = await coSignatures(signer, given.filter((r) => !unsigned(r)), ballot.message, COSIGN_NEEDED, true);
  const { needed } = await splitQuorum(ballot, votes).catch(sigRefused);
  await checkCosigns(ballot, others).catch(sigRefused);
  const voters = needed.map(({ member }) => member);
  const tables = await lookupTablesOf(ctx, input.lookup_table);
  const device = signer.device !== undefined;
  const signFirst = device && selfSigns;
  const setupFirst = device && !selfSigns && preview.setup.length > 0;
  const setup = preview.setup.length === 0 ? [] : [`${await setupLine(ctx, preview.setup.length, token.tokenProgram, false)}, in its own transaction before the release`];
  const approval = boundApproval(releaseApproval(ballot.message, [...setup, input.lookup_table ?? ""]), authority);
  if (input.send === true && input.approval !== approval) {
    throw new AgentRefusal("ReleaseChanged", RELEASE_CHANGED);
  }
  let plan;
  if (!selfSigns || (input.send === true && !device)) {
    const own: CoSignature[] = selfSigns ? [{ wallet: signer.address, signature: new Uint8Array(await signer.signBytes(ballot.message)) }] : [];
    const client = createClient({ url: ctx.url ?? "", transport: ctx.transport });
    plan = await client.plan.settleSplit({ ...target, solver: signer, votes, signatures: [...others, ...own] }).catch(sigRefused);
  }
  const standIn = new Map([...needed.map((v): [Address, Uint8Array] => [v.member, v.signature]), ...others.map((c): [Address, Uint8Array] => [c.wallet, c.signature]), [signer.address, new Uint8Array(64)]]);
  const estimate = [buildEd25519CosignInstruction({ entries: [...standIn].map(([publicKey, signature]) => ({ publicKey, signature })), message: ballot.message }), settle];
  const size = await sizeOf(ctx, plan?.instructions ?? estimate, signer.address, tables);
  const view = {
    ...shown,
    ...recorded(authority),
    signers: voters,
    approval,
    lookup_accounts: lookupAccountsOf(settle, token.tokenProgram, signer.address),
    summary: [
      ...summary,
      `Signed by: ${voters.length} of its members, ${voters.join(", ")}, and every co-author`,
      `Pays the fee: this server's wallet ${signer.address}`,
      ...setup,
      ...(signFirst ? [SIGN_FIRST, `Signs: only the envelope on the Ledger, which shows digest ${hex(ballot.digest)}; approve on the device only if it shows the same`] : selfSigns ? [SIGNS_AT_SEND] : []),
      ...(setupFirst ? [SETUP_FIRST] : []),
      ...(size > PACKET_DATA_SIZE ? [`Too large: ${splitTooLarge(size, shares.length, tables !== undefined)}`] : []),
    ],
  };
  if (signFirst) {
    if (input.send !== true) {
      return { ...view, sent: false, next: PREVIEW_APPROVAL_NEXT };
    }
    return { ...view, sent: false, cosign: { wallet: signer.address, signature: hex(new Uint8Array(await signer.signBytes(ballot.message))) }, next: SIGN_FIRST };
  }
  if (input.send === true && !setupFirst) {
    await fitted(ctx, plan?.instructions ?? estimate, signer.address, tables, shares.length);
  }
  if (input.send === true && preview.setup.length > 0 && !device) {
    await ctx.transport.send(plan?.setup ?? preview.setup, signer);
  }
  const piece = setupFirst ? preview.setup : plan?.instructions;
  const ready = setupFirst || size <= PACKET_DATA_SIZE;
  const prepared = ready && piece !== undefined && (input.send === true || device) ? preparedView(await prepare(ctx.transport, piece, signer.address, setupFirst ? undefined : tables)) : undefined;
  return sent(ctx, signer, { ...view, prepared }, input.send, call, {
    preview: PREVIEW_APPROVAL_NEXT,
    done: setupFirst ? SETUP_FIRST : `released to co-authors; ${tool("wallet_feedback")} to rate if you own it`,
  });
}

export const SPLIT_RECIPIENTS = "for a split release: the co-authors and their weighted shares, up to 8; one must have made the announcement";
