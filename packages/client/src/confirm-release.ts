import type { Address } from "@solana/kit";
import { deliveryRecord, firstDelivery } from "./job-deliveries.js";
import type { Transport } from "./transport.js";

export type ConfirmTarget = { intent: Address; attestor: Address; sha256?: string | undefined; pages?: number | undefined; payees?: readonly Address[] | undefined };

export type NodeView = { genesis: string; intent: string; announcer: string | undefined };

export type ConfirmField = "genesis hash" | "intent account" | "earliest announcer" | "payee" | "second node";

export const NO_ACCOUNT = "no account";

export const NO_ANNOUNCER = "nobody";

export const INCOMPLETE_RECORD = "an incomplete delivery record";

export class ConfirmMismatch extends Error {
  readonly field: ConfirmField;
  readonly first: string;
  readonly second: string;

  constructor(field: ConfirmField, first: string, second: string) {
    super(
      field === "second node"
        ? `the second RPC node could not be read (${second}), so the release is not confirmed; nothing was signed or sent`
        : field === "payee"
          ? `both RPC nodes report the earliest announcer ${second}, which is not the payee ${first}; nothing was signed or sent`
          : `the two RPC nodes report a different ${field}: the first ${first}, the second ${second}; nothing was signed or sent`,
    );
    this.name = "ConfirmMismatch";
    this.field = field;
    this.first = first;
    this.second = second;
  }
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const digestOf = async (bytes: Uint8Array): Promise<string> => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice())));

async function announcerOf(transport: Transport, target: ConfirmTarget): Promise<string | undefined> {
  if (target.sha256 === undefined) {
    return undefined;
  }
  const record = await deliveryRecord(transport, target.attestor, target.intent, target.pages);
  if (!record.complete) {
    return INCOMPLETE_RECORD;
  }
  const first = firstDelivery(record.deliveries, target.sha256);
  return first === null ? NO_ANNOUNCER : `${first.worker} in ${first.signature}`;
}

export async function nodeView(transport: Transport, target: ConfirmTarget): Promise<NodeView> {
  const [genesis, account, announcer] = await Promise.all([transport.genesisHash(), transport.getAccount(target.intent), announcerOf(transport, target)]);
  return { genesis, intent: account === null ? NO_ACCOUNT : `sha256 ${await digestOf(account.data)}`, announcer };
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function confirmOnBoth(first: Transport, second: Transport, target: ConfirmTarget): Promise<NodeView> {
  const [own, other] = await Promise.all([
    nodeView(first, target),
    nodeView(second, target).catch((error: unknown) => {
      throw new ConfirmMismatch("second node", "read", `unreadable: ${reasonOf(error)}`);
    }),
  ]);
  if (own.genesis !== other.genesis) {
    throw new ConfirmMismatch("genesis hash", own.genesis, other.genesis);
  }
  if (own.intent !== other.intent) {
    throw new ConfirmMismatch("intent account", own.intent, other.intent);
  }
  if (own.announcer !== other.announcer || own.announcer === INCOMPLETE_RECORD) {
    throw new ConfirmMismatch("earliest announcer", own.announcer ?? NO_ANNOUNCER, other.announcer ?? NO_ANNOUNCER);
  }
  const worker = own.announcer?.split(" ")[0];
  if (target.payees !== undefined && own.announcer !== undefined && !target.payees.some((payee) => payee === worker)) {
    throw new ConfirmMismatch("payee", target.payees.join(", "), own.announcer);
  }
  return own;
}
