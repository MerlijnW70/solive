import type { Address } from "@solana/kit";
import { findUserStatePda, type Intent } from "../generated/client/index.js";
import { decodeMandateAccount, decodeUserStateAccount } from "./account-reads.js";
import { NO_MANDATE } from "./mandate.js";
import { AccountVersionError } from "./versions.js";

export type AccountData = (address: Address) => Promise<Uint8Array | null>;

export const MANDATE_GONE = "its mandate is revoked: the mandate account is closed";

export const OWNER_STATE_GONE = "its mandate is revoked: the owner's user state is gone";

export const mandateUnreadable = (account: string, error: unknown) =>
  `its mandate cannot be checked: the ${account} is unreadable (${error instanceof Error ? error.message : String(error)})`;

export const mandateReplaced = (serial: bigint, recorded: bigint) =>
  `its mandate is revoked: the mandate now has serial ${serial}, not the intent's ${recorded}`;

export const mandateEpochPassed = (epoch: bigint, granted: bigint) =>
  `its mandate is revoked: the owner advanced to epoch ${epoch}, past the mandate's ${granted}`;

export type DeadMandate = { kind: "revoked" | "outdated"; text: string };

export const mandateOutdated = (account: string) => `its mandate cannot be used: the ${account} is of another version than this program reads`;

function decoded<T>(account: string, read: () => T): T | DeadMandate {
  try {
    return read();
  } catch (error) {
    if (error instanceof AccountVersionError && error.version !== null) {
      return { kind: "outdated", text: mandateOutdated(account) };
    }
    return { kind: "revoked", text: mandateUnreadable(account, error) };
  }
}

const dead = (text: string): DeadMandate => ({ kind: "revoked", text });

const isDead = (value: unknown): value is DeadMandate => typeof value === "object" && value !== null && "kind" in value && "text" in value;

export async function mandateVerdict(intent: Intent, account: AccountData): Promise<DeadMandate | null> {
  if (intent.mandate === NO_MANDATE) {
    return null;
  }
  const [ownerState] = await findUserStatePda({ owner: intent.owner });
  const [mandateData, stateData] = await Promise.all([account(intent.mandate), account(ownerState)]);
  if (mandateData === null) {
    return dead(MANDATE_GONE);
  }
  if (stateData === null) {
    return dead(OWNER_STATE_GONE);
  }
  const grant = decoded("mandate account", () => decodeMandateAccount(mandateData));
  if (isDead(grant)) {
    return grant;
  }
  const user = decoded("owner's user state", () => decodeUserStateAccount(stateData));
  if (isDead(user)) {
    return user;
  }
  if (grant.serial !== intent.mandateSerial) {
    return dead(mandateReplaced(grant.serial, intent.mandateSerial));
  }
  if (grant.epoch !== user.epoch) {
    return dead(mandateEpochPassed(user.epoch, grant.epoch));
  }
  return null;
}

export async function deadMandate(intent: Intent, account: AccountData): Promise<string | null> {
  return (await mandateVerdict(intent, account))?.text ?? null;
}
