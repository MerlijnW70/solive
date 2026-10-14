import type { Address, Instruction, Signature, TransactionSigner } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { deliveryMemo, IntentStatus, DELIVERY_MEMO_PREFIX, parseDeliveryMemo } from "@intent-engine/core";
import { chainTime } from "./accounts.js";
import { memoInstruction } from "./job-memos.js";
import { historyCovers, openProofEscrows, type Proof, proofAt } from "./job-proofs.js";
import { DELIVERY_PAGES, MEMOS_PER_TRANSACTION, scan } from "./job-scan.js";
import { PLAIN_HTTP_ON_PUBLIC, plainHttpOnPublic } from "./job-specs.js";
import type { Transport } from "./transport.js";

export type DeliverInput = { worker: TransactionSigner; intent: Address; sha256: string; url: string };

export type Delivery = {
  intent: Address;
  worker: Address;
  sha256: string;
  url: string;
  signature: Signature;
  slot: bigint;
  blockTime: bigint | null;
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

export async function deliveryInstructions(transport: Transport, input: DeliverInput): Promise<{ attestor: Address; instructions: Instruction[] }> {
  const { worker, intent } = input;
  const memo = deliveryMemo({ intent, sha256: input.sha256.toLowerCase(), url: input.url });
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
  return {
    attestor,
    instructions: [memoInstruction(worker, memo), getTransferSolInstruction({ source: worker, destination: attestor, amount: 0n })],
  };
}

export async function deliveryRecord(transport: Transport, judge: Address, intent?: Address, pages: number = DELIVERY_PAGES): Promise<DeliveryRecord> {
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
  return judgedDeliveries(transport, judge, judged, floor, () => historyCovers(transport, oldest.address, floor), pages);
}

export async function judgedDeliveries(
  transport: Transport,
  judge: Address,
  judged: ReadonlySet<Address>,
  floor: bigint | null,
  covered: () => Promise<boolean>,
  pages: number,
): Promise<DeliveryRecord> {
  const scanned = await scan(transport, judge, { floor, memo: DELIVERY_MEMO_PREFIX, pages, covered });
  const { transactions, complete } = scanned;
  const deliveries = transactions.flatMap(({ signature, slot, blockTime, failed, memos, feePayer }) =>
    failed || feePayer === undefined
      ? []
      : (memos ?? [])
          .slice(0, MEMOS_PER_TRANSACTION)
          .map(parseDeliveryMemo)
          .flatMap((memo) =>
            memo === null || !judged.has(memo.intent)
              ? []
              : [{ ...memo, worker: feePayer, signature: signature as Signature, slot, blockTime }],
          ),
  );
  return { deliveries, complete: complete && !transactions.some(({ unread }) => unread === true), pages: scanned.pages };
}

export async function deliveriesOf(transport: Transport, judge: Address, intent?: Address): Promise<Delivery[]> {
  return (await deliveryRecord(transport, judge, intent)).deliveries;
}

const earlier = (a: Delivery, b: Delivery): boolean => a.slot < b.slot || (a.slot === b.slot && a.signature < b.signature);

export function firstDelivery(deliveries: readonly Delivery[], sha256: string): Delivery | null {
  let first: Delivery | null = null;
  for (const delivery of deliveries) {
    if (delivery.sha256 === sha256 && (first === null || earlier(delivery, first))) {
      first = delivery;
    }
  }
  return first;
}

export function announcements(deliveries: readonly Delivery[]): Announcement[] {
  const hashes = [...new Set(deliveries.map(({ sha256 }) => sha256))];
  return hashes
    .flatMap((sha256) => {
      const first = firstDelivery(deliveries, sha256);
      if (first === null) {
        return [];
      }
      const others = new Set(deliveries.filter((d) => d.sha256 === sha256 && d.worker !== first.worker).map(({ worker }) => worker));
      return [{ sha256, first, copies: others.size }];
    })
    .sort((a, b) => (earlier(a.first, b.first) ? -1 : earlier(b.first, a.first) ? 1 : 0));
}
