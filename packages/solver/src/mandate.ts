import type { Address } from "@solana/kit";
import type { Intent } from "@intent-engine/core";
import { decodeMandateAccount, decodeUserStateAccount, findUserStatePda, NO_MANDATE } from "@intent-engine/core/internal";

export type AccountData = (address: Address) => Promise<Uint8Array | null>;

export const MANDATE_GONE = "its mandate is revoked: the mandate account is closed";

export const OWNER_STATE_GONE = "its mandate is revoked: the owner's user state is gone";

export const mandateUnreadable = (account: string, error: unknown) =>
  `its mandate cannot be checked: the ${account} is unreadable (${error instanceof Error ? error.message : String(error)})`;

export const mandateReplaced = (serial: bigint, recorded: bigint) =>
  `its mandate is revoked: the mandate now has serial ${serial}, not the intent's ${recorded}`;

export const mandateEpochPassed = (epoch: bigint, granted: bigint) =>
  `its mandate is revoked: the owner advanced to epoch ${epoch}, past the mandate's ${granted}`;

function decoded<T>(account: string, read: () => T): T | string {
  try {
    return read();
  } catch (error) {
    return mandateUnreadable(account, error);
  }
}

export async function deadMandate(intent: Intent, account: AccountData): Promise<string | null> {
  if (intent.mandate === NO_MANDATE) {
    return null;
  }
  const [ownerState] = await findUserStatePda({ owner: intent.owner });
  const [mandateData, stateData] = await Promise.all([account(intent.mandate), account(ownerState)]);
  if (mandateData === null) {
    return MANDATE_GONE;
  }
  if (stateData === null) {
    return OWNER_STATE_GONE;
  }
  const grant = decoded("mandate account", () => decodeMandateAccount(mandateData));
  if (typeof grant === "string") {
    return grant;
  }
  const user = decoded("owner's user state", () => decodeUserStateAccount(stateData));
  if (typeof user === "string") {
    return user;
  }
  if (grant.serial !== intent.mandateSerial) {
    return mandateReplaced(grant.serial, intent.mandateSerial);
  }
  if (grant.epoch !== user.epoch) {
    return mandateEpochPassed(user.epoch, grant.epoch);
  }
  return null;
}
