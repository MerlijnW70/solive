import type { Address, Instruction, Signature, TransactionSigner } from "@solana/kit";
import {
  announcementAddress,
  announcementCommitment,
  buildAnnounceDelivery,
  CLAIMS_OPEN,
  claimBoardAddress,
  CLAIM_BOARD_DISCRIMINATOR,
  claimListAddress,
  claimSlot,
  deliverySecrets,
  getClaimBoardDecoder,
  IntentStatus,
  isMemoUrl,
  isSha256Hex,
  maxSealedUrl,
  MEMO_URL_RULE,
  type SealRecipient,
  sealDeliveryV4,
} from "@intent-engine/core";
import { chainTime, engineAccount } from "./accounts.js";
import { NotDeliverable, UrlTooLong } from "./announce-errors.js";
import { recipientsFor, secretSource, type SecretInput } from "./announce-keys.js";
import { type AnnouncementView, loadAnnouncement } from "./announcement-reads.js";
import type { ClientContext } from "./client-types.js";
import { hex, proofAt } from "./job-proofs.js";
import { PLAIN_HTTP_ON_PUBLIC, plainHttpOnPublic } from "./job-specs.js";
import type { Transport } from "./transport.js";

export type AnnounceInput = SecretInput & {
  worker: TransactionSigner;
  payer?: TransactionSigner;
  intent: Address;
  sha256: string;
  url: string;
};

export type AnnouncementPlan = {
  intent: Address;
  attestor: Address;
  worker: Address;
  payer: TransactionSigner;
  announcement: Address;
  commitment: string;
  salt: string;
  sealedTo: SealRecipient[];
  maxUrl: number;
  setup: Instruction[];
  instructions: Instruction[];
  existing: AnnouncementView | null;
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
  const lowered = sha256.trim().toLowerCase();
  if (!isSha256Hex(lowered)) {
    throw new RangeError("sha256 must be 64 hex digits");
  }
  return Uint8Array.from(Buffer.from(lowered, "hex"));
}

async function claimAccounts(transport: Transport, intent: Address, claims: number, worker: Address) {
  if (claims !== CLAIMS_OPEN) {
    return { board: false, claimList: false, accounts: {} };
  }
  const board = await claimBoardAddress(intent);
  const stored = getClaimBoardDecoder().decode(await engineAccount(transport, board, CLAIM_BOARD_DISCRIMINATOR, "claim board"));
  const slot = claimSlot(stored, await chainTime(transport));
  if (slot.state === "held" && slot.worker !== worker) {
    throw new NotDeliverable(intent, `is claimed by ${slot.worker} until ${slot.until}, so only that worker can announce until then; nothing was sent`);
  }
  const listed = stored.listed !== 0;
  return { board: true, claimList: listed, accounts: { claims: board, ...(listed ? { claimList: await claimListAddress(intent) } : {}) } };
}

export async function announcementPlan(context: ClientContext, input: AnnounceInput): Promise<AnnouncementPlan> {
  const { transport } = context;
  const { worker, intent } = input;
  const payer = input.payer ?? worker;
  const delivered = sha256Bytes(input.sha256);
  const sha256 = hex(delivered);
  if (!isMemoUrl(input.url)) {
    throw new RangeError(`a delivery url must be ${MEMO_URL_RULE}`);
  }
  if (await plainHttpOnPublic(transport, input.url)) {
    throw new RangeError(`the work url ${input.url} ${PLAIN_HTTP_ON_PUBLIC}`);
  }
  const [proof, now, config] = await Promise.all([proofAt(transport, intent), chainTime(transport), context.config()]);
  if (proof === null) {
    throw new NotDeliverable(intent, "is not a proof escrow: an AttestedResult intent that commits a spec hash");
  }
  if (proof.intent.status !== IntentStatus.Open || proof.intent.expiresAt <= now) {
    throw new NotDeliverable(intent, "is no longer open");
  }
  const attestor = proof.params.attestor;
  const { committee, recipients, sync } = await recipientsFor(transport, attestor, intent);
  const claims = await claimAccounts(transport, intent, proof.intent.claims, worker.address);
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
  const source = await secretSource(worker, intent, sha256, input);
  const { salt } = await deliverySecrets(input.url, recipients, source);
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
  return {
    intent,
    attestor,
    worker: worker.address,
    payer,
    announcement,
    commitment: hex(commitment),
    salt: hex(salt),
    sealedTo: recipients,
    maxUrl,
    setup: existing === null && sync !== null ? [sync] : [],
    instructions: [instruction],
    existing,
  };
}

function announcedFrom(plan: AnnouncementPlan, found: AnnouncementView, signature: Signature | null, synced: Signature | null): Announced {
  return { announcement: plan.announcement, seq: found.seq, commitment: plan.commitment, salt: plan.salt, attestor: plan.attestor, signature, synced };
}

export function announcing(context: ClientContext) {
  return async (input: AnnounceInput): Promise<Announced> => {
    const plan = await announcementPlan(context, input);
    if (plan.existing !== null) {
      return announcedFrom(plan, plan.existing, null, null);
    }
    const synced = plan.setup.length === 0 ? null : await context.send(plan.setup, plan.payer);
    let signature: Signature;
    try {
      signature = await context.send(plan.instructions, plan.payer);
    } catch (error) {
      const raced = await loadAnnouncement(context.transport, plan.announcement);
      if (raced === null) {
        throw error;
      }
      return announcedFrom(plan, raced, null, synced);
    }
    const found = await loadAnnouncement(context.transport, plan.announcement);
    if (found === null) {
      throw new NotDeliverable(plan.intent, `${ANNOUNCED_UNSEEN}: ${plan.announcement} in ${signature}`);
    }
    return announcedFrom(plan, found, signature, synced);
  };
}
