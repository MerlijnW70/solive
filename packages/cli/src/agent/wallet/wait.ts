import type { Address } from "@solana/kit";
import { findIntentPda, formatAmount, getIntentDecoder } from "@intent-engine/core";
import { mintOf, rateLimited, unmemoized } from "@intent-engine/client";
import { type AgentContext, define } from "../actions.js";
import { tool } from "../names.js";
import { account, amount, choice, integer, object, optional, text } from "../schema.js";
import { STATUS } from "../../accounts.js";
import { WAIT_DEFAULT, WAIT_MAX, type Clock, access, signerOf, nameOf } from "./guard.js";
import { type Pair, historyIn } from "./fills.js";
import { HISTORY_PAGES, releaseLookup, releasedMint, createdMint } from "./releases.js";

export const WAIT_STATUS = ["open", "filling", "filled", "cancelled", "expired", "closed"] as const;

type WaitStatus = (typeof WAIT_STATUS)[number];

export const UNREAD = `the node could not yet return all of this intent's transactions, so whether it filled is unknown; call ${tool("wallet_wait")} again in a few seconds before acting on it`;

export const FILL_UNKNOWN = `this intent's history could not be read in full, so what its fills delivered is unknown: it is longer than the ${HISTORY_PAGES} pages read or the RPC node's ledger does not reach back to its creation; ${tool("wallet_balance")} shows what the wallet holds now`;

export const stillWaiting = (status: string) =>
  `still ${status}; call ${tool("wallet_wait")} again to keep waiting, or ${tool("wallet_cancel")} to take the escrow back`;

export const NO_CLOCK = "this server has no clock to wait with; call again without wait";

export async function poll(clock: Clock, within: number, done: () => Promise<boolean>): Promise<number> {
  const deadline = clock.now() + BigInt(within);
  const reads = { answered: false, limited: [] as unknown[] };
  const attempt = async (): Promise<boolean> => {
    try {
      const finished = await done();
      reads.answered = true;
      return finished;
    } catch (error) {
      if (!rateLimited(error)) {
        throw error;
      }
      reads.limited.push(error);
      return false;
    }
  };
  let waited = 0;
  while (!(await attempt()) && waited < within && clock.now() < deadline && (await clock.sleep(1))) {
    waited += 1;
  }
  const [limited] = reads.limited.slice(-1);
  if (!reads.answered && limited !== undefined) {
    throw limited;
  }
  return waited;
}

export const walletWait = define({
  name: tool("wallet_wait"),
  title: "Wait for a wallet intent",
  description: `Waits for one of the user's orders to finish, so they need not check again: says whether it filled, was cancelled or expired within the given seconds, and how much a fill delivered or a released escrow paid out. Use it after sending; call it again while the status is still open.`,
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
    let pair = null as Pair | null;
    let status = "closed" as WaitStatus;
    const waited = await poll(wallet, within, async () => {
      const view = await fresh.getAccount(intent);
      if (view === null) {
        status = "closed";
        return true;
      }
      const decoded = getIntentDecoder().decode(view.data);
      pair = { inputMint: decoded.inputMint, outputMint: decoded.outputMint };
      status = STATUS[decoded.status] ?? "open";
      return status !== "open" && status !== "filling";
    });
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
