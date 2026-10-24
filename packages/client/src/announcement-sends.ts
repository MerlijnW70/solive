import type { Address, Signature, TransactionSigner } from "@solana/kit";
import {
  announcementCommitment,
  buildCloseAnnouncement,
  buildCloseDeliveryBook,
  buildRefuteRelease,
  delivery,
  deliverySecrets,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  IntentCoreError,
  IntentStatus,
  keyFingerprintV4,
  openWithEsk,
  refutationAddress,
  type SealRecipient,
} from "@intent-engine/core";
import { chainTime } from "./accounts.js";
import { BookNotClosable, NotDeliverable, NotRefutable } from "./announce-errors.js";
import { committeeKeys, publishedKey, secretSource, type SecretInput } from "./announce-keys.js";
import { sha256Bytes } from "./announce.js";
import { type AnnouncementView, announcementsBy, loadAnnouncement, loadDeliveryBook } from "./announcement-reads.js";
import type { ClientContext } from "./client-types.js";
import { hex, readableIntent } from "./job-proofs.js";
import type { Transport } from "./transport.js";

export type RefuteInput = SecretInput & {
  worker: TransactionSigner;
  earlier: Address;
  paid: Address;
  sha256: string;
  url: string;
  payer?: TransactionSigner;
  claim?: { recipients: Address[]; weights: number[] };
};

export type Refuted = { refutation: Address; signature: Signature };

export type ReclaimInput = { worker: TransactionSigner; payer?: TransactionSigner };

export type Reclaimed = { closed: Address[]; kept: Address[]; signatures: Signature[] };

export const RECLAIM_BATCH = 5;

const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, i) => byte === b[i]);

async function announcementAt(transport: Transport, address: Address, what: string): Promise<AnnouncementView> {
  const found = await loadAnnouncement(transport, address);
  if (found === null) {
    throw new NotRefutable(address, `does not exist, so it cannot be the ${what} announcement`);
  }
  return found;
}

async function sealedRecipients(transport: Transport, earlier: AnnouncementView): Promise<SealRecipient[]> {
  const head = delivery.blobHead(earlier.blob);
  const wallets = (await committeeKeys(transport, earlier.attestor))?.members ?? [earlier.attestor];
  if (wallets.length !== head.count) {
    throw new NotRefutable(earlier.address, `is sealed to ${head.count} recipients, but its judge now has ${wallets.length}`);
  }
  return Promise.all(
    wallets.map(async (wallet, i): Promise<SealRecipient> => {
      if (((head.mask >> i) & 1) === 0) {
        return wallet;
      }
      const key = await publishedKey(transport, wallet, earlier.intent).catch((error: unknown) => {
        if (error instanceof NotDeliverable) {
          return null;
        }
        throw error;
      });
      if (key === null || !equal(await keyFingerprintV4(key), head.fps[i] ?? new Uint8Array())) {
        throw new NotRefutable(earlier.address, `is sealed to an encryption key the profile of ${wallet} no longer names, so its secrets cannot be derived again`);
      }
      return { wallet, encryptionKey: key };
    }),
  );
}

function payeesOf(paid: AnnouncementView, claim: RefuteInput["claim"]): readonly Address[] {
  if (paid.splitHash.every((b) => b === 0)) {
    return [paid.worker];
  }
  if (claim === undefined) {
    throw new NotRefutable(paid.address, "was paid in a split, so a refutation names the split's recipients and weights in claim");
  }
  return claim.recipients;
}

