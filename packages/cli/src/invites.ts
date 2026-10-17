import type { Address } from "@solana/kit";
import { readSpec, SpecSealed, type SpecFetch, type Transport } from "@intent-engine/client";

export const notInvited = (payee: Address, intent: Address): string =>
  `${payee} was not invited to the job ${intent}: its spec is sealed to other wallets, so pay one of them; nothing was paid`;

export async function invitedTo(transport: Transport, get: SpecFetch | undefined, intent: Address): Promise<Address[] | undefined> {
  if (get === undefined) {
    return undefined;
  }
  try {
    return (await readSpec(transport, get, intent))?.sealedTo;
  } catch (error) {
    return error instanceof SpecSealed ? error.to : undefined;
  }
}
