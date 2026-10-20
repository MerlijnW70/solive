import { type Address, getAddressDecoder, type Instruction, type TransactionSigner } from "@solana/kit";
import { decodeParams, findAssociatedTokenAddress, findIntentPda, type Intent, Kind } from "@intent-engine/core";
import {
  creationProof,
  type DeliveryOpeners,
  type DeliveryRecord,
  type EngineTransaction,
  type EscrowProof,
  firstDelivery,
  followUpInstructions,
  followUpMemo,
  intentAt,
  lifecycleDeliveries,
  mintOf,
  openersOf,
  recordedDelivery,
  type Transport,
} from "@intent-engine/client";
import { type AgentContext, define } from "../actions.js";
import type { Call } from "../claims.js";
import { tool } from "../names.js";
import { AgentRefusal } from "../problems.js";
import { InvalidInput, account, amount, flag, list, object, optional, text } from "../schema.js";
import { preparedView } from "../shapes.js";
import { prepare } from "../prepare.js";
import { deviceOutput, PREVIEW_FIRST, signerOf, sent, sha256Of, walletOpeners } from "./guard.js";
import { HISTORY_TOO_LONG } from "./delivery.js";
import { RELEASE_UNKNOWN, outlives, releaseLookup, aroundRelease, namedRelease, releasedMint, heldMint, splitRecipients } from "./releases.js";

export const RELEASE_INPUT = "the release's transaction signature, as the attestor's release returned it; with it the release is read from that one transaction, with no search of the escrow's history";

const BASE58_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/;

export const RELEASE_SIGNATURE = "must be a base58 transaction signature";

export function releaseOf(signature: string | undefined): string | undefined {
  if (signature !== undefined && !BASE58_SIGNATURE.test(signature)) {
    throw new InvalidInput([{ path: "release", message: RELEASE_SIGNATURE }]);
  }
  return signature;
}

export const notReleasedYet = (intent: string) =>
  `no release of the escrow ${intent} is in its history, so no delivery can be recorded for it`;

export const alreadyRecorded = (sha256: string) =>
  `this release already records the delivered work's sha256 ${sha256}, which a receipt reads; nothing more is recorded`;

export const releasedBy = (attestor: string, signer: string) =>
  `this escrow was released by its attestor ${attestor}, not by ${signer}; only the attestor that released it records what it paid for`;

export const escrowGone = (intent: string) =>
  `the escrow ${intent} is closed and the transaction that made it is not in the history this RPC node returned, so when work could first be announced for it is unknown and no sha256 can be checked against it; nothing is recorded; use an RPC node that keeps the full ledger`;

export const creationUnread = (intent: string, creation: string) =>
  `the escrow ${intent} is closed and its creation ${creation} holds no create instruction this client can read, so its attestor and spec hash are unknown and no sha256 can be checked against it; nothing is recorded`;

export const notAProofEscrow = (intent: string) =>
  `the escrow ${intent} commits no spec hash, so no work is announced for it and no delivery can be recorded for its release`;

export const neverAnnounced = (sha256: string, intent: string) =>
  `no work with sha256 ${sha256} was announced for the escrow ${intent}, so it is not what the release paid for; record the sha256 the payee announced`;

export const paidOther = (worker: string, sha256: string, payee: string) =>
  `${worker} announced the work with sha256 ${sha256} first, but the release paid the token account ${payee}, which is not ${worker}'s; a release records only work its payee announced first`;

export const splitPaidOthers = (worker: string, sha256: string) =>
  `${worker} announced the work with sha256 ${sha256} first, but is not among the recipients the split paid; a split records only work one of its recipients announced first`;

export const recipientsUnread = (release: string) =>
  `the recipients of the split ${release} cannot be read from its transaction: it holds no split instruction for this escrow, neither at the top level nor inside another program's call, so whether it paid the earliest announcer is unknown and nothing is recorded; ask its attestor which wallets the split paid`;

export const followUpsUnknown = (release: string) =>
  `the history after the release ${release} could not be read in full: it is longer than the pages read, the RPC node could not return some of its transactions yet, or it is too long to show that the escrow address was not made again since, so whether a follow-up already records a delivered sha256 for it is unknown and nothing more is recorded; when the node lagged, call again in a few seconds`;

export const historyLagging = (release: string, intent: string) =>
  `the node has not returned every transaction yet; call again in a few seconds: the history of the escrow ${intent} before the release ${release} holds a transaction the RPC node could not return, so where the escrow was made is not known yet and nothing is recorded`;

