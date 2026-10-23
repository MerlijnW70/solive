import type { Address } from "@solana/kit";
import { type EngineEvent, splitN } from "@intent-engine/core";
import { paidWalletsOf } from "./delivery-openings.js";
import { signaturePage } from "./job-scan.js";
import { splitClaim } from "./release-reads.js";
import { type EngineTransaction, TRANSACTION_FETCHES, type Transport } from "./transport.js";

export type OwnHistory = { transactions: EngineTransaction[]; complete: boolean };

export async function ownHistory(transport: Transport, wallet: Address, count: number): Promise<OwnHistory> {
  const { signaturesOf, transactionsOf } = transport;
  if (signaturesOf === undefined || transactionsOf === undefined) {
    const found = await transport.engineTransactions(count, wallet);
    const transactions = found.slice(0, count);
    return { transactions, complete: found.length < count && !transactions.some(({ unread }) => unread === true) };
  }
  const { listed, last } = await signaturePage(transport, signaturesOf, wallet, count);
  const wanted = listed.filter(({ failed }) => !failed);
  const transactions: EngineTransaction[] = [];
  for (let at = 0; at < wanted.length; at += TRANSACTION_FETCHES) {
    transactions.push(...(await transactionsOf.call(transport, wanted.slice(at, at + TRANSACTION_FETCHES))));
  }
  return { transactions, complete: last && !transactions.some(({ unread }) => unread === true) };
}

export type ReleaseRead = { event: EngineEvent; transaction: EngineTransaction };

export async function releaseShareOf(transport: Transport, release: ReleaseRead, intent: Address, wallet: Address): Promise<bigint | null> {
  const { event, transaction } = release;
  if (event.name === "IntentSplit") {
    const claim = splitClaim(transaction, intent);
    if (claim === null || !claim.recipients.includes(wallet)) {
      return null;
    }
    let shares: bigint[];
    try {
      shares = splitN(event.fields.net, claim.weights);
    } catch {
      return null;
    }
    return claim.recipients.reduce((sum, to, at) => (to === wallet ? sum + (shares[at] ?? 0n) : sum), 0n);
  }
  if (event.name !== "IntentAttested") {
    return null;
  }
  return (await paidWalletsOf(transport, release, intent))?.includes(wallet) === true ? event.fields.net : null;
}
