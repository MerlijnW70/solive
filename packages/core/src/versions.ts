import { type Address, getAddressDecoder, type ReadonlyUint8Array, type TransactionSigner } from "@solana/kit";
import {
  ANNOUNCEMENT_DISCRIMINATOR,
  CLAIM_BOARD_DISCRIMINATOR,
  CLAIM_LIST_DISCRIMINATOR,
  COMMITTEE_DISCRIMINATOR,
  CONFIG_DISCRIMINATOR,
  DELIVERY_BOOK_DISCRIMINATOR,
  getAnnouncementSize,
  getClaimBoardSize,
  getClaimListSize,
  getCloseLegacyInstruction,
  getCommitteeSize,
  getConfigSize,
  getDeliveryBookSize,
  getIntentSize,
  getMandateSize,
  getMintCapSize,
  getProfileSize,
  getRefutationSize,
  getStandbySize,
  getUserStateSize,
  INTENT_DISCRIMINATOR,
  MANDATE_DISCRIMINATOR,
  MINT_CAP_DISCRIMINATOR,
  PROFILE_DISCRIMINATOR,
  REFUTATION_DISCRIMINATOR,
  STANDBY_DISCRIMINATOR,
  USER_STATE_DISCRIMINATOR,
} from "../generated/client/index.js";
import { events } from "./builder-accounts.js";
import { claimSlot } from "./claims.js";
import { IntentCoreError, NotAnEngineAccount, SdkError } from "./errors.js";
import { CONFIG_VERSION, INTENT_VERSION, USER_VERSION } from "./state.js";

export const MANDATE_VERSION = 2;
export const MINT_CAP_VERSION = 2;
export const COMMITTEE_VERSION = 2;
export const CLAIMS_VERSION = 2;
export const STANDBY_VERSION = 1;
export const PROFILE_VERSION = 2;
export const CLAIM_LIST_VERSION = 1;
export const DELIVERY_BOOK_VERSION = 1;
export const ANNOUNCEMENT_VERSION = 1;
export const REFUTATION_VERSION = 1;
export const OLDEST_INTENT_VERSION = 1;
export const OLDEST_CLAIMS_VERSION = 1;
export const OLDEST_MINT_CAP_VERSION = 1;

const HEAD = 8;
const NONE = "11111111111111111111111111111111";

export type AccountLayout = {
  name: string;
  discriminator: ReadonlyUint8Array;
  space: number;
  versionAt: number;
  version: number;
  oldest: number;
  payerAt: number | null;
};

export const ACCOUNT_LAYOUTS: readonly AccountLayout[] = [
  { name: "config", discriminator: CONFIG_DISCRIMINATOR, space: getConfigSize(), versionAt: 139, version: CONFIG_VERSION, oldest: CONFIG_VERSION, payerAt: 0 },
  { name: "user", discriminator: USER_STATE_DISCRIMINATOR, space: getUserStateSize(), versionAt: 72, version: USER_VERSION, oldest: USER_VERSION, payerAt: 0 },
  { name: "intent", discriminator: INTENT_DISCRIMINATOR, space: getIntentSize(), versionAt: 164, version: INTENT_VERSION, oldest: OLDEST_INTENT_VERSION, payerAt: 296 },
  { name: "mandate", discriminator: MANDATE_DISCRIMINATOR, space: getMandateSize(), versionAt: 307, version: MANDATE_VERSION, oldest: MANDATE_VERSION, payerAt: 0 },
  { name: "mint cap", discriminator: MINT_CAP_DISCRIMINATOR, space: getMintCapSize(), versionAt: 68, version: MINT_CAP_VERSION, oldest: OLDEST_MINT_CAP_VERSION, payerAt: null },
  { name: "committee", discriminator: COMMITTEE_DISCRIMINATOR, space: getCommitteeSize(), versionAt: 330, version: COMMITTEE_VERSION, oldest: COMMITTEE_VERSION, payerAt: null },
  { name: "claim board", discriminator: CLAIM_BOARD_DISCRIMINATOR, space: getClaimBoardSize(), versionAt: 124, version: CLAIMS_VERSION, oldest: OLDEST_CLAIMS_VERSION, payerAt: 32 },
  { name: "stand-by entry", discriminator: STANDBY_DISCRIMINATOR, space: getStandbySize(), versionAt: 73, version: STANDBY_VERSION, oldest: STANDBY_VERSION, payerAt: 0 },
  { name: "profile", discriminator: PROFILE_DISCRIMINATOR, space: getProfileSize(), versionAt: 456, version: PROFILE_VERSION, oldest: PROFILE_VERSION, payerAt: 0 },
  { name: "claim list", discriminator: CLAIM_LIST_DISCRIMINATOR, space: getClaimListSize(), versionAt: 1090, version: CLAIM_LIST_VERSION, oldest: CLAIM_LIST_VERSION, payerAt: 32 },
  { name: "delivery book", discriminator: DELIVERY_BOOK_DISCRIMINATOR, space: getDeliveryBookSize(), versionAt: 80, version: DELIVERY_BOOK_VERSION, oldest: DELIVERY_BOOK_VERSION, payerAt: 32 },
  { name: "announcement", discriminator: ANNOUNCEMENT_DISCRIMINATOR, space: getAnnouncementSize(), versionAt: 282, version: ANNOUNCEMENT_VERSION, oldest: ANNOUNCEMENT_VERSION, payerAt: 96 },
  { name: "refutation", discriminator: REFUTATION_DISCRIMINATOR, space: getRefutationSize(), versionAt: 402, version: REFUTATION_VERSION, oldest: REFUTATION_VERSION, payerAt: 192 },
];

