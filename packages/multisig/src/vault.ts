import type { Address } from "@solana/kit";
import type { Chain } from "./chain.js";
import { permissionNames, readMultisig, vaultOf } from "./squads.js";

export async function vault(chain: Chain, at: Address): Promise<object> {
  const multisig = await readMultisig(chain, at);
  return {
    multisig: at,
    vault: await vaultOf(at),
    threshold: multisig.threshold,
    timeLock: multisig.timeLock,
    members: multisig.members.map((m) => ({ address: m.key, permissions: permissionNames(m.permissions.mask) })),
    transactionIndex: multisig.transactionIndex.toString(),
  };
}
