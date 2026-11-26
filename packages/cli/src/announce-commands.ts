import type { Address, TransactionPartialSigner } from "@solana/kit";
import { formatAmount } from "@intent-engine/core";
import { type AnnounceInput, type ReclaimBook, type RefuteInput, type Transport } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { type AnnouncementView, loadAnnouncement, loadDeliveryBook, mintOf, opensTo, protectionLines, secretInputOf } from "@intent-engine/client/internal";
import { previewed } from "./admin-commands.js";
import { claimOf, deliverClaimWarnings } from "./agent/job-claims.js";
import { ANNOUNCE_FIRST, capturing, hex, keptLines, listView, openedBy, sealedToText, walletOf } from "./announcement-views.js";
import { ArtifactTooLarge, artifactSha256 } from "./artifact.js";
import type { Command } from "./command-types.js";
import { ALREADY_ANNOUNCED, announceFeeKept, announceFeeOf, announceFeePaid, NOTHING_HELD } from "./delivery-shared.js";
import { FlowRefused } from "./flows.js";
import { deliverNotInvited, sealedInvites } from "./invites.js";
import { transactionSigner } from "./ledger-keys.js";
import type { Runtime } from "./runtime.js";
import { loadEncryptionKeys } from "./sealed-commands.js";
import { keptSecret, savedSecret, secretFor, secretsPath, signsMessages } from "./worker-secrets.js";
import { keepDelivery, type OwnDelivery, ownDeliveries } from "./delivery-record.js";
import { unfundedRefused } from "./wallet.js";

type AnnounceCommand = Extract<Command, { name: "deliver" | "deliveries" | "refute" | "reclaim" | "claim-held" | "close-book" }>;

export { ALREADY_ANNOUNCED, NOTHING_HELD } from "./delivery-shared.js";

export const NOTHING_TO_RECLAIM = "none of this wallet's announcements can close now: its Keeps lines say why each one stays; nothing was sent";

const SOL_DECIMALS = 9;

export const BOOKS_UNCLOSED = "the program refused to close the delivery books in unclosed, so they stay; the announcements and other books still closed, and close-book tries one again";

export function reclaimBooksLine(books: readonly Pick<ReclaimBook, "book" | "rent" | "rentTo">[], sends: number): string {
  const rent = formatAmount(
    books.reduce((sum, { rent }) => sum + rent, 0n),
    SOL_DECIMALS,
  );
  const payers = [...new Set(books.map(({ rentTo }) => rentTo))].join(", ");
  const named = books.map(({ book }) => book).join(", ");
  return `Closes: the delivery book${books.length === 1 ? "" : "s"} ${named} left empty here, in ${sends} more ${sends === 1 ? "transaction" : "transactions"}, so a refused one stops no other; ${rent} SOL of rent returns to ${payers}, which paid it`;
}

export const WORK_URL_NEEDED =
  "refute needs --work-url, the url the earlier announcement sealed: this wallet derives its delivery secrets from it, and no secrets file of this machine names it; nothing was sent";

export const noAnnouncement = (address: Address): string => `${address} is not an announcement of this program; nothing was sent`;

const payerOf = async (runtime: Runtime, command: { feePayer?: string | undefined }, signer: TransactionPartialSigner): Promise<TransactionPartialSigner> =>
  command.feePayer === undefined ? signer : runtime.loadSigner(command.feePayer);

