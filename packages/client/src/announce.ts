import type { Address, Signature, TransactionSigner } from "@solana/kit";
import { IntentStatus, InvalidInput, type SealRecipient } from "@intent-engine/core";
import {
  announcementAddress,
  announcementCommitment,
  buildAnnounceDelivery,
  CLAIM_BOARD_DISCRIMINATOR,
  claimBoardAddress,
  claimListAddress,
  CLAIMS_OPEN,
  claimSlot,
  deliverySecrets,
  isLocalWorkUrl,
  isMemoUrl,
  isSha256Hex,
  maxSealedUrl,
  MEMO_URL_RULE,
  sealDeliveryV4,
} from "@intent-engine/core/internal";
import { chainTime, engineAccount } from "./accounts.js";
import { NotDeliverable, UrlTooLong } from "./announce-errors.js";
import { readBoard } from "./fair-reads.js";
import { announceProtection, type Protection } from "./protection.js";
import { recipientsFor, secretSource, type SecretInput } from "./announce-keys.js";
import { type AnnouncementView, loadAnnouncement, loadDeliveryBook } from "./announcement-reads.js";
import type { ClientContext } from "./client-types.js";
import { intentAddress, type IntentRef } from "./intent-ref.js";
import { hex, proofAt } from "./job-proofs.js";
import { MAINNET_GENESIS_HASH, PLAIN_HTTP_ON_PUBLIC, plainHttpOnPublic } from "./job-specs.js";
import { payerFor, type Plan, planOf } from "./plan.js";
import type { Transport } from "./transport.js";
import { hexBytes } from "./encoding.js";
import { specHashText } from "./spec-hash.js";

export { isSaltSigner, type SaltSigner, type SecretInput, secretInputOf, type SecretOptions } from "./announce-keys.js";

export type AnnounceInput = SecretInput & {
  payer?: TransactionSigner;
  intent: IntentRef;
  sha256: string;
  url: string;
  force?: boolean;
};

export type AnnouncementPlan = Plan & {
  intent: Address;
  attestor: Address;
  worker: Address;
  announcement: Address;
  commitment: string;
  salt: string;
  sealedTo: SealRecipient[];
  maxUrl: number;
  existing: AnnouncementView | null;
  protection: Protection;
};

export type Announced = {
  announcement: Address;
  seq: bigint;
  commitment: string;
  salt: string;
  attestor: Address;
  signature: Signature | null;
  synced: Signature | null;
};

export const ANNOUNCED_UNSEEN = "the announcement landed but the node does not show it yet";

export function sha256Bytes(sha256: string): Uint8Array {
  return hexBytes(specHashText(sha256, "sha256"));
}

async function claimAccounts(transport: Transport, intent: Address, claims: number, worker: Address) {
  if (claims !== CLAIMS_OPEN) {
    return { board: false, claimList: false, accounts: {}, stored: null };
  }
  const board = await claimBoardAddress(intent);
  const stored = readBoard(await engineAccount(transport, board, CLAIM_BOARD_DISCRIMINATOR, "claim board"));
  const slot = claimSlot(stored, await chainTime(transport));
  if (slot.state === "held" && slot.worker !== worker) {
    throw new NotDeliverable(intent, "claim-held", `is claimed by ${slot.worker} until ${slot.until}, so only that worker can announce until then; nothing was sent`);
  }
  const listed = stored.listed !== 0;
  return { board: true, claimList: listed, accounts: { claims: board, ...(listed ? { claimList: await claimListAddress(intent) } : {}) }, stored };
}