export const otherLifecycle = (release: string, intent: string) =>
  `the release ${release} belongs to an earlier lifecycle of the escrow address ${intent}, which was closed and made again at the same nonce since, so it is not a release of the escrow there now; leave release out to read the current one`;

export const SALTS_SEALED =
  "the announcements for this escrow seal their salts to the attestor's key, and this wallet's key file cannot be read to open them, so the earliest announcer of the work cannot be known and nothing is recorded; start the server with mcp --encryption-keypair naming the encryption key file whose public key the attestor's profile publishes, or sign with the attestor's key file";

export const COVERAGE_UNPROVABLE =
  "this transport cannot report the first slot its RPC node keeps, so it cannot prove that the history read reaches back to the escrow's creation and an escrow without a release found reads as unknown rather than not released";

export type Recording = { intent: Address; release: string; attestor: Address; sha256: string; memo: string; instructions: Instruction[]; summary: string[] };

const ZERO_HASH = /^0+$/;

function heldProof(held: Intent): EscrowProof | null {
  const params = decodeParams(held.kind, Uint8Array.from(held.params));
  return params.kind === Kind.AttestedResult ? { attestor: params.attestor, specHash: Buffer.from(params.specHash).toString("hex") } : null;
}

async function announcedFor(
  transport: Transport,
  judge: Address,
  intent: Address,
  held: Intent | null,
  creation: EngineTransaction | null,
  release: EngineTransaction,
  keypair: DeliveryOpeners | undefined,
): Promise<DeliveryRecord> {
  const proof = (creation === null ? null : creationProof(creation, intent)) ?? (held === null ? null : heldProof(held));
  if (proof === null) {
    if (held !== null) {
      throw new AgentRefusal("NotDeliverable", notAProofEscrow(intent));
    }
    throw new AgentRefusal("HistoryTooLong", creation === null ? escrowGone(intent) : creationUnread(intent, creation.signature));
  }
  if (ZERO_HASH.test(proof.specHash)) {
    throw new AgentRefusal("NotDeliverable", notAProofEscrow(intent));
  }
  if (proof.attestor !== judge) {
    throw new AgentRefusal("Unauthorized", releasedBy(proof.attestor, judge));
  }
  const lifecycle = { intent, createdAt: creation?.blockTime ?? held?.createdAt ?? null, from: creation?.slot ?? null, to: release.slot };
  return lifecycleDeliveries(transport, judge, lifecycle, undefined, keypair);
}

export const coverageOf = (transport: Transport, text: string): string => (transport.firstAvailableSlot === undefined ? `${text}; ${COVERAGE_UNPROVABLE}` : text);