async function deliver(command: Extract<AnnounceCommand, { name: "deliver" }>, runtime: Runtime, transport: Transport): Promise<object> {
  const worker = await transactionSigner(runtime, command.keypair);
  const payer = await payerOf(runtime, command, worker);
  const { intent, workUrl } = command;
  const sha256 = "sha256" in command ? command.sha256 : await artifactSha256(command.artifact);
  const kept = signsMessages(worker) ? undefined : await secretFor(runtime, worker.address, intent, sha256, workUrl);
  const client = createClient({ url: command.url, transport });
  const input: AnnounceInput = { payer, intent, sha256, url: workUrl, ...secretInputOf(worker, { secret: kept?.secret }) };
  const plan = await client.plan.announce(input);
  const invited = await sealedInvites(transport, runtime.specFetch, intent, { lookup: runtime.lookup, rpcUrl: command.url });
  const fee = await announceFeeOf(transport);
  const keptAt = kept === undefined ? undefined : secretsPath(runtime.home, worker.address, intent, sha256);
  const shown = {
    intent,
    attestor: plan.attestor,
    announcement: plan.announcement,
    commitment: plan.commitment,
    salt: plan.salt,
    sealed_to: plan.sealedTo.map(walletOf),
    protected: plan.protection.arms,
    ...(plan.protection.reviewUntil === null ? {} : { review_until: plan.protection.reviewUntil }),
    ...(keptAt === undefined ? {} : { secrets: keptAt }),
    summary: [
      `Announces: the work with sha256 ${sha256} to the proof escrow ${intent} in ${plan.announcement}, whose commitment ${plan.commitment} binds it to ${worker.address} and the salt ${plan.salt}`,
      `Seals: the salt and the url ${workUrl} to ${sealedToText(plan.sealedTo)}, so only they can open it`,
      `Pays: the announcement's rent and the fee${announceFeePaid(fee)}, from ${payer.address}; the rent returns to it when the announcement closes${announceFeeKept(fee)}`,
      ...(plan.setup.length === 0 ? [] : [`Syncs first, in its own transaction: the key snapshot of committee ${plan.attestor}, which its announcements are sealed to`]),
      ...(keptAt === undefined ? [] : [`Keeps: the delivery secrets in ${keptAt}, which refute reads; this wallet cannot sign messages, so they cannot be derived again`]),
      ...protectionLines(plan.protection, (lamports) => `${formatAmount(lamports, SOL_DECIMALS)} SOL`),
    ],
    warnings: [
      ...(invited === undefined || invited.includes(worker.address) ? [] : [deliverNotInvited(worker.address, intent)]),
      ...deliverClaimWarnings(await claimOf(transport, intent), worker.address),
      ANNOUNCE_FIRST,
    ],
  };
  if (plan.existing !== null) {
    const signature = await creationOf(transport, plan.announcement);
    const unkept = await keepDelivery(runtime, ownRecord(plan.intent, sha256, plan.announcement, plan.existing.seq, signature, plan.existing.slot, worker.address, await transport.genesisHash()));
    return {
      ...shown,
      sha256,
      seq: plan.existing.seq,
      state: plan.existing.state,
      sent: false,
      delivered: deliveredLine(plan.existing.seq, sha256, signature, plan.announcement),
      ...(unkept === undefined ? {} : { warnings: [...shown.warnings, unkept] }),
      next: ALREADY_ANNOUNCED,
    };
  }
  if (!command.yes) {
    return previewed(transport, plan.setup.length > 0 ? plan.setup : plan.instructions, payer, shown, false);
  }
  if (((await transport.getAccount(payer.address))?.lamports ?? 0n) === 0n) {
    throw new FlowRefused(unfundedRefused(payer.address, command.url));
  }
  const made = await client.announce(input);
  const landed = await loadAnnouncement(transport, made.announcement);
  const signature = made.signature ?? (await creationOf(transport, made.announcement));
  const unkept = await keepDelivery(runtime, ownRecord(plan.intent, sha256, made.announcement, made.seq, signature, landed?.slot ?? 0n, worker.address, await transport.genesisHash()));
  return {
    ...shown,
    sha256,
    seq: made.seq,
    sent: true,
    signature,
    ...(made.synced === null ? {} : { synced: made.synced }),
    delivered: deliveredLine(made.seq, sha256, signature, made.announcement),
    ...(unkept === undefined ? {} : { warnings: [...shown.warnings, unkept] }),
  };
}

export const deliveredLine = (seq: bigint, sha256: string, signature: string | null, announcement: Address): string =>
  `seq=${seq} sha256=${sha256} signature=${signature ?? "unknown"} announcement=${announcement}`;

const ownRecord = (intent: Address, sha256: string, announcement: Address, seq: bigint, signature: string | null, slot: bigint, worker: Address, cluster: string): OwnDelivery => ({
  intent,
  sha256,
  announcement,
  seq: seq.toString(),
  signature,
  slot: slot.toString(),
  worker,
  cluster,
});

