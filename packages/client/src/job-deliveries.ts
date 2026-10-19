import { createHash } from "node:crypto";
import {
  type Address,
  createSignableMessage,
  getPublicKeyFromAddress,
  type Instruction,
  isMessagePartialSigner,
  type Signature,
  type SignatureBytes,
  type TransactionSigner,
  verifySignature,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  commitmentPreimage,
  DELIVERY_MEMO_MARK,
  deliveryMemo,
  IntentStatus,
  isMemoUrl,
  isSaltHex,
  isSha256Hex,
  MEMO_URL_RULE,
  type Opening,
  openDelivery,
  parseDeliveryMemo,
  parseOpeningMemo,
  saltCheckPreimage,
  saltMessage,
  saltOfSignature,
  sealDelivery,
} from "@intent-engine/core";
import { chainTime } from "./accounts.js";
import { isDevice } from "./ledger.js";
import { loadCommittee } from "./client-committee.js";
import { memoInstruction } from "./job-memos.js";
import { historyCovers, openProofEscrows, type Proof, proofAt } from "./job-proofs.js";
import { DELIVERY_PAGES, MEMOS_PER_TRANSACTION, scan } from "./job-scan.js";
import { PLAIN_HTTP_ON_PUBLIC, plainHttpOnPublic } from "./job-specs.js";
import type { EngineTransaction, Transport } from "./transport.js";

export type DeliverInput = { worker: TransactionSigner; intent: Address; sha256: string; url: string; saltSignature?: Uint8Array };

export type DeliveryPlan = { attestor: Address; instructions: Instruction[]; commitment: string; check: string; salt: string; sealedTo: Address[] };

export type Delivery = {
  intent: Address;
  worker: Address;
  sha256: string;
  url: string;
  signature: Signature;
  slot: bigint;
  blockTime: bigint | null;
  commitment: string;
  check: string;
  salt: string;
  sealed: string;
};

export type PublishedOpening = { opening: Opening; signature: string; slot: bigint; by: Address };

export type DeliveryRecord = { deliveries: Delivery[]; openings: PublishedOpening[]; complete: boolean; pages: number };

export class NotDeliverable extends Error {
  readonly intent: Address;

  constructor(intent: Address, reason: string) {
    super(`intent ${intent} ${reason}`);
    this.name = "NotDeliverable";
    this.intent = intent;
  }
}

export const cannotSignMessages = (worker: Address): string =>
  `the wallet ${worker} cannot sign messages, and a delivery derives its salt from the wallet's own signature over the intent and the work's sha256; announce with a key file or a wallet that signs messages; nothing was sent`;

export class NoMessageSigner extends Error {
  readonly worker: Address;

  constructor(worker: Address) {
    super(cannotSignMessages(worker));
    this.name = "NoMessageSigner";
    this.worker = worker;
  }
}

export const saltSignatureRefused = (worker: Address): string =>
  `the salt signature is not ${worker}'s ed25519 signature of the salt message for this intent and sha256; nothing was sent`;

export class BadSaltSignature extends Error {
  readonly worker: Address;

  constructor(worker: Address) {
    super(saltSignatureRefused(worker));
    this.name = "BadSaltSignature";
    this.worker = worker;
  }
}

async function signedBy(worker: Address, signature: Uint8Array, message: Uint8Array): Promise<boolean> {
  if (signature.length !== 64) {
    return false;
  }
  try {
    return await verifySignature(await getPublicKeyFromAddress(worker), signature as SignatureBytes, message);
  } catch {
    return false;
  }
}

export async function deliverySalt(worker: TransactionSigner, intent: Address, sha256: string, saltSignature?: Uint8Array): Promise<string> {
  const message = saltMessage(intent, sha256);
  if (saltSignature !== undefined) {
    if (!(await signedBy(worker.address, saltSignature, message))) {
      throw new BadSaltSignature(worker.address);
    }
    return saltOfSignature(saltSignature);
  }
  if (!isMessagePartialSigner(worker) || isDevice(worker)) {
    throw new NoMessageSigner(worker.address);
  }
  const [signed] = await worker.signMessages([createSignableMessage(message)]);
  const signature = signed?.[worker.address];
  if (signature === undefined || signature.length !== 64) {
    throw new NoMessageSigner(worker.address);
  }
  return saltOfSignature(signature);
}

export async function deliveryInstructions(transport: Transport, input: DeliverInput): Promise<DeliveryPlan> {
  const { worker, intent } = input;
  const sha256 = input.sha256.toLowerCase();
  if (!isMemoUrl(input.url)) {
    throw new RangeError(`a delivery url must be ${MEMO_URL_RULE}`);
  }
  if (await plainHttpOnPublic(transport, input.url)) {
    throw new RangeError(`the work url ${input.url} ${PLAIN_HTTP_ON_PUBLIC}`);
  }
  const [proof, now] = await Promise.all([proofAt(transport, intent), chainTime(transport)]);
  if (proof === null) {
    throw new NotDeliverable(intent, "is not a proof escrow: an AttestedResult intent that commits a spec hash");
  }
  if (proof.intent.status !== IntentStatus.Open || proof.intent.expiresAt <= now) {
    throw new NotDeliverable(intent, "is no longer open");
  }
  const attestor = proof.params.attestor;
  const notify = getTransferSolInstruction({ source: worker, destination: attestor, amount: 0n });
  const sealedTo = [...((await loadCommittee(transport, attestor))?.members ?? [attestor])];
  const salt = await deliverySalt(worker, intent, sha256, input.saltSignature);
  const commitment = commitmentOf(intent, worker.address, salt, sha256);
  const check = saltCheckOf(salt);
  const blob = await sealDelivery({ salt, url: input.url }, sealedTo, intent);
  return { attestor, instructions: [memoInstruction(worker, deliveryMemo({ intent, commitment, check, blob })), notify], commitment, check, salt, sealedTo };
}

