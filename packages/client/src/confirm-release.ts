import type { Address } from "@solana/kit";
import { FirstOpeningRefused } from "./announce-errors.js";
import { type AnnouncementView, loadDeliveryBook } from "./announcement-reads.js";
import { type DeliveryOpeners, firstOpeningIn } from "./first-opening.js";
import type { Transport } from "./transport.js";

export type ConfirmTarget = {
  intent: Address;
  attestor?: Address | undefined;
  sha256?: string | undefined;
  payees?: readonly Address[] | undefined;
  accounts?: readonly Address[] | undefined;
  keypair?: DeliveryOpeners | undefined;
};

export type NodeView = { genesis: string; intent: string; book?: string; announcements?: string[]; announcer: string | undefined; accounts?: string[] };

export type ConfirmField = "genesis hash" | "intent account" | "account" | "delivery book" | "announcements" | "earliest announcer" | "payee" | "second node";

export const NO_ACCOUNT = "no account";

export const REFUSED = "refused";

export class ConfirmMismatch extends Error {
  readonly field: ConfirmField;
  readonly first: string;
  readonly second: string;

  constructor(field: ConfirmField, first: string, second: string) {
    super(
      field === "second node"
        ? `the second RPC node could not be read (${second}), so the release is not confirmed; nothing was signed or sent`
        : field === "payee" && second.startsWith(REFUSED)
          ? `both RPC nodes name no first opening (${second}), so the payee ${first} is not confirmed; nothing was signed or sent`
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

function refusalView(refusal: FirstOpeningRefused): string {
  const parts = [
    `${REFUSED} ${refusal.reason}`,
    ...(refusal.announcement === null ? [] : [`at ${refusal.announcement} seq ${refusal.seq ?? "?"} by ${refusal.worker ?? "?"}`]),
    ...(refusal.missing.length === 0 ? [] : [`missing ${refusal.missing.join(",")}`]),
    ...(refusal.closed ? ["closed"] : []),
    ...(refusal.holder === null ? [] : [`held by ${refusal.holder}`]),
    ...refusal.sealedTo.map(({ wallet, kind, fingerprint }) => `sealed to ${wallet} ${kind} ${fingerprint}`),
  ];
  return parts.join(" ");
}

const announcementView = (a: AnnouncementView): string =>
  [a.address, a.seq, a.worker, a.state, hex(a.commitment), hex(a.delivered), hex(a.splitHash), a.paidAt, hex(a.blob)].join(" ");

type Delivery = { book: string; announcements: string[]; announcer: string };

async function deliveryOf(transport: Transport, target: ConfirmTarget): Promise<Delivery | undefined> {
  if (target.sha256 === undefined || target.attestor === undefined) {
    return undefined;
  }
  const [{ list, opening }, book] = await Promise.all([
    firstOpeningIn(transport, { intent: target.intent, sha256: target.sha256, keypair: target.keypair }),
    loadDeliveryBook(transport, target.intent),
  ]);
  const seq = opening.seq;
  const shown = seq === null ? list.announcements : list.announcements.filter((a) => a.seq <= seq);
  return {
    book: book === null ? NO_ACCOUNT : `next seq ${book.nextSeq} live ${book.live}`,
    announcements: shown.map(announcementView),
    announcer: opening instanceof FirstOpeningRefused ? refusalView(opening) : `${opening.worker} in ${opening.announcement}`,
  };
}

const viewOf = async (account: { data: Uint8Array } | null): Promise<string> => (account === null ? NO_ACCOUNT : `sha256 ${await digestOf(account.data)}`);

export async function nodeView(transport: Transport, target: ConfirmTarget): Promise<NodeView> {
  const [genesis, account, delivered, accounts] = await Promise.all([
    transport.genesisHash(),
    transport.getAccount(target.intent),
    deliveryOf(transport, target),
    target.accounts === undefined ? undefined : transport.getAccounts(target.accounts),
  ]);
  const intent = await viewOf(account);
  return {
    genesis,
    intent,
    ...(delivered === undefined ? { announcer: undefined } : delivered),
    ...(accounts === undefined ? {} : { accounts: await Promise.all(accounts.map((view) => viewOf(view ?? null))) }),
  };
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function compareAnnouncements(own: NodeView, other: NodeView): void {
  const mine = own.announcements ?? [];
  const theirs = other.announcements ?? [];
  for (let i = 0; i < Math.max(mine.length, theirs.length); i++) {
    if (mine[i] !== theirs[i]) {
      throw new ConfirmMismatch("announcements", mine[i] ?? NO_ACCOUNT, theirs[i] ?? NO_ACCOUNT);
    }
  }
}

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
  if (own.book !== other.book) {
    throw new ConfirmMismatch("delivery book", own.book ?? NO_ACCOUNT, other.book ?? NO_ACCOUNT);
  }
  compareAnnouncements(own, other);
  if (own.announcer !== other.announcer) {
    throw new ConfirmMismatch("earliest announcer", own.announcer ?? REFUSED, other.announcer ?? REFUSED);
  }
  const worker = own.announcer?.startsWith(REFUSED) === true ? undefined : own.announcer?.split(" ")[0];
  if (target.payees !== undefined && own.announcer !== undefined && !target.payees.some((payee) => payee === worker)) {
    throw new ConfirmMismatch("payee", target.payees.join(", "), own.announcer);
  }
  return own;
}
