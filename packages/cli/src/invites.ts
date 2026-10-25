import type { Address } from "@solana/kit";
import { isSdkError, SpecUnreadable, type SpecFetch, type Transport } from "@intent-engine/client";
import { readSpec } from "@intent-engine/client/internal";
import { systemLookup } from "./public-address.js";

export type Invites = { kind: "open" } | { kind: "sealed"; to: Address[] } | { kind: "unread"; reason: string };

export type InviteCode = "NotInvited" | "SpecUnreadable";

export const notInvited = (payee: Address, intent: Address): string =>
  `${payee} was not invited to the job ${intent}: its spec is sealed to other wallets, so pay one of them; nothing was paid`;

export const inviteUnchecked = (intent: Address, reason: string): string =>
  `who the job ${intent} invites cannot be checked: ${reason}; nothing was paid; try again once its spec url can be read`;

export const claimNotInvited = (worker: Address, intent: Address): string =>
  `${worker} was not invited to the job ${intent}: its spec is sealed to other wallets, so no release can pay it; nothing was sent`;

export const deliverNotInvited = (worker: Address, intent: Address): string =>
  `${worker} was not invited to the job ${intent}: its spec is sealed to other wallets, so no release can pay this wallet for this work`;

export class InviteRefused extends Error {
  readonly code: InviteCode;

  constructor(code: InviteCode, message: string) {
    super(message);
    this.name = "InviteRefused";
    this.code = code;
  }
}

const OPEN: Invites = { kind: "open" };

export async function invitesOf(transport: Transport, get: SpecFetch, intent: Address): Promise<Invites> {
  let fetching = false;
  const watched: SpecFetch = (url, init) => {
    fetching = true;
    return get(url, init);
  };
  try {
    const spec = await readSpec(transport, watched, intent, undefined, systemLookup);
    return spec?.sealedTo === undefined ? OPEN : { kind: "sealed", to: spec.sealedTo };
  } catch (error) {
    if (isSdkError(error, "spec-sealed")) {
      return { kind: "sealed", to: error.to };
    }
    if (isSdkError(error, "spec-unreadable")) {
      return { kind: "unread", reason: error.message };
    }
    if (fetching) {
      return { kind: "unread", reason: `its spec url could not be fetched (${error instanceof Error ? error.message : String(error)})` };
    }
    throw error;
  }
}

export async function checkInvited(transport: Transport, get: SpecFetch, intent: Address, payees: readonly Address[]): Promise<void> {
  const invites = await invitesOf(transport, get, intent);
  if (invites.kind === "unread") {
    throw new InviteRefused("SpecUnreadable", inviteUnchecked(intent, invites.reason));
  }
  const outside = invites.kind === "sealed" ? payees.find((payee) => !invites.to.includes(payee)) : undefined;
  if (outside !== undefined) {
    throw new InviteRefused("NotInvited", notInvited(outside, intent));
  }
}

export async function sealedInvites(transport: Transport, get: SpecFetch, intent: Address): Promise<Address[] | undefined> {
  const invites = await invitesOf(transport, get, intent);
  return invites.kind === "sealed" ? invites.to : undefined;
}