export async function deliveryRecord(
  transport: Transport,
  judge: Address,
  intent?: Address,
  pages: number = DELIVERY_PAGES,
  keypair?: Uint8Array,
): Promise<DeliveryRecord> {
  let proofs: Proof[];
  if (intent === undefined) {
    proofs = await openProofEscrows(transport, judge, Number.POSITIVE_INFINITY);
  } else {
    const proof = await proofAt(transport, intent);
    proofs = proof !== null && proof.params.attestor === judge ? [proof] : [];
  }
  const [first] = proofs;
  if (first === undefined) {
    return { deliveries: [], openings: [], complete: true, pages: 0 };
  }
  const judged: ReadonlySet<Address> = new Set(proofs.map(({ address }) => address));
  const oldest = proofs.reduce((low, proof) => (proof.intent.createdAt < low.intent.createdAt ? proof : low), first);
  const floor = oldest.intent.createdAt;
  return judgedDeliveries(transport, judge, judged, floor, () => historyCovers(transport, oldest.address, floor), pages, keypair);
}

export function openingsIn(transactions: readonly EngineTransaction[], judged?: ReadonlySet<Address>): PublishedOpening[] {
  return transactions.flatMap(({ signature, slot, failed, memos, feePayer }) =>
    failed || feePayer === undefined
      ? []
      : (memos ?? []).slice(0, MEMOS_PER_TRANSACTION).flatMap((text): PublishedOpening[] => {
          const opening = parseOpeningMemo(text);
          return opening === null || (judged !== undefined && !judged.has(opening.intent)) ? [] : [{ opening, signature, slot, by: feePayer }];
        }),
  );
}

export function deliveriesIn(transactions: readonly EngineTransaction[], judged?: ReadonlySet<Address>): Delivery[] {
  return transactions.flatMap(({ signature, slot, blockTime, failed, memos, feePayer }) =>
    failed || feePayer === undefined
      ? []
      : (memos ?? []).slice(0, MEMOS_PER_TRANSACTION).flatMap((text): Delivery[] => {
          const at = { worker: feePayer, signature: signature as Signature, slot, blockTime };
          const sealed = parseDeliveryMemo(text);
          return sealed === null || (judged !== undefined && !judged.has(sealed.intent))
            ? []
            : [{ intent: sealed.intent, sha256: "", url: "", ...at, commitment: sealed.commitment, check: sealed.check, salt: "", sealed: sealed.blob }];
        }),
  );
}

export async function judgedDeliveries(
  transport: Transport,
  judge: Address,
  judged: ReadonlySet<Address>,
  floor: bigint | null,
  covered: () => Promise<boolean>,
  pages: number,
  keypair?: Uint8Array,
): Promise<DeliveryRecord> {
  const scanned = await scan(transport, judge, { floor, memo: DELIVERY_MEMO_MARK, pages, covered });
  const { transactions, complete } = scanned;
  const found = deliveriesIn(transactions, judged);
  const deliveries = keypair === undefined ? found : await Promise.all(found.map((delivery) => opened(delivery, keypair)));
  return {
    deliveries,
    openings: openingsIn(transactions, judged),
    complete: complete && !transactions.some(({ unread }) => unread === true),
    pages: scanned.pages,
  };
}

async function opened(delivery: Delivery, keypair: Uint8Array): Promise<Delivery> {
  const open = await openDelivery(delivery.sealed, keypair, delivery.intent).catch(() => null);
  if (open === null) {
    return delivery;
  }
  return saltCheckOf(open.salt) === delivery.check ? { ...delivery, url: open.url, salt: open.salt } : { ...delivery, url: open.url };
}

export async function deliveriesOf(transport: Transport, judge: Address, intent?: Address): Promise<Delivery[]> {
  return (await deliveryRecord(transport, judge, intent)).deliveries;
}

export const earlier = (a: { slot: bigint; signature: string }, b: { slot: bigint; signature: string }): boolean =>
  a.slot < b.slot || (a.slot === b.slot && a.signature < b.signature);

export function commitmentOf(intent: Address, worker: Address, salt: string, sha256: string): string {
  return createHash("sha256").update(commitmentPreimage({ intent, worker, salt, sha256 })).digest("hex");
}

export function saltCheckOf(salt: string): string {
  return createHash("sha256").update(saltCheckPreimage(salt)).digest("hex").slice(0, 32);
}

export function opensWith(delivery: Delivery, salt: string, sha256: string): boolean {
  return (
    isSaltHex(salt) &&
    isSha256Hex(sha256) &&
    delivery.check === saltCheckOf(salt) &&
    delivery.commitment === commitmentOf(delivery.intent, delivery.worker, salt, sha256)
  );
}

export function announces(delivery: Delivery, sha256: string): boolean {
  return opensWith(delivery, delivery.salt, sha256);
}

export function withWork(delivery: Delivery, sha256: string): Delivery | null {
  return announces(delivery, sha256) ? { ...delivery, sha256 } : null;
}

export function firstDelivery(deliveries: readonly Delivery[], sha256: string): Delivery | null {
  let first: Delivery | null = null;
  for (const delivery of deliveries) {
    if (announces(delivery, sha256) && (first === null || earlier(delivery, first))) {
      first = delivery;
    }
  }
  return first === null || first.sha256 === sha256 ? first : { ...first, sha256 };
}
