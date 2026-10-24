import type { Address } from "@solana/kit";
import { FirstOpeningRefused } from "./announce-errors.js";
import { type DeliveryOpeners, firstOpening } from "./first-opening.js";
import type { Transport } from "./transport.js";

export type ConfirmTarget = {
  intent: Address;
  attestor?: Address | undefined;
  sha256?: string | undefined;
  pages?: number | undefined;
  payees?: readonly Address[] | undefined;
  accounts?: readonly Address[] | undefined;
  keypair?: DeliveryOpeners | undefined;
};

export type NodeView = { genesis: string; intent: string; announcer: string | undefined; accounts?: string[] };

export type ConfirmField = "genesis hash" | "intent account" | "account" | "earliest announcer" | "payee" | "second node" | "profile history";

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
  if (target.sha256 === undefined || target.attestor === undefined) {
    return undefined;
  }
  try {
    const first = await firstOpening(transport, { intent: target.intent, sha256: target.sha256, keypair: target.keypair });
    return `${first.worker} in ${first.announcement}`;
  } catch (error) {
    if (error instanceof FirstOpeningRefused && error.reason === "nothing-opens") {
      return NO_ANNOUNCER;
    }
    if (error instanceof FirstOpeningRefused && error.reason === "incomplete") {
      return INCOMPLETE_RECORD;
    }
    throw error;
  }
}

const viewOf = async (account: { data: Uint8Array } | null): Promise<string> => (account === null ? NO_ACCOUNT : `sha256 ${await digestOf(account.data)}`);

export async function nodeView(transport: Transport, target: ConfirmTarget): Promise<NodeView> {
  const [genesis, account, announcer, accounts] = await Promise.all([
    transport.genesisHash(),
    transport.getAccount(target.intent),
    announcerOf(transport, target),
    target.accounts === undefined ? undefined : transport.getAccounts(target.accounts),
  ]);
  const intent = await viewOf(account);
  return accounts === undefined
    ? { genesis, intent, announcer }
    : { genesis, intent, announcer, accounts: await Promise.all(accounts.map((view) => viewOf(view ?? null))) };
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
  for (const [i, address] of (target.accounts ?? []).entries()) {
    const [mine, theirs] = [own.accounts?.[i], other.accounts?.[i]];
    if (mine !== theirs) {
      throw new ConfirmMismatch("account", `${address} ${mine ?? NO_ACCOUNT}`, `${address} ${theirs ?? NO_ACCOUNT}`);
    }
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
