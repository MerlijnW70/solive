import type { Address, ReadonlyUint8Array } from "@solana/kit";
import {
  type Announcement,
  type ClaimBoard,
  type ClaimList,
  type Committee,
  type Config,
  type DeliveryBook,
  getAnnouncementDecoder,
  getClaimBoardDecoder,
  getClaimListDecoder,
  getCommitteeDecoder,
  getConfigDecoder,
  getDeliveryBookDecoder,
  getIntentDecoder,
  getMandateDecoder,
  getMintCapDecoder,
  getProfileDecoder,
  getRefutationDecoder,
  getStandbyDecoder,
  getUserStateDecoder,
  type Intent,
  type Mandate,
  type MintCap,
  type Profile,
  type Refutation,
  type Standby,
  type UserState,
} from "../generated/client/index.js";
import { NotAnEngineAccount } from "./errors.js";
import { AccountVersionError, accountLayoutOf, checkAccountVersion } from "./versions.js";

function laidOutAs<T extends ReadonlyUint8Array>(name: string, data: T): T {
  if (accountLayoutOf(data)?.name !== name) {
    throw new NotAnEngineAccount(null, `the data is not an engine ${name} account`);
  }
  return data;
}

export function decodeConfigAccount(data: ReadonlyUint8Array): Config {
  return getConfigDecoder().decode(checkAccountVersion(laidOutAs("config", data)));
}

export function decodeUserStateAccount(data: ReadonlyUint8Array): UserState {
  return getUserStateDecoder().decode(checkAccountVersion(laidOutAs("user", data)));
}

export function decodeIntentAccount(data: ReadonlyUint8Array): Intent {
  return getIntentDecoder().decode(checkAccountVersion(laidOutAs("intent", data)));
}

export function decodeMandateAccount(data: ReadonlyUint8Array): Mandate {
  return getMandateDecoder().decode(checkAccountVersion(laidOutAs("mandate", data)));
}

export function decodeMintCapAccount(data: ReadonlyUint8Array): MintCap {
  return getMintCapDecoder().decode(checkAccountVersion(laidOutAs("mint cap", data)));
}

export function decodeCommitteeAccount(data: ReadonlyUint8Array): Committee {
  return getCommitteeDecoder().decode(checkAccountVersion(laidOutAs("committee", data)));
}

export function decodeClaimBoardAccount(data: ReadonlyUint8Array): ClaimBoard {
  return getClaimBoardDecoder().decode(checkAccountVersion(laidOutAs("claim board", data)));
}

export function decodeStandbyAccount(data: ReadonlyUint8Array): Standby {
  return getStandbyDecoder().decode(checkAccountVersion(laidOutAs("stand-by entry", data)));
}

export function decodeProfileAccount(data: ReadonlyUint8Array): Profile {
  return getProfileDecoder().decode(checkAccountVersion(laidOutAs("profile", data)));
}

export function decodeClaimListAccount(data: ReadonlyUint8Array): ClaimList {
  return getClaimListDecoder().decode(checkAccountVersion(laidOutAs("claim list", data)));
}

export function decodeDeliveryBookAccount(data: ReadonlyUint8Array): DeliveryBook {
  return getDeliveryBookDecoder().decode(checkAccountVersion(laidOutAs("delivery book", data)));
}

export function decodeAnnouncementAccount(data: ReadonlyUint8Array): Announcement {
  return getAnnouncementDecoder().decode(checkAccountVersion(laidOutAs("announcement", data)));
}

export function decodeRefutationAccount(data: ReadonlyUint8Array): Refutation {
  return getRefutationDecoder().decode(checkAccountVersion(laidOutAs("refutation", data)));
}

export type UnreadableAccount = { address: Address; reason: string };

export function isUnreadableAccount(error: unknown): error is AccountVersionError | NotAnEngineAccount {
  return error instanceof AccountVersionError || error instanceof NotAnEngineAccount;
}

export function readAccounts<T>(
  entries: readonly { address: Address; data: ReadonlyUint8Array }[],
  decode: (data: ReadonlyUint8Array) => T,
): { read: { address: Address; account: T }[]; unreadable: UnreadableAccount[] } {
  const read: { address: Address; account: T }[] = [];
  const unreadable: UnreadableAccount[] = [];
  for (const { address, data } of entries) {
    try {
      read.push({ address, account: decode(data) });
    } catch (error) {
      if (!isUnreadableAccount(error)) {
        throw error;
      }
      unreadable.push({ address, reason: error.message });
    }
  }
  return { read, unreadable };
}

export function readIntentAccounts(entries: readonly { address: Address; data: ReadonlyUint8Array }[]): {
  intents: { address: Address; intent: Intent }[];
  unreadable: UnreadableAccount[];
} {
  const { read, unreadable } = readAccounts(entries, decodeIntentAccount);
  return { intents: read.map(({ address, account }) => ({ address, intent: account })), unreadable };
}