export function accountLayoutOf(data: ReadonlyUint8Array): AccountLayout | null {
  return ACCOUNT_LAYOUTS.find((layout) => layout.discriminator.every((b, i) => data[i] === b)) ?? null;
}

export function storedVersion(data: ReadonlyUint8Array): { layout: AccountLayout; version: number } | null {
  const layout = accountLayoutOf(data);
  const version = layout === null ? undefined : data[HEAD + layout.versionAt];
  return layout === null || version === undefined ? null : { layout, version };
}

export function isCurrentAccount(data: ReadonlyUint8Array): boolean {
  const stored = storedVersion(data);
  return stored !== null && data.length === stored.layout.space && stored.version === stored.layout.version;
}

export class AccountVersionError extends SdkError {
  readonly code = "account-version-error";
  override readonly name = "AccountVersionError";
  readonly account: string;
  readonly version: number | null;
  readonly current: number;

  constructor(account: string, version: number | null, current: number, size: number, oldest = current) {
    const found = version === null ? `${size} bytes long, not the ${account} layout` : `of version ${version}`;
    const reads = oldest === current ? `version ${current}` : `versions ${oldest} to ${current}`;
    super(`this ${account} account is ${found}; this SDK reads ${account} ${reads} only. Close it with intent-engine close-legacy`);
    this.account = account;
    this.version = version;
    this.current = current;
  }
}

export function checkAccountVersion<T extends ReadonlyUint8Array>(data: T): T {
  const stored = storedVersion(data);
  if (stored === null) {
    throw new NotAnEngineAccount(null, "the data is not an engine account");
  }
  const { layout, version } = stored;
  if (data.length !== layout.space) {
    throw new AccountVersionError(layout.name, null, layout.version, data.length, layout.oldest);
  }
  if (version < layout.oldest || version > layout.version) {
    throw new AccountVersionError(layout.name, version, layout.version, data.length, layout.oldest);
  }
  return data;
}

export function recordedPayer(data: ReadonlyUint8Array): Address | null {
  const at = accountLayoutOf(data)?.payerAt;
  if (at === undefined || at === null || data.length < HEAD + at + 32) {
    return null;
  }
  const payer = getAddressDecoder().decode(data.slice(HEAD + at, HEAD + at + 32));
  return payer === NONE ? null : payer;
}

export type BoardTerms = { intent: Address; owner: Address; worker: Address; until: bigint; held: bigint };

export function boardTerms(data: ReadonlyUint8Array): BoardTerms | null {
  if (!CLAIM_BOARD_DISCRIMINATOR.every((b, i) => data[i] === b) || data.length < HEAD + 120) {
    return null;
  }
  const key = (at: number) => getAddressDecoder().decode(data.slice(HEAD + at, HEAD + at + 32));
  const view = new DataView(data.buffer, data.byteOffset);
  return { intent: key(0), owner: key(32), worker: key(64), until: view.getBigInt64(HEAD + 96, true), held: view.getBigUint64(HEAD + 112, true) };
}

export function lineIntent(data: ReadonlyUint8Array): Address | null {
  const board = boardTerms(data);
  if (board !== null) {
    return board.intent;
  }
  if (!STANDBY_DISCRIMINATOR.every((b, i) => data[i] === b) || data.length < HEAD + 64) {
    return null;
  }
  return getAddressDecoder().decode(data.slice(HEAD + 32, HEAD + 64));
}

export function legacyStakeTo(terms: BoardTerms, escrowOpen: boolean, now: bigint): Address | null {
  if (terms.held === 0n) {
    return null;
  }
  const slot = claimSlot(terms, now);
  if (slot.state === "free") {
    return null;
  }
  if (slot.state === "lapsed") {
    return terms.owner;
  }
  if (escrowOpen) {
    throw new IntentCoreError("ClaimHeld");
  }
  return terms.worker;
}

export function migratesInPlace(data: ReadonlyUint8Array): boolean {
  return [CONFIG_DISCRIMINATOR, USER_STATE_DISCRIMINATOR].some((tag) => tag.every((b, i) => data[i] === b));
}

type CloseLegacyInput = { account: Address; payee: Address; config?: Address; vault?: Address; intent?: Address; stakeTo?: Address; feeTo?: Address };

export async function buildCloseLegacy(input: CloseLegacyInput) {
  return getCloseLegacyInstruction({
    account: input.account,
    payee: input.payee,
    ...(input.config === undefined ? {} : { config: input.config }),
    ...(input.vault === undefined ? {} : { vault: input.vault }),
    ...(input.intent === undefined ? {} : { intent: input.intent }),
    ...(input.stakeTo === undefined ? {} : { stakeTo: input.stakeTo }),
    ...(input.feeTo === undefined ? {} : { feeTo: input.feeTo }),
    ...(await events()),
  });
}