export const CREATION_LOOKBACK = 20;

async function creationOf(transport: Transport, announcement: Address): Promise<string | null> {
  if (transport.signaturesOf === undefined) {
    return null;
  }
  const listed = await transport.signaturesOf(announcement, CREATION_LOOKBACK).catch(() => []);
  return listed.filter(({ failed }) => !failed).at(-1)?.signature ?? null;
}

async function refute(command: Extract<AnnounceCommand, { name: "refute" }>, runtime: Runtime, transport: Transport): Promise<object> {
  const worker = await transactionSigner(runtime, command.keypair);
  const payer = await payerOf(runtime, command, worker);
  const [earlier, paid] = await Promise.all([loadAnnouncement(transport, command.earlier), loadAnnouncement(transport, command.paid)]);
  if (earlier === null) {
    throw new FlowRefused(noAnnouncement(command.earlier));
  }
  if (paid === null) {
    throw new FlowRefused(noAnnouncement(command.paid));
  }
  const sha256 = hex(paid.delivered);
  const kept = signsMessages(worker) ? await savedSecret(runtime, worker.address, earlier.intent, sha256) : await keptSecret(runtime, worker.address, earlier.intent, sha256);
  const url = command.workUrl ?? kept?.url;
  if (url === undefined) {
    throw new FlowRefused(WORK_URL_NEEDED);
  }
  const input: RefuteInput = {
    payer,
    earlier: earlier.address,
    paid: paid.address,
    sha256,
    url,
    ...secretInputOf(worker, { secret: kept === null || signsMessages(worker) ? undefined : kept.secret }),
    ...(command.split === undefined ? {} : { claim: command.split }),
  };
  const shown = {
    earlier: earlier.address,
    paid: paid.address,
    intent: paid.intent,
    sha256,
    summary: [
      `Refutes: the release that paid ${paid.worker} for the work ${sha256} through ${paid.address} (seq ${paid.seq}), with the earlier announcement ${earlier.address} (seq ${earlier.seq}) by ${worker.address}`,
      `Reveals: the earlier announcement's salt and ephemeral key, so anyone can check that it opens to the url ${url} and commits to the same work`,
      `Pays: the refutation's rent and the fee, from ${payer.address}`,
    ],
  };
  if (!command.yes) {
    const probe = capturing(transport);
    await createClient({ url: command.url, transport: probe.transport }).refute(input);
    return previewed(transport, probe.sends[0]?.instructions ?? [], payer, shown, false);
  }
  const refuted = await createClient({ url: command.url, transport }).refute(input);
  return { ...shown, refutation: refuted.refutation, sent: true, signature: refuted.signature };
}

async function reclaim(command: Extract<AnnounceCommand, { name: "reclaim" }>, runtime: Runtime, transport: Transport): Promise<object> {
  const worker = await transactionSigner(runtime, command.keypair);
  const payer = await payerOf(runtime, command, worker);
  const client = createClient({ url: command.url, transport });
  const planned = await client.plan.reclaim({ worker, payer });
  const sends = planned.batches.length;
  const summary = [
    ...(planned.closed.length === 0 && planned.books.length > 0
      ? []
      : [`Closes: ${planned.closed.length} of this wallet's announcements, in ${sends} ${sends === 1 ? "transaction" : "transactions"}; each one's rent returns to the wallet that paid it`]),
    ...(planned.books.length === 0 ? [] : [reclaimBooksLine(planned.books, planned.bookBatches.length)]),
    ...keptLines(planned.reasons),
  ];
  const shown = { worker: worker.address, closed: planned.closed, books: planned.books.map(({ book }) => book), kept: planned.kept, reasons: planned.reasons, summary };
  if (planned.closed.length === 0 && planned.books.length === 0) {
    return { ...shown, sent: false, next: NOTHING_TO_RECLAIM };
  }
  if (!command.yes) {
    return previewed(transport, planned.batches[0] ?? planned.bookBatches[0] ?? [], payer, { ...shown, transactions: sends + planned.bookBatches.length }, false);
  }
  const done = await client.reclaim({ worker, payer });
  return {
    ...shown,
    closed: done.closed,
    books: done.books,
    ...(done.unclosed.length === 0 ? {} : { unclosed: done.unclosed, next: BOOKS_UNCLOSED }),
    kept: done.kept,
    reasons: done.reasons,
    sent: true,
    signatures: done.signatures,
  };
}