export function announcementSends(context: ClientContext) {
  const { transport } = context;

  const refute = async (input: RefuteInput): Promise<Refuted> => {
    const { worker } = input;
    const delivered = sha256Bytes(input.sha256);
    const [earlier, paid] = await Promise.all([announcementAt(transport, input.earlier, "earlier"), announcementAt(transport, input.paid, "paid")]);
    if (paid.state !== "paid") {
      throw new NotRefutable(earlier.address, `cannot refute ${paid.address}, which was never paid`);
    }
    if (earlier.intent !== paid.intent) {
      throw new NotRefutable(earlier.address, `belongs to ${earlier.intent}, not to ${paid.intent}, the escrow ${paid.address} was paid from`);
    }
    if (earlier.worker !== worker.address) {
      throw new NotRefutable(earlier.address, `was made by ${earlier.worker}, so only that wallet refutes with it`);
    }
    if (!equal(paid.delivered, delivered)) {
      throw new NotRefutable(earlier.address, `cannot refute ${paid.address}, which paid the work ${hex(paid.delivered)}, not ${hex(delivered)}`);
    }
    try {
      delivery.refutes(earlier.seq, paid.seq, worker.address, payeesOf(paid, input.claim));
    } catch (error) {
      if (error instanceof IntentCoreError) {
        throw new NotRefutable(earlier.address, `does not refute ${paid.address}: ${error.message}`);
      }
      throw error;
    }
    const recipients = await sealedRecipients(transport, earlier);
    const source = await secretSource(worker, earlier.intent, hex(delivered), input);
    const { salt, esk } = await deliverySecrets(input.url, recipients, source);
    if (!equal(await announcementCommitment(earlier.intent, earlier.worker, { delivered, salt }), earlier.commitment)) {
      throw new NotRefutable(earlier.address, `does not commit to the work ${hex(delivered)} with this worker's secret`);
    }
    if ((await openWithEsk(earlier.blob, esk, recipients, earlier.intent, earlier.worker)) === null) {
      throw new NotRefutable(earlier.address, `does not open with the url ${input.url} and this worker's secret`);
    }
    const payer = input.payer ?? worker;
    const instruction = await buildRefuteRelease({
      earlierWorker: worker,
      payer,
      paid: paid.address,
      earlier: earlier.address,
      salt,
      esk,
      ...(input.claim === undefined ? {} : { claim: input.claim }),
    });
    return { refutation: await refutationAddress(earlier.address), signature: await context.send([instruction], payer) };
  };

  const reclaim = async (input: ReclaimInput): Promise<Reclaimed> => {
    const { worker } = input;
    const mine = await announcementsBy(transport, worker.address);
    const intents = [...new Set(mine.map(({ intent }) => intent))];
    const [views, now] = await Promise.all([transport.getAccounts(intents), chainTime(transport)]);
    const open = new Set(
      intents.filter((_, i) => {
        const view = views[i];
        const intent = view === null || view === undefined || view.owner !== INTENT_ENGINE_PROGRAM_ADDRESS ? null : readableIntent(view.data);
        return intent !== null && intent.status === IntentStatus.Open && now < intent.expiresAt;
      }),
    );
    const closable = (announcement: AnnouncementView): boolean => {
      try {
        delivery.closable(announcement.state, true, open.has(announcement.intent), now, announcement.expiresAt, announcement.paidAt);
        return true;
      } catch (error) {
        if (error instanceof IntentCoreError) {
          return false;
        }
        throw error;
      }
    };
    const closing = mine.filter(closable);
    const payer = input.payer ?? worker;
    const signatures: Signature[] = [];
    for (let at = 0; at < closing.length; at += RECLAIM_BATCH) {
      const batch = closing.slice(at, at + RECLAIM_BATCH);
      const instructions = await Promise.all(
        batch.map(({ address, intent, payer: rentTo }) => buildCloseAnnouncement({ by: worker, announcement: address, intent, rentTo })),
      );
      signatures.push(await context.send(instructions, payer));
    }
    return { closed: closing.map(({ address }) => address), kept: mine.filter((a) => !closing.includes(a)).map(({ address }) => address), signatures };
  };

  const closeBook = async (intent: Address, by: TransactionSigner): Promise<Signature> => {
    const [book, view, now] = await Promise.all([loadDeliveryBook(transport, intent), transport.getAccount(intent), chainTime(transport)]);
    if (book === null) {
      throw new BookNotClosable(intent, "does not exist");
    }
    if (book.live > 0n) {
      throw new BookNotClosable(intent, `still holds ${book.live} announcements; they close first`);
    }
    const held = view === null || view.owner !== INTENT_ENGINE_PROGRAM_ADDRESS ? null : readableIntent(view.data);
    if (held !== null && held.status === IntentStatus.Open && now < held.expiresAt) {
      throw new BookNotClosable(intent, "belongs to an escrow that is still open");
    }
    return context.send([await buildCloseDeliveryBook({ by, intent, rentTo: book.payer })], by);
  };

  return { refute, reclaim, closeBook };
}
