import { type Address, getAddressEncoder, getProgramDerivedAddress, type TransactionSigner } from "@solana/kit";
import {
  getInitConfigInstructionAsync,
  getLowerPauseInstruction,
  getProposeAdminInstruction,
  getAcceptAdminInstruction,
  getUpdateConfigInstruction,
  getRaisePauseInstruction,
  getUpdateEconomicsInstruction,
  INTENT_ENGINE_PROGRAM_ADDRESS,
} from "../generated/client/index.js";
import { events } from "./builder-accounts.js";

export const UPGRADEABLE_LOADER_ADDRESS =
  "BPFLoaderUpgradeab1e11111111111111111111111" as Address<"BPFLoaderUpgradeab1e11111111111111111111111">;

export async function findProgramDataAddress(program: Address = INTENT_ENGINE_PROGRAM_ADDRESS): Promise<Address> {
  const [address] = await getProgramDerivedAddress({
    programAddress: UPGRADEABLE_LOADER_ADDRESS,
    seeds: [getAddressEncoder().encode(program)],
  });
  return address;
}

export async function buildInitConfig(input: {
  authority: TransactionSigner;
  domain: Uint8Array;
  guardian: Address;
  feeRecipient: Address;
  enabledKinds: bigint;
  feeBps: number;
  paused: number;
}) {
  return getInitConfigInstructionAsync({
    authority: input.authority,
    programData: await findProgramDataAddress(),
    domain: input.domain,
    guardian: input.guardian,
    feeRecipient: input.feeRecipient,
    enabledKinds: input.enabledKinds,
    feeBps: input.feeBps,
    paused: input.paused,
    ...(await events()),
  });
}

export async function buildRaisePause(input: { authority: TransactionSigner; flags: number }) {
  return getRaisePauseInstruction({ authority: input.authority, flags: input.flags, ...(await events()) });
}

export async function buildLowerPause(input: { admin: TransactionSigner; flags: number }) {
  return getLowerPauseInstruction({ admin: input.admin, flags: input.flags, ...(await events()) });
}

export type ConfigUpdateSpec = {
  guardian: Address;
  feeRecipient: Address;
  enabledKinds: bigint;
  feeBps: number;
  fillDisabledKinds: bigint;
};

export async function buildUpdateConfig(input: { admin: TransactionSigner; update: ConfigUpdateSpec }) {
  return getUpdateConfigInstruction({ admin: input.admin, ...input.update, ...(await events()) });
}

export async function buildProposeAdmin(input: { admin: TransactionSigner; pendingAdmin: Address }) {
  return getProposeAdminInstruction({ admin: input.admin, pendingAdmin: input.pendingAdmin, ...(await events()) });
}

export async function buildAcceptAdmin(input: { pendingAdmin: TransactionSigner }) {
  return getAcceptAdminInstruction({ pendingAdmin: input.pendingAdmin, ...(await events()) });
}

export type EconomicsSpec = {
  kindFeeMask: number;
  kindFeeBps: readonly [number, number, number, number];
  partnerCutBps: number;
  crankBounty: number;
  createFee: number;
};

export async function buildUpdateEconomics(input: { admin: TransactionSigner; economics: EconomicsSpec }) {
  const e = input.economics;
  return getUpdateEconomicsInstruction({
    admin: input.admin,
    kindFeeMask: e.kindFeeMask,
    kindFeeBps: [...e.kindFeeBps],
    partnerCutBps: e.partnerCutBps,
    crankBounty: e.crankBounty,
    createFee: e.createFee,
    ...(await events()),
  });
}
