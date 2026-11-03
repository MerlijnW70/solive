import type { Address } from "@solana/kit";
import { getTokenDecoder } from "@solana-program/token";
import { findVaultPda } from "@intent-engine/core/internal";
import { createdAccount } from "./accounts.js";
import type { Transport } from "./transport.js";

export async function vaultBalance(transport: Transport, intent: Address): Promise<bigint> {
  const [vault] = await findVaultPda({ intent });
  const view = await createdAccount(transport, vault);
  return view === null ? 0n : getTokenDecoder().decode(view.data).amount;
}
