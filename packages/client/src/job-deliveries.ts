import { createHash } from "node:crypto";
import type { Address, Instruction, Signature, TransactionSigner } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  commitmentPreimage,
  deliveryCommitment,
  deliveryMemo,
  deliveryMemoV2,
  DELIVERY_SCAN_MARK,
  IntentStatus,
  isMemoUrl,
  isSha256Hex,
  MEMO_URL_RULE,
  openUrl,
  parseDeliveryMemo,
  parseDeliveryMemoV2,
  sealUrl,
} from "@intent-engine/core";
import { chainTime } from "./accounts.js";
import { loadCommittee } from "./client-committee.js";
import { memoInstruction } from "./job-memos.js";
import { historyCovers, openProofEscrows, type Proof, proofAt } from "./job-proofs.js";
import { DELIVERY_PAGES, MEMOS_PER_TRANSACTION, scan } from "./job-scan.js";
import { PLAIN_HTTP_ON_PUBLIC, plainHttpOnPublic } from "./job-specs.js";
import type { Transport } from "./transport.js";

export type DeliverInput = { worker: TransactionSigner; intent: Address; sha256: string; url: string; version?: 1 | 2 };

export type DeliveryPlan = { attestor: Address; instructions: Instruction[]; commitment?: string; sealedTo?: Address[] };

export type Delivery = {
  intent: Address;
  worker: Address;
  sha256: string;
  url: string;
  signature: Signature;
  slot: bigint;
  blockTime: bigint | null;
  commitment?: string;
  sealed?: string;
};

export type DeliveryRecord = { deliveries: Delivery[]; complete: boolean; pages: number };

export type Announcement = { sha256: string; first: Delivery; copies: number };

export class NotDeliverable extends Error {
  readonly intent: Address;

  constructor(intent: Address, reason: string) {
    super(`intent ${intent} ${reason}`);
    this.name = "NotDeliverable";
    this.intent = intent;
  }
}

export async function deliveryInstructions(transport: Transport, input: DeliverInput): Promise<DeliveryPlan> {
  const { worker, intent } = input;
  const sha256 = input.sha256.toLowerCase();
  const sealed = input.version !== 1;
  const memo = sealed ? null : deliveryMemo({ intent, sha256, url: input.url });
  if (sealed && !isMemoUrl(input.url)) {
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
  if (memo !== null) {
    return { attestor, instructions: [memoInstruction(worker, memo), notify] };
  }
  const sealedTo = [...((await loadCommittee(transport, attestor))?.members ?? [attestor])];
  const commitment = await deliveryCommitment({ intent, worker: worker.address, sha256 });
  const blob = await sealUrl(input.url, sealedTo, intent);
  return { attestor, instructions: [memoInstruction(worker, deliveryMemoV2({ intent, commitment, blob })), notify], commitment, sealedTo };
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
    return { deliveries: [], complete: true, pages: 0 };
  }
  const judged: ReadonlySet<Address> = new Set(proofs.map(({ address }) => address));
  const oldest = proofs.reduce((low, proof) => (proof.intent.createdAt < low.intent.createdAt ? proof : low), first);
  const floor = oldest.intent.createdAt;
  return judgedDeliveries(transport, judge, judged, floor, () => historyCovers(transport, oldest.address, floor), pages, keypair);
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
  const scanned = await scan(transport, judge, { floor, memo: DELIVERY_SCAN_MARK, pages, covered });
  const { transactions, complete } = scanned;
  const found = transactions.flatMap(({ signature, slot, blockTime, failed, memos, feePayer }) =>
    failed || feePayer === undefined
      ? []
      : (memos ?? []).slice(0, MEMOS_PER_TRANSACTION).flatMap((text): Delivery[] => {
          const at = { worker: feePayer, signature: signature as Signature, slot, blockTime };
          const memo = parseDeliveryMemo(text);
          if (memo !== null) {
            return judged.has(memo.intent) ? [{ ...memo, ...at }] : [];
          }
          const sealed = parseDeliveryMemoV2(text);
          return sealed === null || !judged.has(sealed.intent)
            ? []
            : [{ intent: sealed.intent, sha256: "", url: "", ...at, commitment: sealed.commitment, sealed: sealed.blob }];
        }),
  );
  const deliveries = keypair === undefined ? found : await Promise.all(found.map((delivery) => opened(delivery, keypair)));
  return { deliveries, complete: complete && !transactions.some(({ unread }) => unread === true), pages: scanned.pages };
}

async function opened(delivery: Delivery, keypair: Uint8Array): Promise<Delivery> {
  if (delivery.sealed === undefined) {
    return delivery;
  }
  const url = await openUrl(delivery.sealed, keypair, delivery.intent).catch(() => null);
  return url === null ? delivery : { ...delivery, url };
}

export async function deliveriesOf(transport: Transport, judge: Address, intent?: Address): Promise<Delivery[]> {
  return (await deliveryRecord(transport, judge, intent)).deliveries;
}

const earlier = (a: Delivery, b: Delivery): boolean => a.slot < b.slot || (a.slot === b.slot && a.signature < b.signature);

export function commitmentOf(intent: Address, worker: Address, sha256: string): string {
  return createHash("sha256").update(commitmentPreimage({ intent, worker, sha256 })).digest("hex");
}

export function announces(delivery: Delivery, sha256: string): boolean {
  if (delivery.commitment === undefined) {
    return delivery.sha256 === sha256;
  }
  return isSha256Hex(sha256) && delivery.commitment === commitmentOf(delivery.intent, delivery.worker, sha256);
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

export function announcements(deliveries: readonly Delivery[]): Announcement[] {
  const hashes = [...new Set(deliveries.map(({ sha256 }) => sha256).filter((sha256) => sha256 !== ""))];
  return hashes
    .flatMap((sha256) => {
      const first = firstDelivery(deliveries, sha256);
      if (first === null) {
        return [];
      }
      const others = new Set(deliveries.filter((d) => announces(d, sha256) && d.worker !== first.worker).map(({ worker }) => worker));
      return [{ sha256, first, copies: others.size }];
    })
    .sort((a, b) => (earlier(a.first, b.first) ? -1 : earlier(b.first, a.first) ? 1 : 0));
}
