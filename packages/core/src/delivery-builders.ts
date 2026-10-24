import {
  type AccountMeta,
  AccountRole,
  type Address,
  type Instruction,
  type InstructionWithAccounts,
  type InstructionWithData,
  type ReadonlyUint8Array,
  type TransactionSigner,
} from "@solana/kit";
import {
  getAnnounceDeliveryInstructionAsync,
  getCloseAnnouncementInstructionAsync,
  getCloseDeliveryBookInstructionAsync,
  getRefuteReleaseInstructionAsync,
  getSetAnnounceFeeInstruction,
  getSyncCommitteeKeysInstruction,
} from "../generated/client/index.js";
import { events } from "./builder-accounts.js";
import { sized } from "./bytes.js";
import { MAX_COMMITTEE_MEMBERS, sortMembers } from "./committee.js";
import { blobHead, commitmentPreimage, SALT_LEN, splitHashPreimage } from "./delivery.js";
import type { DeliveryOpening } from "./fill-builders.js";
import { findAnnouncementPda, findDeliveryBookPda, findRefutationPda } from "./pdas.js";
import { profileAddress } from "./profile.js";
import { MAX_CREATE_FEE } from "./state.js";

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice()));
}

export async function announcementCommitment(intent: Address, worker: Address, opening: DeliveryOpening): Promise<Uint8Array> {
  return sha256(commitmentPreimage(intent, worker, opening.salt, opening.delivered));
}

export async function announcementAddress(intent: Address, worker: Address, blob: Uint8Array): Promise<Address> {
  return (await findAnnouncementPda({ intent, worker, blobHash: await sha256(blob) }))[0];
}

export async function deliveryBookAddress(intent: Address): Promise<Address> {
  return (await findDeliveryBookPda({ intent }))[0];
}

export async function refutationAddress(earlier: Address): Promise<Address> {
  return (await findRefutationPda({ earlier }))[0];
}

export type AnnounceDeliverySpec = {
  worker: TransactionSigner;
  payer?: TransactionSigner;
  intent: Address;
  attestor: Address;
  committee?: boolean;
  claims?: Address;
  claimList?: Address;
  feeRecipient?: Address;
  commitment: Uint8Array;
  blob: Uint8Array;
};

export async function buildAnnounceDelivery(input: AnnounceDeliverySpec) {
  blobHead(input.blob);
  if (sized("commitment", input.commitment, 32).every((b) => b === 0)) {
    throw new RangeError("an announcement needs a non-zero commitment");
  }
  const announcement = await announcementAddress(input.intent, input.worker.address, input.blob);
  const judge = input.committee === true ? { committee: input.attestor } : { judgeProfile: await profileAddress(input.attestor) };
  const instruction = await getAnnounceDeliveryInstructionAsync({
    worker: input.worker,
    payer: input.payer ?? input.worker,
    intent: input.intent,
    attestor: input.attestor,
    ...judge,
    ...(input.claims === undefined ? {} : { board: input.claims }),
    ...(input.claimList === undefined ? {} : { claimList: input.claimList }),
    book: await deliveryBookAddress(input.intent),
    announcement,
    ...(input.feeRecipient === undefined ? {} : { feeTo: input.feeRecipient }),
    commitment: input.commitment,
    blob: input.blob,
    ...(await events()),
  });
  return { announcement, instruction };
}

export async function buildSetAnnounceFee(input: { admin: TransactionSigner; fee: number }) {
  if (!Number.isInteger(input.fee) || input.fee < 0 || input.fee > MAX_CREATE_FEE) {
    throw new RangeError(`an announce fee is 0 to ${MAX_CREATE_FEE} lamports, got ${input.fee}`);
  }
  return getSetAnnounceFeeInstruction({ admin: input.admin, fee: input.fee, ...(await events()) });
}

type KeySyncInstruction = Instruction & InstructionWithAccounts<readonly AccountMeta[]> & InstructionWithData<ReadonlyUint8Array>;

export async function buildSyncCommitteeKeys(input: { committee: Address; members: readonly Address[] }): Promise<KeySyncInstruction> {
  const members = sortMembers(input.members);
  if (members.length < 1 || members.length > MAX_COMMITTEE_MEMBERS || new Set(members).size !== members.length) {
    throw new RangeError(`a committee syncs 1 to ${MAX_COMMITTEE_MEMBERS} distinct member profiles, got ${members.length}`);
  }
  const profiles = await Promise.all(members.map(profileAddress));
  const instruction = getSyncCommitteeKeysInstruction({ committee: input.committee, ...(await events()) });
  return { ...instruction, accounts: [...instruction.accounts, ...profiles.map((address) => ({ address, role: AccountRole.READONLY }))] };
}

export async function buildCloseAnnouncement(input: { by: TransactionSigner; announcement: Address; intent: Address; rentTo: Address }) {
  return getCloseAnnouncementInstructionAsync({
    by: input.by,
    announcement: input.announcement,
    intent: input.intent,
    book: await deliveryBookAddress(input.intent),
    rentTo: input.rentTo,
    ...(await events()),
  });
}

export async function buildCloseDeliveryBook(input: { by: TransactionSigner; intent: Address; rentTo: Address }) {
  return getCloseDeliveryBookInstructionAsync({
    by: input.by,
    intent: input.intent,
    book: await deliveryBookAddress(input.intent),
    rentTo: input.rentTo,
    ...(await events()),
  });
}

export type RefuteReleaseSpec = {
  earlierWorker: TransactionSigner;
  payer?: TransactionSigner;
  paid: Address;
  earlier: Address;
  salt: Uint8Array;
  esk: Uint8Array;
  claim?: { recipients: Address[]; weights: number[] };
};

export async function buildRefuteRelease(input: RefuteReleaseSpec) {
  if (input.claim !== undefined) {
    splitHashPreimage(input.claim.recipients, input.claim.weights);
  }
  return getRefuteReleaseInstructionAsync({
    earlierWorker: input.earlierWorker,
    payer: input.payer ?? input.earlierWorker,
    paid: input.paid,
    earlier: input.earlier,
    refutation: await refutationAddress(input.earlier),
    salt: sized("salt", input.salt, SALT_LEN),
    esk: sized("esk", input.esk, 32),
    claim: input.claim ?? null,
    ...(await events()),
  });
}
