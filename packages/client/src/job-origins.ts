import type { Address } from "@solana/kit";
import type { EngineTransaction } from "./transport.js";

export type EngineCall = { data: Uint8Array; accounts: Address[] | undefined; inner: boolean };

export function engineCalls(transaction: EngineTransaction): EngineCall[] {
  return [
    ...(transaction.called ?? []).map((data, i) => ({ data, accounts: transaction.calledAccounts?.[i], inner: false })),
    ...transaction.emitted.map((data, i) => ({ data, accounts: transaction.emittedAccounts?.[i], inner: true })),
  ];
}
