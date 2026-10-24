import type { Address, TransactionPartialSigner } from "@solana/kit";
import { type AnnounceInput, createClient, loadAnnouncement, loadDeliveryBook, type RefuteInput, secretInputOf, type Transport } from "@intent-engine/client";
import { previewed } from "./admin-commands.js";
import { claimOf, deliverClaimWarnings } from "./agent/job-claims.js";
import { ANNOUNCE_FIRST, capturing, hex, listView, openedBy, sealedToText, walletOf } from "./announcement-views.js";
import { artifactSha256 } from "./artifact.js";
import type { Command } from "./command-types.js";
import { FlowRefused } from "./flows.js";
import { deliverNotInvited, sealedInvites } from "./invites.js";
import { transactionSigner } from "./ledger-keys.js";
import type { Runtime } from "./runtime.js";
import { loadEncryptionKeys } from "./sealed-commands.js";
import { keptSecret, savedSecret, secretFor, secretsPath, signsMessages } from "./worker-secrets.js";

type AnnounceCommand = Extract<Command, { name: "deliver" | "deliveries" | "refute" | "reclaim" | "close-book" }>;

export const ALREADY_ANNOUNCED = "this work is already announced to this escrow with this url; nothing was sent";

export const NOTHING_TO_RECLAIM = "none of this wallet's announcements can close now: each belongs to an open escrow or is kept for the refutation window; nothing was sent";

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
  const invited = await sealedInvites(transport, runtime.specFetch, intent);
  const keptAt = kept === undefined ? undefined : secretsPath(runtime.home, worker.address, intent, sha256);
  const shown = {
    intent,
    attestor: plan.attestor,
    announcement: plan.announcement,
    commitment: plan.commitment,
    salt: plan.salt,
    sealed_to: plan.sealedTo.map(walletOf),
    ...(keptAt === undefined ? {} : { secrets: keptAt }),
    summary: [
      `Announces: the work with sha256 ${sha256} to the proof escrow ${intent} in ${plan.announcement}, whose commitment ${plan.commitment} binds it to ${worker.address} and the salt ${plan.salt}`,
      `Seals: the salt and the url ${workUrl} to ${sealedToText(plan.sealedTo)}, so only they can open it`,
      `Pays: the announcement's rent and the fee, from ${payer.address}; the rent returns to it when the announcement closes`,
      ...(plan.setup.length === 0 ? [] : [`Syncs first, in its own transaction: the key snapshot of committee ${plan.attestor}, which its announcements are sealed to`]),
      ...(keptAt === undefined ? [] : [`Keeps: the delivery secrets in ${keptAt}, which refute reads; this wallet cannot sign messages, so they cannot be derived again`]),
    ],
    warnings: [
      ...(invited === undefined || invited.includes(worker.address) ? [] : [deliverNotInvited(worker.address, intent)]),
      ...deliverClaimWarnings(await claimOf(transport, intent), worker.address),
      ANNOUNCE_FIRST,
    ],
  };
  if (plan.existing !== null) {
    return { ...shown, seq: plan.existing.seq, state: plan.existing.state, sent: false, next: ALREADY_ANNOUNCED };
  }
  if (!command.yes) {
    return previewed(transport, plan.setup.length > 0 ? plan.setup : plan.instructions, payer, shown, false);
  }
  const made = await client.announce(input);
  return { ...shown, seq: made.seq, sent: true, signature: made.signature, ...(made.synced === null ? {} : { synced: made.synced }) };
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
  const probe = capturing(transport);
  const planned = await createClient({ url: command.url, transport: probe.transport }).reclaim({ worker, payer });
  const summary = [
    `Closes: ${planned.closed.length} of this wallet's announcements, in ${probe.sends.length} ${probe.sends.length === 1 ? "transaction" : "transactions"}; each one's rent returns to the wallet that paid it`,
    ...(planned.kept.length === 0 ? [] : [`Keeps: ${planned.kept.length} announcements, of escrows still open or within the refutation window`]),
  ];
  const shown = { worker: worker.address, closed: planned.closed, kept: planned.kept, summary };
  if (planned.closed.length === 0) {
    return { ...shown, sent: false, next: NOTHING_TO_RECLAIM };
  }
  if (!command.yes) {
    return previewed(transport, probe.sends[0]?.instructions ?? [], payer, { ...shown, transactions: probe.sends.length }, false);
  }
  const done = await createClient({ url: command.url, transport }).reclaim({ worker, payer });
  return { ...shown, closed: done.closed, kept: done.kept, sent: true, signatures: done.signatures };
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

async function deliveries(command: Extract<AnnounceCommand, { name: "deliveries" }>, runtime: Runtime, transport: Transport): Promise<object> {
  const list = await createClient({ url: command.url, transport }).announcements(command.intent);
  const openers = [...(command.judgeKeypair === undefined ? [] : [await runtime.loadKeypair(command.judgeKeypair)]), ...(await loadEncryptionKeys(runtime, command.encryptionKeypairs))];
  const opened = openers.length === 0 ? [] : await openedBy(list.announcements, openers);
  const view = listView(list);
  const urls = new Map(opened.flatMap(({ announcement, url }) => (url === null ? [] : [[announcement.address, url] as const])));
  return { intent: command.intent, ...view, announcements: view.announcements.map((line) => ({ ...line, ...(urls.has(line.announcement) ? { url: urls.get(line.announcement) } : {}) })) };
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
    case "close-book":
      return closeBook(command, runtime, transport);
  }
}
