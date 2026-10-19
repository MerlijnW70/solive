import type { Address, Signature } from "@solana/kit";
import { decodeEvent, type EngineEvent, findAssociatedTokenAddress, tokenName } from "@intent-engine/core";
import { createdAccount, tokenAmountOf } from "./accounts.js";
import { type Balances, type ClientContext, type Fill, HISTORY_LIMIT, type HistoryEvent, type TokenBalance } from "./client-types.js";
import { createdAtOf, recordedRelease, scan } from "./jobs.js";
import type { EngineTransaction } from "./transport.js";

const FILL_EVENTS: ReadonlySet<string> = new Set(["IntentFilled", "FillEnded"]);

function eventsIn(transactions: readonly EngineTransaction[], intent: Address): HistoryEvent[] {
  return transactions
    .filter(({ failed }) => !failed)
    .flatMap(({ signature, slot, blockTime, emitted }) =>
      emitted
        .map((data) => decodeEvent(data) as EngineEvent | null)
        .filter((event): event is EngineEvent => event !== null && "intent" in event.fields && event.fields.intent === intent)
        .reverse()
        .map((event) => ({ ...event, signature: signature as Signature, slot, blockTime })),
    );
}

const fillIn = (intent: Address) => (transaction: EngineTransaction): boolean =>
  eventsIn([transaction], intent).some(({ name }) => FILL_EVENTS.has(name));

export function clientReads({ transport, mint }: ClientContext) {
  const history = async (intent: Address, limit = HISTORY_LIMIT): Promise<HistoryEvent[]> => {
    const transactions = await transport.engineTransactions(limit, intent);
    return eventsIn(transactions, intent).map((event) => {
      if (event.name !== "IntentAttested" && event.name !== "IntentSplit") {
        return event;
      }
      const release = transactions.find(({ signature }) => signature === event.signature);
      const recorded = release === undefined ? null : recordedRelease(transactions, release, event.fields.attestor);
      return recorded === null ? event : { ...event, deliveredSha256: recorded.sha256, ...(recorded.salt === undefined ? {} : { deliveredSalt: recorded.salt }) };
    });
  };

  const fillOf = async (intent: Address): Promise<Fill | null> => {
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
