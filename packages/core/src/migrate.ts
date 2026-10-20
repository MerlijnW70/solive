import type { Address, ReadonlyUint8Array, TransactionSigner } from "@solana/kit";
import {
  CLAIM_BOARD_DISCRIMINATOR,
  COMMITTEE_DISCRIMINATOR,
  CONFIG_DISCRIMINATOR,
  getClaimBoardSize,
  getCommitteeSize,
  getConfigSize,
  getIntentSize,
  getMandateSize,
  getMigrateInstruction,
  getMintCapSize,
  getProfileSize,
  getStandbySize,
  getUserStateSize,
  INTENT_DISCRIMINATOR,
  MANDATE_DISCRIMINATOR,
  MINT_CAP_DISCRIMINATOR,
  PROFILE_DISCRIMINATOR,
  STANDBY_DISCRIMINATOR,
  USER_STATE_DISCRIMINATOR,
} from "../generated/client/index.js";
import { events } from "./builder-accounts.js";
import { type AccountLayout, storedVersion } from "./versions.js";

export const LEGACY_CONFIG_SPACE = 216;
export const LEGACY_BOARD_SPACE = 168;
export const FIRST_VERSION = 1;
export const UNVERSIONED = 0;

export type OutdatedLayout = { discriminator: ReadonlyUint8Array; space: number; version: number };

const outdated = (discriminator: ReadonlyUint8Array, space: number, version = FIRST_VERSION): OutdatedLayout => ({
  discriminator,
  space,
  version,
});

export const OUTDATED_LAYOUTS: readonly OutdatedLayout[] = [
  outdated(CONFIG_DISCRIMINATOR, LEGACY_CONFIG_SPACE),
  outdated(CONFIG_DISCRIMINATOR, getConfigSize()),
  outdated(USER_STATE_DISCRIMINATOR, getUserStateSize()),
  outdated(INTENT_DISCRIMINATOR, getIntentSize()),
  outdated(MANDATE_DISCRIMINATOR, getMandateSize()),
  outdated(MINT_CAP_DISCRIMINATOR, getMintCapSize()),
  outdated(COMMITTEE_DISCRIMINATOR, getCommitteeSize()),
  outdated(CLAIM_BOARD_DISCRIMINATOR, LEGACY_BOARD_SPACE),
  outdated(CLAIM_BOARD_DISCRIMINATOR, getClaimBoardSize()),
  outdated(STANDBY_DISCRIMINATOR, getStandbySize(), UNVERSIONED),
  outdated(PROFILE_DISCRIMINATOR, getProfileSize()),
];

export type Migration = { layout: AccountLayout; from: OutdatedLayout };

const sameBytes = (a: ReadonlyUint8Array, b: ReadonlyUint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);

export function migrationOf(data: ReadonlyUint8Array): Migration | null {
  const stored = storedVersion(data);
  if (stored === null) {
    return null;
  }
  const from = OUTDATED_LAYOUTS.find(
    (o) => sameBytes(o.discriminator, stored.layout.discriminator) && o.space === data.length && o.version === stored.version,
  );
  return from === undefined ? null : { layout: stored.layout, from };
}

export function isConfigAccount(data: ReadonlyUint8Array): boolean {
  return CONFIG_DISCRIMINATOR.every((b, i) => data[i] === b);
}

type MigrateInput = { payer: TransactionSigner; account: Address; config?: Address };

export async function buildMigrate(input: MigrateInput) {
  return getMigrateInstruction({
    payer: input.payer,
    account: input.account,
    ...(input.config === undefined ? {} : { config: input.config }),
    ...(await events()),
  });
}
