import type { Address } from "@solana/kit";
import { parseFeedbackMemo } from "@intent-engine/core/internal";
import type { EngineTransaction } from "./transport.js";

export function feedbackOf(transactions: readonly EngineTransaction[], intent: Address, owner: Address, release: EngineTransaction): number | undefined {
  const at = transactions.findIndex(({ signature }) => signature === release.signature);
  const after = ({ slot }: EngineTransaction, index: number): boolean => slot > release.slot || (slot === release.slot && index < at);
  const ordered = transactions
    .filter((transaction, index) => !transaction.failed && after(transaction, index))
    .reverse()
    .sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
  for (const { memos, memoSigners } of ordered) {
    for (const [i, text] of (memos ?? []).entries()) {
      const memo = parseFeedbackMemo(text);
      if (memo !== null && memo.intent === intent && memoSigners?.[i]?.includes(owner) === true) {
        return memo.score;
      }
    }
  }
  return undefined;
}