export async function announcementPlan(context: ClientContext, input: AnnounceInput): Promise<AnnouncementPlan> {
  const { transport } = context;
  const { worker } = input;
  const intent = await intentAddress(input.intent);
  const payer = input.payer ?? worker;
  const delivered = sha256Bytes(input.sha256);
  const sha256 = hex(delivered);
  if (!isMemoUrl(input.url)) {
    throw new InvalidInput("url", "format", `a delivery url must be ${MEMO_URL_RULE}`);
  }
  const localWork = isLocalWorkUrl(input.url) && (await transport.genesisHash()) !== MAINNET_GENESIS_HASH;
  if (!localWork && (await plainHttpOnPublic(transport, input.url))) {
    throw new InvalidInput("url", "format", `the work url ${input.url} ${PLAIN_HTTP_ON_PUBLIC}`);
  }
  const [proof, now, config] = await Promise.all([proofAt(transport, intent), chainTime(transport), context.config()]);
  if (proof === null) {
    throw new NotDeliverable(intent, "not-a-proof-escrow", "is not a proof escrow: an AttestedResult intent that commits a spec hash");
  }
  if (proof.intent.status !== IntentStatus.Open || proof.intent.expiresAt <= now) {
    throw new NotDeliverable(intent, "not-open", "is no longer open");
  }
  const attestor = proof.params.attestor;
  const { committee, recipients, sync } = await recipientsFor(transport, attestor, intent);
  const claims = await claimAccounts(transport, intent, proof.intent.claims, worker.address);
  const book = await loadDeliveryBook(transport, intent);
  const cancelAt = book === null || book.cancelAt === 0n ? null : book.cancelAt;
  const protection = announceProtection(claims.stored, worker.address, proof.intent.expiresAt, now, cancelAt);
  if (cancelAt !== null && now >= cancelAt && !protection.arms && input.force !== true) {
    throw new NotDeliverable(intent, "cancel-due", `has a cancel request whose notice ended at ${cancelAt}, so its owner can cancel it at once and this announcement arms no review; nothing was sent; the SDK option force, or force on solive_wallet_deliver, announces anyway`);
  }
  const fee = config.announceFee > 0;
  const maxUrl = maxSealedUrl({
    recipients: recipients.length,
    committee: committee !== null,
    relayer: payer.address !== worker.address,
    board: claims.board,
    claimList: claims.claimList,
    feeTo: fee,
    priorityFee: true,
    version: 0,
  });
  const bytes = new TextEncoder().encode(input.url).length;
  if (bytes > maxUrl) {
    throw new UrlTooLong(bytes, maxUrl, recipients.length);
  }
  const source = await secretSource(input, intent, sha256);
  const { salt } = await deliverySecrets(input.url, recipients, { intent, worker: worker.address }, source);
  const blob = await sealDeliveryV4({ source, url: input.url, recipients }, intent, worker.address);
  const commitment = await announcementCommitment(intent, worker.address, { delivered, salt });
  const existing = await loadAnnouncement(transport, await announcementAddress(intent, worker.address, blob));
  const { announcement, instruction } = await buildAnnounceDelivery({
    worker,
    payer,
    intent,
    attestor,
    committee: committee !== null,
    ...claims.accounts,
    ...(fee ? { feeRecipient: config.feeRecipient } : {}),
    commitment,
    blob,
  });
  const fresh = existing === null;
  return {
    ...planOf({ payer: payer.address, setup: fresh && sync !== null ? [sync] : [], instructions: fresh ? [instruction] : [] }),
    intent,
    attestor,
    worker: worker.address,
    announcement,
    commitment: hex(commitment),
    salt: hex(salt),
    sealedTo: recipients,
    maxUrl,
    existing,
    protection,
  };
}

function announcedFrom(plan: AnnouncementPlan, found: AnnouncementView, signature: Signature | null, synced: Signature | null): Announced {
  return { announcement: plan.announcement, seq: found.seq, commitment: plan.commitment, salt: plan.salt, attestor: plan.attestor, signature, synced };
}

export type AnnounceSend = (input: AnnounceInput) => Promise<Announced>;

export function announcing(context: ClientContext): AnnounceSend {
  return async (input: AnnounceInput): Promise<Announced> => {
    const plan = await announcementPlan(context, input);
    if (plan.existing !== null) {
      return announcedFrom(plan, plan.existing, null, null);
    }
    const payer = payerFor(plan, input.payer ?? input.worker);
    const synced = plan.setup.length === 0 ? null : await context.send(plan.setup, payer);
    let signature: Signature;
    try {
      signature = await context.send(plan.instructions, payer);
    } catch (error) {
      const raced = await loadAnnouncement(context.transport, plan.announcement);
      if (raced === null) {
        throw error;
      }
      return announcedFrom(plan, raced, null, synced);
    }
    const found = await loadAnnouncement(context.transport, plan.announcement);
    if (found === null) {
      throw new NotDeliverable(plan.intent, "announced-unseen", `${ANNOUNCED_UNSEEN}: ${plan.announcement} in ${signature}`);
    }
    return announcedFrom(plan, found, signature, synced);
  };
}
