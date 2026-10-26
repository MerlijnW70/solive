import type { Address } from "@solana/kit";
import { type EngineEvent, findAssociatedTokenAddress, InvalidInput, tokenName } from "@intent-engine/core";
import { decodeEvent } from "@intent-engine/core/internal";
import { createdAccount, tokenAmountOf } from "./accounts.js";
import { TransportLacks } from "./client-errors.js";
import {
  type Balances,
  type ClientContext,
  type Fill,
  HISTORY_LIMIT,
  HISTORY_LIMIT_MAX,
  type HistoryEvent,
  type HistoryOptions,
  type HistoryPage,
  type TokenBalance,
} from "./client-types.js";
import { intentAddress, type IntentRef } from "./intent-ref.js";
import { createdAtOf, scan } from "./jobs.js";
import { releasedDelivery } from "./release-reads.js";
import type { EngineTransaction, Transport } from "./transport.js";

const FILL_EVENTS: ReadonlySet<string> = new Set(["IntentFilled", "FillEnded"]);

function eventsIn(transactions: readonly EngineTransaction[], intent: Address): HistoryEvent[] {
  return transactions
    .filter(({ failed }) => !failed)
    .flatMap(({ signature, slot, blockTime, emitted }) =>
      emitted
        .map((data) => decodeEvent(data) as EngineEvent | null)
        .filter((event): event is EngineEvent => event !== null && "intent" in event.fields && event.fields.intent === intent)
        .reverse()
        .map((event) => ({ ...event, signature, slot, blockTime })),
    );
}

const fillIn = (intent: Address) => (transaction: EngineTransaction): boolean =>
  eventsIn([transaction], intent).some(({ name }) => FILL_EVENTS.has(name));

export const HISTORY_LIMIT_RANGE = `limit must be a whole number from 1 to ${HISTORY_LIMIT_MAX}`;

async function historyPage(transport: Transport, intent: Address, options: HistoryOptions): Promise<{ transactions: EngineTransaction[]; next: string | null }> {
  const limit = options.limit ?? HISTORY_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > HISTORY_LIMIT_MAX) {
    throw new InvalidInput("limit", "range", HISTORY_LIMIT_RANGE);
  }
  const cursor = (count: number, last: string | undefined) => (count < limit ? null : (last ?? null));
  if (transport.signaturesOf === undefined || transport.transactionsOf === undefined) {
    if (options.before !== undefined) {
      throw new TransportLacks(transport.signaturesOf === undefined ? "signaturesOf" : "transactionsOf");
    }
    const transactions = await transport.engineTransactions(limit, intent);
    return { transactions, next: cursor(transactions.length, transactions.at(-1)?.signature) };
  }
  const listed = await transport.signaturesOf(intent, limit, options.before);
  return { transactions: await transport.transactionsOf(listed), next: cursor(listed.length, listed.at(-1)?.signature) };
}

export function clientReads({ transport, mint }: ClientContext) {
  const history = async (ref: IntentRef, options: HistoryOptions = {}): Promise<HistoryPage> => {
    const intent = await intentAddress(ref);
    const { transactions, next } = await historyPage(transport, intent, options);
    const events = eventsIn(transactions, intent).map((event) => {
      if (event.name !== "IntentAttested" && event.name !== "IntentSplit") {
        return event;
      }
      const release = transactions.find(({ signature }) => signature === event.signature);
      const released = release === undefined ? null : releasedDelivery(release, intent);
      return released === null ? event : { ...event, deliveredSha256: released.sha256, deliveredSalt: released.salt };
    });
    return { events, next };
  };

  const fillOf = async (ref: IntentRef): Promise<Fill | null> => {
    const intent = await intentAddress(ref);
    const floor = await createdAtOf(transport, intent);
    const events = eventsIn((await scan(transport, intent, { floor, until: fillIn(intent) })).transactions, intent);
    for (const event of events) {
      const { signature, slot, blockTime } = event;
      if (event.name === "IntentFilled") {
        const { solver, delivered, required, fee, net } = event.fields;
        return { steps: 1, solver, delivered, required, fee, net, signature, slot, blockTime };
      }
      if (event.name === "FillEnded") {
        const begun = events.find((other) => other.name === "FillBegun" && other.signature === signature);
        if (begun?.name === "FillBegun") {
          const { solver, delivered, required } = event.fields;
          return { steps: 2, solver, delivered, required, fee: begun.fields.fee, net: begun.fields.net, signature, slot, blockTime };
        }
      }
    }
    return null;
  };

  const balances = async (owner: Address, mints: readonly Address[]): Promise<Balances> => {
    const [wallet, tokens] = await Promise.all([
      transport.getAccount(owner),
      Promise.all(
        mints.map(async (address): Promise<TokenBalance> => {
          const { decimals, tokenProgram } = await mint(address);
          const account = await findAssociatedTokenAddress({ owner, mint: address, tokenProgram });
          const amount = tokenAmountOf((await createdAccount(transport, account))?.data ?? null) ?? 0n;
          return { mint: address, name: tokenName(address), account, amount, decimals };
        }),
      ),
    ]);
    return { sol: wallet?.lamports ?? 0n, tokens };
  };

  return { history, fillOf, balances };
}
