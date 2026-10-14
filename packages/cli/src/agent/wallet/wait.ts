import type { Address } from "@solana/kit";
import { findIntentPda, formatAmount, getIntentDecoder } from "@intent-engine/core";
import { mintOf, unmemoized } from "@intent-engine/client";
import { type AgentContext, define } from "../actions.js";
import { tool } from "../names.js";
import { account, amount, choice, integer, object, optional, text } from "../schema.js";
import { STATUS } from "../../accounts.js";
import { WAIT_DEFAULT, WAIT_MAX, access, signerOf, nameOf } from "./guard.js";
import { type Pair, historyIn } from "./fills.js";
import { HISTORY_PAGES, releaseLookup, releasedMint, createdMint } from "./releases.js";

export const WAIT_STATUS = ["open", "filling", "filled", "cancelled", "expired", "closed"] as const;

type WaitStatus = (typeof WAIT_STATUS)[number];

export const UNREAD = `the node could not yet return all of this intent's transactions, so whether it filled is unknown; call ${tool("wallet_wait")} again in a few seconds before acting on it`;

export const FILL_UNKNOWN = `this intent's history could not be read in full, so what its fills delivered is unknown: it is longer than the ${HISTORY_PAGES} pages read or the RPC node's ledger does not reach back to its creation; ${tool("wallet_balance")} shows what the wallet holds now`;

export const stillWaiting = (status: string) =>
  `still ${status}; call ${tool("wallet_wait")} again to keep waiting, or ${tool("wallet_cancel")} to take the escrow back`;

export const walletWait = define({
  name: tool("wallet_wait"),
  title: "Wait for a wallet intent",
  description: `Wait until an intent of this server's wallet is filled, cancelled or expired, or until within seconds pass, then say which and, for a fill, how much it delivered to this wallet or to the pay_to it named, or for a released escrow, how much it paid out. Use it after sending instead of asking the user to check again; call it again while the status is still open.`,
  effect: "read",
  input: object({
    nonce: amount("the intent's nonce, from the send or wallet_intents"),
    within: optional(integer(1, WAIT_MAX, `most seconds to wait; default ${WAIT_DEFAULT}`)),
  }),
  output: object({
    intent: account(),
    status: choice(WAIT_STATUS, "closed means the account is gone and its recent transactions name no fill, cancel or expiry"),
    waited: integer(0, WAIT_MAX, "seconds waited"),
    received: optional(text("whole tokens the fills of a swap delivered, to this wallet or the pay_to it named")),
    paid_out: optional(text("whole tokens the release of this wallet's escrow paid to its payee or split recipients, out of what the escrow held")),
    token: optional(text("the token received or paid out")),
    signature: optional(text("the fill's or release's transaction")),
    next: optional(text()),
  }),
  run: async (ctx: AgentContext, input) => {
    const wallet = access(ctx);
    const owner = (await signerOf(ctx)).address;
    const [intent] = await findIntentPda({ owner, nonce: input.nonce });
    const within = input.within ?? WAIT_DEFAULT;
    const fresh = unmemoized(ctx.transport);
    const deadline = wallet.now() + BigInt(within);
    let waited = 0;
    let pair: Pair | null = null;
    let status: WaitStatus = "closed";
    for (;;) {
      const view = await fresh.getAccount(intent);
      if (view === null) {
        status = "closed";
        break;
      }
      const decoded = getIntentDecoder().decode(view.data);
      pair = { inputMint: decoded.inputMint, outputMint: decoded.outputMint };
      status = STATUS[decoded.status] ?? "open";
      if ((status !== "open" && status !== "filling") || waited >= within || wallet.now() >= deadline || !(await wallet.sleep(1))) {
        break;
      }
      waited += 1;
    }
    if (status === "open" || status === "filling") {
      return { intent, status, waited, next: stillWaiting(status) };
    }
    if (status === "cancelled" || status === "expired") {
      return { intent, status, waited };
    }
    const { release, transactions, complete, bound } = await releaseLookup(ctx.transport, intent);
    const history = historyIn(transactions);
    if (release !== null && !bound) {
      return { intent, status, waited, next: FILL_UNKNOWN };
    }
    if (release !== null) {
      const fields = release.event.fields as Record<string, unknown>;
      const mint = pair?.inputMint ?? createdMint(transactions, intent) ?? releasedMint(release.tx, intent, fields["payee"] as Address | undefined);
      const decimals = mint === undefined ? undefined : (await mintOf(ctx.transport, mint)).decimals;
      return {
        intent,
        status: "filled",
        waited,
        paid_out: formatAmount(fields["net"] as bigint, decimals),
        ...(mint === undefined ? {} : { token: nameOf(mint) }),
        signature: release.tx.signature,
      };
    }
    const fills = history.fills.filter((f) => f.intent === intent);
    if (fills.length === 0) {
      const ended = status === "closed" ? (history.ended.get(intent) ?? status) : status;
      const unknown = ended === "closed" || ended === "filled";
      return { intent, status: ended, waited, ...(unknown && history.unread > 0 ? { next: UNREAD } : unknown && !complete ? { next: FILL_UNKNOWN } : {}) };
    }
    pair ??= history.created.get(intent) ?? null;
    const decimals = pair === null ? undefined : (await mintOf(ctx.transport, pair.outputMint)).decimals;
    return {
      intent,
      status: "filled",
      waited,
      received: formatAmount(fills.reduce((sum, f) => sum + f.delivered, 0n), decimals),
      ...(pair === null ? {} : { token: nameOf(pair.outputMint) }),
      signature: fills[0]?.signature,
    };
  },
});
