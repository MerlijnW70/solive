import {
  type Address,
  getAddressEncoder,
  getProgramDerivedAddress,
  getU64Encoder,
  type ProgramDerivedAddress,
} from "@solana/kit";
import { INTENT_ENGINE_PROGRAM_ADDRESS } from "../generated/client/index.js";

export const ASSOCIATED_TOKEN_PROGRAM_ADDRESS =
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address<"ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL">;

const text = (s: string) => new TextEncoder().encode(s);

export async function findIntentPda(
  seeds: { owner: Address; nonce: bigint },
  programAddress: Address = INTENT_ENGINE_PROGRAM_ADDRESS,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress,
    seeds: [
      text("intent"),
      getAddressEncoder().encode(seeds.owner),
      getU64Encoder().encode(seeds.nonce),
    ],
  });
}

export async function findMandatePda(
  seeds: { owner: Address; agent: Address; id: bigint },
  programAddress: Address = INTENT_ENGINE_PROGRAM_ADDRESS,
): Promise<ProgramDerivedAddress> {
  const address = getAddressEncoder();
  return getProgramDerivedAddress({
    programAddress,
    seeds: [text("mandate"), address.encode(seeds.owner), address.encode(seeds.agent), getU64Encoder().encode(seeds.id)],
  });
}

export async function findEventAuthorityPda(
  programAddress: Address = INTENT_ENGINE_PROGRAM_ADDRESS,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({ programAddress, seeds: [text("__event_authority")] });
}

export async function findAssociatedTokenAddress(seeds: {
  owner: Address;
  mint: Address;
  tokenProgram: Address;
}): Promise<Address> {
  const address = getAddressEncoder();
  const [ata] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    seeds: [
      address.encode(seeds.owner),
      address.encode(seeds.tokenProgram),
      address.encode(seeds.mint),
    ],
  });
  return ata;
}
