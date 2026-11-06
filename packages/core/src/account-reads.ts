import type { Address, ReadonlyUint8Array } from "@solana/kit";
import {
  type Announcement,
  type ClaimBoard,
  type ClaimList,
  type Committee,
  type Config,
  type DeliveryBook,
  CLAIM_BOARD_DISCRIMINATOR,
  DELIVERY_BOOK_DISCRIMINATOR,
  getAnnouncementDecoder,
  getClaimBoardDecoder,
  getClaimBoardSize,
  getDeliveryBookSize,
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
import { FIRST_VERSION, V1_BOOK_SPACE, V2_BOARD_SPACE, V2_BOARD_VERSION } from "./migrate.js";
import { AccountVersionError, accountLayoutOf, checkAccountVersion } from "./versions.js";

const OLDER_BOARD_VERSION_AT = 8 + 124;
const OLDER_BOOK_VERSION_AT = 8 + 80;

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

const widened = (data: ReadonlyUint8Array, space: number): Uint8Array => {
  const out = new Uint8Array(space);
  out.set(data.subarray(0, Math.min(data.length, space)));
  return out;
};

const tagged = (data: ReadonlyUint8Array, tag: ReadonlyUint8Array): boolean => tag.every((b, i) => data[i] === b);

export function isOlderBoard(data: ReadonlyUint8Array): boolean {
  return tagged(data, CLAIM_BOARD_DISCRIMINATOR) && data.length === V2_BOARD_SPACE && data[OLDER_BOARD_VERSION_AT] === V2_BOARD_VERSION;
}

export function isOlderBook(data: ReadonlyUint8Array): boolean {
  return tagged(data, DELIVERY_BOOK_DISCRIMINATOR) && data.length === V1_BOOK_SPACE && data[OLDER_BOOK_VERSION_AT] === FIRST_VERSION;
}

export function decodeClaimBoardOrOlder(data: ReadonlyUint8Array): ClaimBoard {
  return isOlderBoard(data) ? getClaimBoardDecoder().decode(widened(data, getClaimBoardSize())) : decodeClaimBoardAccount(data);
}

export function decodeDeliveryBookOrOlder(data: ReadonlyUint8Array): DeliveryBook {
  return isOlderBook(data) ? getDeliveryBookDecoder().decode(widened(data, getDeliveryBookSize())) : decodeDeliveryBookAccount(data);
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
