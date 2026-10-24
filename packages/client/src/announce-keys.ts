import { type Address, createSignableMessage, getPublicKeyFromAddress, type Instruction, isMessagePartialSigner, type SignatureBytes, type TransactionSigner, verifySignature } from "@solana/kit";
import {
  buildSyncCommitteeKeys,
  checkAccountVersion,
  COMMITTEE_DISCRIMINATOR,
  getCommitteeDecoder,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  keyFingerprintV4,
  parseEncryptionKey,
  saltMessage,
  type SealRecipient,
} from "@intent-engine/core";
import { createdAccount } from "./accounts.js";
import { BadSaltSignature, NoMessageSigner, NotDeliverable, SECRET_BYTES, SECRET_RULE } from "./announce-errors.js";
import { loadProfile } from "./client-claims.js";
import { isDevice } from "./ledger.js";
import type { Transport } from "./transport.js";

export type CommitteeKeys = { address: Address; members: Address[]; synced: boolean; mask: number; fingerprints: Uint8Array[] };

export type Recipients = { committee: CommitteeKeys | null; recipients: SealRecipient[]; sync: Instruction | null };

export type SecretInput = { secret?: Uint8Array | undefined; saltSignature?: Uint8Array | undefined };

const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, i) => byte === b[i]);

export async function committeeKeys(transport: Transport, address: Address): Promise<CommitteeKeys | null> {
  const view = await createdAccount(transport, address);
  if (view === null || view.owner !== INTENT_ENGINE_PROGRAM_ADDRESS || !COMMITTEE_DISCRIMINATOR.every((b, i) => view.data[i] === b)) {
    return null;
  }
  const stored = getCommitteeDecoder().decode(checkAccountVersion(view.data));
  return {
    address,
    members: stored.members.slice(0, stored.count),
    synced: stored.keysSynced === 1,
    mask: stored.keysMask,
    fingerprints: stored.keyFps.slice(0, stored.count).map((fp) => Uint8Array.from(fp)),
  };
}

export async function publishedKey(transport: Transport, wallet: Address, intent: Address): Promise<Uint8Array | null> {
  const text = (await loadProfile(transport, wallet))?.encryptionKey ?? null;
  if (text === null) {
    return null;
  }
  try {
    return parseEncryptionKey(text);
  } catch {
    throw new NotDeliverable(intent, `cannot be announced: the profile of ${wallet} names the encryption key ${text}, with which no shared secret can be made`);
  }
}

const recipientOf = (wallet: Address, key: Uint8Array | null): SealRecipient => (key === null ? wallet : { wallet, encryptionKey: key });

async function snapshotMatches(committee: CommitteeKeys, keys: readonly (Uint8Array | null)[]): Promise<boolean> {
  if (!committee.synced) {
    return false;
  }
  for (const [i, key] of keys.entries()) {
    const marked = ((committee.mask >> i) & 1) === 1;
    if (marked !== (key !== null) || (key !== null && !equal(await keyFingerprintV4(key), committee.fingerprints[i] ?? new Uint8Array()))) {
      return false;
    }
  }
  return true;
}

export async function recipientsFor(transport: Transport, attestor: Address, intent: Address): Promise<Recipients> {
  const committee = await committeeKeys(transport, attestor);
  if (committee === null) {
    return { committee: null, recipients: [recipientOf(attestor, await publishedKey(transport, attestor, intent))], sync: null };
  }
  const keys = await Promise.all(committee.members.map((member) => publishedKey(transport, member, intent)));
  const recipients = committee.members.map((member, i) => recipientOf(member, keys[i] ?? null));
  const sync = (await snapshotMatches(committee, keys)) ? null : await buildSyncCommitteeKeys({ committee: attestor, members: committee.members });
  return { committee, recipients, sync };
}

async function signedBy(worker: Address, signature: Uint8Array, message: Uint8Array): Promise<boolean> {
  if (signature.length !== 64) {
    return false;
  }
  try {
    return await verifySignature(await getPublicKeyFromAddress(worker), signature as SignatureBytes, message);
  } catch {
    return false;
  }
}

export async function secretSource(worker: TransactionSigner, intent: Address, sha256: string, given: SecretInput): Promise<Uint8Array> {
  if (given.secret !== undefined) {
    if (given.secret.length !== SECRET_BYTES) {
      throw new RangeError(SECRET_RULE);
    }
    return Uint8Array.from(given.secret);
  }
  const message = saltMessage(intent, sha256);
  if (given.saltSignature !== undefined) {
    if (!(await signedBy(worker.address, given.saltSignature, message))) {
      throw new BadSaltSignature(worker.address);
    }
    return Uint8Array.from(given.saltSignature);
  }
  if (!isMessagePartialSigner(worker) || isDevice(worker)) {
    throw new NoMessageSigner(worker.address);
  }
  const [signed] = await worker.signMessages([createSignableMessage(message)]);
  const signature = signed?.[worker.address];
  if (signature === undefined || signature.length !== 64) {
    throw new NoMessageSigner(worker.address);
  }
  return Uint8Array.from(signature);
}
