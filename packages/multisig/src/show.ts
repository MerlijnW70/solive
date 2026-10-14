import type { PublicKey } from "@solana/web3.js";
import * as squads from "@sqds/multisig";
import type { Chain } from "./chain.js";
import { decodeMessage, permissionNames, readMultisig, readProposal, readVaultTransaction, Refusal, statusOf, vaultOf } from "./squads.js";

export async function show(chain: Chain, address: PublicKey, only: bigint | undefined): Promise<object> {
  const multisig = await readMultisig(chain, address);
  const last = BigInt(squads.utils.toBigInt(multisig.transactionIndex));
  const stale = BigInt(squads.utils.toBigInt(multisig.staleTransactionIndex));
  if (only !== undefined && (only < 1n || only > last)) {
    throw new Refusal(`multisig ${address.toBase58()} has proposals 1 to ${last}, not ${only}`);
  }
  const indexes = only === undefined ? Array.from({ length: Number(last) }, (_, i) => BigInt(i + 1)) : [only];
  const proposals = [];
  for (const index of indexes) {
    const proposal = await readProposal(chain, address, index);
    const transaction = await readVaultTransaction(chain, address, index);
    const instructions = transaction === null ? [] : decodeMessage(transaction.message);
    proposals.push({
      index: index.toString(),
      status: statusOf(proposal),
      stale: index <= stale,
      approvals: `${proposal?.approved.length ?? 0} of ${multisig.threshold}`,
      approved: proposal?.approved.map((k) => k.toBase58()) ?? [],
      rejected: proposal?.rejected.map((k) => k.toBase58()) ?? [],
      cancelled: proposal?.cancelled.map((k) => k.toBase58()) ?? [],
      creator: transaction?.creator.toBase58() ?? null,
      summary:
        transaction === null ? ["No vault transaction at this index: a config transaction, or one already closed"] : instructions.map((d) => d.summary),
      instructions,
    });
  }
  return {
    multisig: address.toBase58(),
    vault: vaultOf(address).toBase58(),
    threshold: multisig.threshold,
    time_lock: multisig.timeLock,
    members: multisig.members.map((m) => ({ address: m.key.toBase58(), permissions: permissionNames(m.permissions.mask) })),
    transaction_index: last.toString(),
    stale_transaction_index: stale.toString(),
    proposals,
  };
}