export async function recordingOf(
  transport: Transport,
  judge: TransactionSigner,
  owner: Address,
  nonce: bigint,
  sha256: string,
  releaseSignature?: string,
  keypair?: DeliveryOpeners,
): Promise<Recording> {
  const [intent] = await findIntentPda({ owner, nonce });
  const lookup = releaseSignature === undefined ? await releaseLookup(transport, intent) : await namedRelease(transport, intent, releaseSignature);
  const { release, transactions, complete } = lookup;
  if (release === null) {
    throw complete ? new AgentRefusal("NotReleased", notReleasedYet(intent)) : new AgentRefusal("HistoryTooLong", coverageOf(transport, RELEASE_UNKNOWN));
  }
  const { tx, event } = release;
  const fields = event.fields as Record<string, unknown>;
  const attestor = fields["attestor"] as Address;
  if (attestor !== judge.address) {
    throw new AgentRefusal("Unauthorized", releasedBy(attestor, judge.address));
  }
  const recorded = recordedDelivery(transactions, tx, attestor);
  if (recorded !== null) {
    throw new AgentRefusal("AlreadyRecorded", alreadyRecorded(recorded));
  }
  if (lookup.lagged === true) {
    throw new AgentRefusal("HistoryLagging", historyLagging(tx.signature, intent));
  }
  if (!complete || !lookup.bound) {
    throw new AgentRefusal("HistoryTooLong", coverageOf(transport, followUpsUnknown(tx.signature)));
  }
  const around = lookup.creation !== undefined ? null : await aroundRelease(transport, intent, tx);
  if (around?.lagged === true) {
    throw new AgentRefusal("HistoryLagging", historyLagging(tx.signature, intent));
  }
  const creation = around === null ? (lookup.creation ?? null) : around.creation;
  const held = await intentAt(transport, intent);
  const record = await announcedFor(transport, judge.address, intent, held !== null && !outlives(held, tx, creation) ? held : null, creation, tx, keypair);
  if (!record.complete) {
    throw new AgentRefusal("HistoryTooLong", HISTORY_TOO_LONG);
  }
  if (openersOf(keypair).length === 0 && record.deliveries.length > 0) {
    throw new AgentRefusal("SealedSalts", SALTS_SEALED);
  }
  const first = firstDelivery(record.deliveries, sha256);
  if (first === null) {
    throw new AgentRefusal("NotAnnounced", neverAnnounced(sha256, intent));
  }
  if (event.name === "IntentSplit") {
    const recipients = splitRecipients(tx, intent);
    if (recipients === null) {
      throw new AgentRefusal("HistoryTooLong", recipientsUnread(tx.signature));
    }
    if (!recipients.includes(first.worker)) {
      throw new AgentRefusal("NotEarliestAnnouncer", splitPaidOthers(first.worker, sha256));
    }
  } else if (!(await paidWallet(transport, tx, fields["payee"] as Address, first.worker, intent))) {
    throw new AgentRefusal("NotEarliestAnnouncer", paidOther(first.worker, sha256, fields["payee"] as Address));
  }
  return {
    intent,
    release: tx.signature,
    attestor,
    sha256,
    memo: followUpMemo(sha256, tx.signature, first.salt),
    instructions: followUpInstructions(judge, intent, sha256, tx.signature, first.salt),
    summary: [
      `Records: the delivered work's sha256 ${sha256} and its announcer's salt for the release ${tx.signature} of the escrow ${intent}, in a memo ${attestor} signs`,
      `Notifies: the escrow ${intent}, with a transfer of 0 lamports, so the memo shows in its history`,
      "Costs: the transaction fee; no tokens move",
    ],
  };
}

async function paidWallet(transport: Transport, release: EngineTransaction, payee: Address, wallet: Address, intent: Address): Promise<boolean> {
  const recorded = release.tokens?.find(({ account }) => account === payee)?.owner;
  if (recorded !== undefined) {
    return recorded === wallet;
  }
  const released = releasedMint(release, intent, payee);
  const held = await transport.getAccount(payee);
  if (held !== null && held.data.length >= 64) {
    return getAddressDecoder().decode(held.data.subarray(32, 64)) === wallet;
  }
  const mint = released ?? (await heldMint(transport, intent));
  if (mint === undefined) {
    return false;
  }
  const { tokenProgram } = await mintOf(transport, mint);
  return (await findAssociatedTokenAddress({ owner: wallet, mint, tokenProgram })) === payee;
}

export const walletRecordDelivery = define({
  name: tool("wallet_record_delivery"),
  title: "Record which work a release paid for",
  description: `Adds the paid work's sha256 to a release that recorded none, such as when ${tool("wallet_attest_split")} returned recorded: false, so ${tool("wallet_receipt")} shows it. Only the releasing attestor can, for a work hash whose earliest announcer the release paid. It moves no tokens; it costs only the transaction fee. ${PREVIEW_FIRST}`,
  effect: "submit",
  destructive: false,
  input: object({
    owner: account("the wallet that made the escrow"),
    nonce: amount("the escrow intent's nonce"),
    sha256: text("the sha256, as 64 hex digits, of the work the release paid for: the delivered_sha256 it was sent with"),
    release: optional(text(RELEASE_INPUT)),
    send: optional(flag("true signs and sends; leave out to preview")),
  }),
  output: object({
    intent: account(),
    release: text("the release's transaction"),
    sha256: text(),
    memo: text("the memo the transaction records"),
    summary: list(text(), 8),
    warnings: list(text(), 8),
    ...deviceOutput,
    sent: flag(),
    signature: optional(text()),
    next: optional(text()),
  }),
  run: async (ctx: AgentContext, input, call: Call) => {
    const signer = await signerOf(ctx);
    const sha256 = sha256Of(input.sha256, "sha256");
    const recording = await recordingOf(ctx.transport, signer, input.owner, input.nonce, sha256, releaseOf(input.release), await walletOpeners(ctx));
    const view = {
      intent: recording.intent,
      release: recording.release,
      sha256,
      memo: recording.memo,
      summary: recording.summary,
      warnings: [],
      prepared: preparedView(await prepare(ctx.transport, recording.instructions, signer.address)),
    };
    return sent(ctx, signer, view, input.send, call);
  },
});
