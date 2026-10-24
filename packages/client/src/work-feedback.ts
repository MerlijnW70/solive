import type { Address } from "@solana/kit";
import { parseFeedbackMemo } from "@intent-engine/core";
import type { EngineTransaction } from "./transport.js";

export function feedbackOf(transactions: readonly EngineTransaction[], intent: Address, owner: Address): number | undefined {
  const ordered = [...transactions].filter(({ failed }) => !failed).sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
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