export const HELD_UNSURE = "no held share found, but the read was incomplete, so one may still be held: reasons and unreadable say why";

export const CLAIM_ONE = "pass --announcement, and --index when one announcement holds more than one share, to preview the claim";

async function claimHeld(command: Extract<AnnounceCommand, { name: "claim-held" }>, runtime: Runtime, transport: Transport): Promise<object> {
  const wallet = await transactionSigner(runtime, command.keypair);
  const client = createClient({ url: command.url, transport });
  const tokens = async (mint: Address, amount: bigint) => formatAmount(amount, (await mintOf(transport, mint)).decimals);
  if (command.announcement === undefined) {
    const listed = await client.heldShares(wallet.address);
    const shares = await Promise.all(
      listed.shares.map(async (share) => ({
        intent: share.intent,
        announcement: share.announcement,
        index: share.index,
        amount: await tokens(share.mint, share.amount),
        mint: share.mint,
        account: share.account,
        release: share.release,
      })),
    );
    return {
      wallet: wallet.address,
      shares,
      complete: listed.complete,
      ...(listed.reasons.length === 0 ? {} : { reasons: listed.reasons }),
      ...(listed.unreadable.length === 0 ? {} : { unreadable: listed.unreadable }),
      next: shares.length > 0 ? CLAIM_ONE : listed.complete ? NOTHING_HELD : HELD_UNSURE,
    };
  }
  const payer = await payerOf(runtime, command, wallet);
  const input = {
    wallet,
    payer,
    announcement: command.announcement,
    ...(command.index === undefined ? {} : { index: command.index }),
    ...(command.to === undefined ? {} : { to: command.to }),
  };
  const planned = await client.plan.claimHeld(input);
  const { share } = planned;
  const amount = await tokens(share.mint, share.amount);
  const shown = {
    wallet: wallet.address,
    intent: share.intent,
    announcement: share.announcement,
    index: share.index,
    amount,
    mint: share.mint,
    to: planned.to,
    summary: [
      `Claims: ${amount} of ${share.mint} held for ${wallet.address} by escrow ${share.intent}, whose release ${share.release} could not pay ${share.account}`,
      `Pays into: ${planned.to}, a token account of ${wallet.address}${planned.setup.length === 0 ? "" : `, created first; ${payer.address} pays its rent`}`,
      `Pays: the fee, from ${payer.address}`,
    ],
  };
  if (!command.yes) {
    return previewed(transport, [...planned.setup, ...planned.instructions], payer, shown, false);
  }
  return { ...shown, sent: true, signature: await client.claimHeld(input) };
}

async function closeBook(command: Extract<AnnounceCommand, { name: "close-book" }>, runtime: Runtime, transport: Transport): Promise<object> {
  const by = await transactionSigner(runtime, command.keypair);
  const book = await loadDeliveryBook(transport, command.intent);
  const probe = capturing(transport);
  await createClient({ url: command.url, transport: probe.transport }).closeBook(command.intent, by);
  const shown = {
    intent: command.intent,
    book: book?.address,
    summary: [`Closes: the empty delivery book ${book?.address ?? ""} of escrow ${command.intent}; its rent returns to ${book?.payer ?? "the wallet that paid it"}`],
  };
  if (!command.yes) {
    return previewed(transport, probe.sends[0]?.instructions ?? [], by, shown, false);
  }
  return { ...shown, sent: true, signature: await createClient({ url: command.url, transport }).closeBook(command.intent, by) };
}

export const URL_HIDDEN = "the work url is hidden; pass --judge-keypair <judge or member file> to show it";

export const SHA_FROM_PAID = "paid";
export const SHA_FROM_OWN = "this machine's deliver";
export const COMPARE_NEEDS_KEY = "--compare opens only paid announcements without --judge-keypair or --encryption-keypair, which open the salts of the others";

