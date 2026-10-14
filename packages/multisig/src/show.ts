import type { Address } from "@solana/kit";
import type { Chain } from "./chain.js";
import { decodeMessage, permissionNames, readMultisig, readProposal, readVaultTransaction, Refusal, statusOf, vaultOf } from "./squads.js";

export async function show(chain: Chain, at: Address, only: bigint | undefined): Promise<object> {
  const multisig = await readMultisig(chain, at);
  const last = multisig.transactionIndex;
  const stale = multisig.staleTransactionIndex;
  if (only !== undefined && (only < 1n || only > last)) {
    throw new Refusal(`multisig ${at} has proposals 1 to ${last}, not ${only}`);
  }
  const indexes = only === undefined ? Array.from({ length: Number(last) }, (_, i) => BigInt(i + 1)) : [only];
  const proposals = [];
  for (const index of indexes) {
    const proposal = await readProposal(chain, at, index);
    const transaction = await readVaultTransaction(chain, at, index);
    const instructions = transaction === null ? [] : await decodeMessage(transaction.message);
    proposals.push({
      index: index.toString(),
      status: statusOf(proposal),
      stale: index <= stale,
      approvals: `${proposal?.approved.length ?? 0} of ${multisig.threshold}`,
      approved: proposal?.approved ?? [],
      rejected: proposal?.rejected ?? [],
      cancelled: proposal?.cancelled ?? [],
      creator: transaction?.creator ?? null,
      summary:
        transaction === null ? ["No vault transaction at this index: a config transaction, or one already closed"] : instructions.map((d) => d.summary),
      instructions,
    });
  }
  return {
    multisig: at,
    vault: await vaultOf(at),
    threshold: multisig.threshold,
    time_lock: multisig.timeLock,
    members: multisig.members.map((m) => ({ address: m.key, permissions: permissionNames(m.permissions.mask) })),
    transaction_index: last.toString(),
    stale_transaction_index: stale.toString(),
    proposals,
  };
}
