import type { Address } from "@solana/kit";
import {
  AccountVersionError,
  decodeEvent,
  deliveryKeyOf,
  encryptionKeyText,
  keyFingerprint,
  parseEncryptionKey,
  profileAddress,
  sealedFingerprints,
  x25519PublicOf,
} from "@intent-engine/core";
import { loadProfile } from "./client-claims.js";
import { loadCommittee } from "./client-committee.js";
import { creationSlotOf, openProofEscrows } from "./job-proofs.js";
import { ConfirmMismatch } from "./confirm-release.js";
import { type Delivery, type DeliveryOpeners, earlier, openersOf } from "./job-deliveries.js";
import { scan } from "./job-scan.js";
import type { EngineTransaction, Transport } from "./transport.js";

export type KeyKind = "wallet" | "profile";

export type ResponsibleKey = { key: string; fingerprint: string; kind: KeyKind; held: boolean };

export type MissingKey = { delivery: Delivery; key: ResponsibleKey };

export type Skipped = { delivery: Delivery; reason: string };

export type Unopened = { missing: MissingKey | null; skipped: Skipped[] };

export type UnopenedInput = {
  judge: Address;
  recipients: readonly Address[];
  deliveries: readonly Delivery[];
  first: Delivery | null;
  openers: DeliveryOpeners | undefined;
  confirm?: Transport | undefined;
};

type KeyEvent = { slot: bigint; key: Uint8Array | null };

type History = { events: KeyEvent[]; before: Uint8Array | null };

export class ProfileHistoryIncomplete extends Error {
  readonly judge: Address;

  constructor(judge: Address) {
    super(
      `the history of ${judge}'s profile could not be read back far enough to know which encryption key it named when the escrow was made or the work was announced, so which key an honest worker sealed to is unknown; nothing was paid. Use an RPC node that keeps the full ledger`,
    );
    this.name = "ProfileHistoryIncomplete";
    this.judge = judge;
  }
}

export const NOT_VERSION_3 = "its sealed url is not a version-3 sealed delivery";
export const OTHER_RECIPIENTS = "it is not sealed to this escrow's recipients";
export const NOT_PUBLISHED_KEY = "its key for this judge is not the key the judge's profile named when it landed";
export const DOES_NOT_OPEN = "it is sealed to this judge's key but does not open with it";

const ordered = (a: Delivery, b: Delivery): number => (earlier(a, b) ? -1 : earlier(b, a) ? 1 : 0);

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export const unopenedBefore = (deliveries: readonly Delivery[], first: Delivery | null): Delivery[] =>
  deliveries.filter((delivery) => delivery.url === "" && (first === null || (delivery.intent === first.intent && earlier(delivery, first)))).sort(ordered);

export const GIVE_KEY_FILE = "give the encryption key file of that key";

export const missingKey = ({ delivery, key }: MissingKey, give: string = GIVE_KEY_FILE): string =>
  `the announcement ${delivery.signature} by ${delivery.worker} for intent ${delivery.intent} came before the work being paid and is sealed to ${
    key.kind === "wallet" ? `the key derived from the judge's wallet, ${key.key}` : `the encryption key ${key.key} the judge's profile named when it landed`
  }, which none of the keys given opens; ${key.kind === "wallet" ? "give the wallet's key file" : give}; nothing was paid`;

export const WARN_NO_JUDGE_KEY = "this judge cannot use a Ledger for announced work";

export const noKeyAtCreation = (judge: Address, intent: Address): string =>
  `${judge} signs on a Ledger, which cannot open work sealed to the key derived from its wallet, and its profile named no encryption key when escrow ${intent} was made, so work sealed to that key could stall it; the escrow is refused. A hirer should name a judge whose profile publishes an encryption key before the escrow is made; nothing was run or paid`;

export class NoKeyAtCreation extends Error {
  readonly intent: Address;

  constructor(judge: Address, intent: Address) {
    super(noKeyAtCreation(judge, intent));
    this.name = "NoKeyAtCreation";
    this.intent = intent;
  }
}

export const keepsKey = (wallet: Address, escrows: readonly Address[]): string =>
  `${wallet} signs on a Ledger and judges the open escrows ${escrows.join(", ")}; without an encryption key it could not open their announcements, so it keeps one: rotate with a new --encryption-key instead, or wait until they close; nothing was sent`;

export const skippedNote = ({ delivery, reason }: Skipped): string => `skipped the announcement ${delivery.signature} by ${delivery.worker}: ${reason}`;

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

const historyText = (history: History): string =>
  [...history.events.map(({ slot, key }) => `${slot}:${key === null ? "none" : hex(key)}`), `before:${history.before === null ? "none" : hex(history.before)}`].join(",");

async function responsible(key: Uint8Array, kind: KeyKind, held: readonly string[]): Promise<ResponsibleKey> {
  const fingerprint = await keyFingerprint(key);
  return { key: encryptionKeyText(key), fingerprint, kind, held: held.includes(fingerprint) };
}

export async function unopenedOf(transport: Transport, input: UnopenedInput): Promise<Unopened> {
  const hidden = unopenedBefore(input.deliveries, input.first);
  const [earliest] = hidden;
  if (earliest === undefined) {
    return { missing: null, skipped: [] };
  }
  const history = await historyOf(transport, input.judge, earliest.slot);
  if (input.confirm !== undefined) {
    const second = await historyOf(input.confirm, input.judge, earliest.slot);
    if (historyText(second) !== historyText(history)) {
      throw new ConfirmMismatch("profile history", historyText(history), historyText(second));
    }
  }
  const held = await Promise.all(openersOf(input.openers).map(async (opener) => keyFingerprint((await deliveryKeyOf(opener)).publicKey)));
  const slot = input.recipients.indexOf(input.judge);
  const skipped: Skipped[] = [];
  for (const delivery of hidden) {
    const sealedTo = sealedFingerprints(delivery.sealed);
    if (sealedTo === null) {
      skipped.push({ delivery, reason: NOT_VERSION_3 });
      continue;
    }
    if (slot < 0 || sealedTo.length !== input.recipients.length) {
      skipped.push({ delivery, reason: OTHER_RECIPIENTS });
      continue;
    }
    const published = keyAt(history, delivery.slot);
    const key = await responsible(published ?? x25519PublicOf(input.judge), published === null ? "wallet" : "profile", held);
    if (sealedTo[slot] !== key.fingerprint) {
      skipped.push({ delivery, reason: NOT_PUBLISHED_KEY });
      continue;
    }
    if (key.held) {
      skipped.push({ delivery, reason: DOES_NOT_OPEN });
      continue;
    }
    return { missing: { delivery, key }, skipped: [] };
  }
  return { missing: null, skipped };
}

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
