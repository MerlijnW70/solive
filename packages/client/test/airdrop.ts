import type { Address, Lamports } from "@solana/kit";
import { FailedTransactionMetadata, type LiteSVM } from "litesvm";

export function airdropped(svm: LiteSVM, address: Address, amount: Lamports): void {
  const result = svm.airdrop(address, amount);
  if (result === null || result instanceof FailedTransactionMetadata) {
    throw new Error(`airdrop of ${amount} to ${address} failed: ${result === null ? "no result" : String(result.err())}`);
  }
}
