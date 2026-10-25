import type { Address } from "@solana/kit";
import { AccountVersionError, SdkError } from "@intent-engine/core";
import { decodeEvent, parseEncryptionKey, profileAddress } from "@intent-engine/core/internal";
import { loadProfile } from "./client-claims.js";
import { loadCommittee } from "./client-committee.js";
import { creationSlotOf, openProofEscrows } from "./job-proofs.js";
import { scan } from "./job-scan.js";
import type { EngineTransaction, Transport } from "./transport.js";

type KeyEvent = { slot: bigint; key: Uint8Array | null };

type History = { events: KeyEvent[]; before: Uint8Array | null };

export class ProfileHistoryIncomplete extends SdkError {
  readonly code = "profile-history-incomplete";
  override readonly name = "ProfileHistoryIncomplete";
  readonly judge: Address;

  constructor(judge: Address) {
    super(
      `the history of ${judge}'s profile could not be read back far enough to know which encryption key it named when the escrow was made; nothing was paid. Use an RPC node that keeps the full ledger`,
    );
    this.judge = judge;
  }
}

export const WARN_NO_JUDGE_KEY = "this judge cannot use a Ledger for announced work";

export const noJudgeKey = (wallet: Address): string =>
  `${WARN_NO_JUDGE_KEY}: the profile of ${wallet} publishes no encryption key. It matters only if ${wallet} judges on a Ledger, which cannot open work sealed to its wallet and so refuses this escrow; to judge on a Ledger, that wallet makes a key with intent-engine profile encryption-key new and publishes it with profile set --encryption-key before this escrow is sent. A judge with a key file can ignore this`;

export const noKeyAtCreation = (judge: Address, intent: Address): string =>
  `${judge} signs on a Ledger, which cannot open work sealed to the key derived from its wallet, and its profile named no encryption key when escrow ${intent} was made, so work sealed to that key could stall it; the escrow is refused. A hirer should name a judge whose profile publishes an encryption key before the escrow is made; nothing was run or paid`;

export class NoKeyAtCreation extends SdkError {
  readonly code = "no-key-at-creation";
  override readonly name = "NoKeyAtCreation";
  readonly intent: Address;

  constructor(judge: Address, intent: Address) {
    super(noKeyAtCreation(judge, intent));
    this.intent = intent;
  }
}

export const keepsKey = (wallet: Address, escrows: readonly Address[]): string =>
  `${wallet} signs on a Ledger and judges the open escrows ${escrows.join(", ")}; without an encryption key it could not open their announcements, so it keeps one: rotate with a new --encryption-key instead, or wait until they close; nothing was sent`;

function keyEvents(transaction: EngineTransaction, wallet: Address): KeyEvent[] {
  if (transaction.failed) {
    return [];
  }
  return transaction.emitted.flatMap((data): KeyEvent[] => {
    const event = decodeEvent(data);
    const fields = event?.fields as { wallet?: Address; encryptionKey?: ArrayLike<number> } | undefined;
    if (fields?.wallet !== wallet) {
      return [];
    }
    if (event?.name === "ProfileClosed") {
      return [{ slot: transaction.slot, key: null }];
    }
    const key = event?.name === "ProfileSet" && fields.encryptionKey !== undefined ? Uint8Array.from(fields.encryptionKey) : null;
    return event?.name === "ProfileSet" ? [{ slot: transaction.slot, key: key?.some((b) => b !== 0) === true ? key : null }] : [];
  });
}

async function historyOf(transport: Transport, wallet: Address, bound: bigint): Promise<History> {
  let seen = false;
  const read = await scan(transport, await profileAddress(wallet), {
    until: (transaction) => {
      const events = keyEvents(transaction, wallet);
      seen ||= events.length > 0;
      return events.some(({ slot }) => slot <= bound);
    },
    covered: async () => {
      const first = await transport.firstAvailableSlot?.call(transport);
      return first !== undefined && (seen ? first === 0n : first <= bound);
    },
  });
  if (!read.complete) {
    throw new ProfileHistoryIncomplete(wallet);
  }
  const events = read.transactions.flatMap((transaction) => keyEvents(transaction, wallet)).sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
  if (events.length > 0) {
    return { events, before: null };
  }
  return { events, before: await currentKey(transport, wallet) };
}

async function currentKey(transport: Transport, wallet: Address): Promise<Uint8Array | null> {
  const profile = await loadProfile(transport, wallet).catch((error: unknown) => {
    if (error instanceof AccountVersionError) {
      return null;
    }
    throw error;
  });
  const key = profile?.encryptionKey ?? null;
  return key === null ? null : parseEncryptionKey(key);
}

const keyAt = (history: History, slot: bigint): Uint8Array | null => {
  const latest = history.events.filter((event) => event.slot <= slot).at(-1);
  return latest === undefined ? history.before : latest.key;
};

export async function deviceJudgeReady(transport: Transport, judge: Address, intent: Address): Promise<void> {
  const slot = await creationSlotOf(transport, intent);
  if (slot === null) {
    throw new ProfileHistoryIncomplete(judge);
  }
  if (keyAt(await historyOf(transport, judge, slot), slot) === null) {
    throw new NoKeyAtCreation(judge, intent);
  }
}

export async function escrowsJudgedBy(transport: Transport, wallet: Address): Promise<Address[]> {
  const open = await openProofEscrows(transport, undefined, Number.POSITIVE_INFINITY);
  const committees = new Map<Address, readonly Address[]>();
  const judged: Address[] = [];
  for (const { address, params } of open) {
    if (params.attestor === wallet) {
      judged.push(address);
      continue;
    }
    let members = committees.get(params.attestor);
    if (members === undefined) {
      members = (await loadCommittee(transport, params.attestor))?.members ?? [];
      committees.set(params.attestor, members);
    }
    if (members.includes(wallet)) {
      judged.push(address);
    }
  }
  return judged;
}

export async function keylessJudges(transport: Transport, attestor: Address): Promise<Address[]> {
  const members = (await loadCommittee(transport, attestor))?.members ?? [attestor];
  const keys = await Promise.all(members.map(async (member) => (await currentKey(transport, member).catch(() => null)) !== null));
  return members.filter((_, at) => keys[at] !== true);
}