export const TOO_LARGE_TO_COMPARE = "too large to compare";

async function comparedOf(path: string): Promise<{ path: string; sha256: string } | { path: string; skipped: string }> {
  try {
    return { path, sha256: await artifactSha256(path) };
  } catch (error) {
    if (error instanceof ArtifactTooLarge) {
      return { path, skipped: TOO_LARGE_TO_COMPARE };
    }
    throw error;
  }
}

type Known = { sha256: string; from: string };

async function knownWork(
  announcements: readonly AnnouncementView[],
  opened: readonly { announcement: AnnouncementView; salt: string }[],
  own: readonly OwnDelivery[],
  compared: readonly { path: string; sha256: string }[],
): Promise<Map<Address, Known>> {
  const salts = new Map(opened.map(({ announcement, salt }) => [announcement.address, Buffer.from(salt, "hex")] as const));
  const known = new Map<Address, Known>();
  for (const announcement of announcements) {
    if (announcement.state === "paid") {
      known.set(announcement.address, { sha256: hex(announcement.delivered), from: SHA_FROM_PAID });
      continue;
    }
    const salt = salts.get(announcement.address);
    for (const { path, sha256 } of compared) {
      if (salt !== undefined && (await opensTo(announcement, Buffer.from(sha256, "hex"), salt))) {
        known.set(announcement.address, { sha256, from: path });
        break;
      }
    }
    const mine = own.find((entry) => entry.announcement === announcement.address);
    if (!known.has(announcement.address) && mine !== undefined && (salt === undefined || (await opensTo(announcement, Buffer.from(mine.sha256, "hex"), salt)))) {
      known.set(announcement.address, { sha256: mine.sha256, from: SHA_FROM_OWN });
    }
  }
  return known;
}

async function deliveries(command: Extract<AnnounceCommand, { name: "deliveries" }>, runtime: Runtime, transport: Transport): Promise<object> {
  const list = await createClient({ url: command.url, transport }).announcements(command.intent);
  const openers = [...(command.judgeKeypair === undefined ? [] : [await runtime.loadKeypair(command.judgeKeypair)]), ...(await loadEncryptionKeys(runtime, command.encryptionKeypairs))];
  const compare = command.compare ?? [];
  const read = await Promise.all(compare.map(async (path) => comparedOf(path)));
  const compared = read.flatMap((one) => ("sha256" in one ? [one] : []));
  const opened = openers.length === 0 ? [] : await openedBy(list.announcements, openers);
  const known = await knownWork(list.announcements, opened, await ownDeliveries(runtime, list.intent, await transport.genesisHash()), compared);
  const view = listView(list);
  const urls = new Map(opened.flatMap(({ announcement, url }) => (url === null ? [] : [[announcement.address, url] as const])));
  const notes = [
    ...(openers.length === 0 && view.announcements.length > 0 ? [URL_HIDDEN] : []),
    ...(openers.length === 0 && compare.length > 0 ? [COMPARE_NEEDS_KEY] : []),
  ];
  return {
    intent: command.intent,
    ...view,
    announcements: view.announcements.map((line) => {
      const work = known.get(line.announcement);
      return {
        ...line,
        ...(work === undefined ? {} : { sha256: work.sha256, sha256_from: work.from }),
        ...(urls.has(line.announcement) ? { url: urls.get(line.announcement) } : {}),
      };
    }),
    ...(read.length === 0 ? {} : { compared: read }),
    ...(notes.length === 0 ? {} : { note: notes.join("; ") }),
  };
}

export async function announceCommand(command: AnnounceCommand, runtime: Runtime, transport: Transport): Promise<object> {
  switch (command.name) {
    case "deliver":
      return deliver(command, runtime, transport);
    case "deliveries":
      return deliveries(command, runtime, transport);
    case "refute":
      return refute(command, runtime, transport);
    case "reclaim":
      return reclaim(command, runtime, transport);
    case "claim-held":
      return claimHeld(command, runtime, transport);
    case "close-book":
      return closeBook(command, runtime, transport);
  }
}
