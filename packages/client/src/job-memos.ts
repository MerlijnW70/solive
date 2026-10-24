import { AccountRole, type AccountSignerMeta, type Address, type Instruction, type TransactionSigner } from "@solana/kit";
import { type EngineTransaction, MEMO_PROGRAM_ADDRESS } from "./transport.js";

export function memosSignedBy(transaction: EngineTransaction, signer: Address): string[] {
  return (transaction.memos ?? []).filter((_, i) => transaction.memoSigners?.[i]?.includes(signer) === true);
}

export function memoInstruction(signer: TransactionSigner, text: string): Instruction {
  const meta: AccountSignerMeta = { address: signer.address, role: AccountRole.READONLY_SIGNER, signer };
  return { programAddress: MEMO_PROGRAM_ADDRESS, accounts: [meta], data: new TextEncoder().encode(text) };
}
