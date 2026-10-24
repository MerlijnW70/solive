import { type Address, generateKeyPairSigner } from "@solana/kit";
import {
  EVENT_IX_TAG,
  findIntentPda,
  getIntentAttestedEventEncoder,
  getIntentCreatedEventEncoder,
  getIntentDecoder,
  getIntentEncoder,
  type Intent,
  IntentStatus,
} from "@intent-engine/core";
import { type AccountView, type EngineTransaction, type ListedSignature, TRANSACTION_FETCHES, type Transport } from "@intent-engine/client";
import { cli, ESCROW, h, NOW, world } from "./harness.js";

export const FLOOR = 1_000n;
export const RELEASE = "5".repeat(64);

const tagged = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);

export type Escrow = { intent: Address; view: AccountView };

export async function escrow(): Promise<Escrow> {
  const w = await world();
  const swap = await cli(
    ["create", "swap", "--keypair", "owner.json", "--nonce", "1", "--input-mint", w.inputMint, "--output-mint", w.outputMint, "--expires-at", String(NOW + 3_600n), "--amount-in", ESCROW.toString(), "--min-out", "1", "--units", "raw", "--yes"],
    { "owner.json": w.owner },
  );
  if (swap.code !== 0) {
    throw new Error(swap.err);
  }
  const [intent] = await findIntentPda({ owner: w.owner.address, nonce: 1n });
  const account = h.svm.getAccount(intent);
  if (!account.exists) {
    throw new Error("the escrow was not created");
  }
  return { intent, view: { owner: account.programAddress, data: new Uint8Array(account.data), lamports: account.lamports } };
}

export const intentOf = (view: AccountView): Intent => getIntentDecoder().decode(view.data);

export const filledAt = (view: AccountView, createdAt: bigint): AccountView => ({
  ...view,
  data: Uint8Array.from(getIntentEncoder().encode({ ...intentOf(view), status: IntentStatus.Filled, createdAt })),
});

export type Shape = { slot?: bigint; blockTime?: bigint | null; memos?: string[]; unread?: true; failed?: boolean; emitted?: Uint8Array[] };

export const plain = (signature: string, shape: Shape = {}): EngineTransaction => ({
  signature,
  slot: shape.slot ?? 1n,
  blockTime: shape.blockTime ?? null,
  failed: shape.failed ?? false,
  emitted: shape.emitted ?? [],
  ...(shape.memos === undefined ? {} : { memos: shape.memos }),
  ...(shape.unread === undefined ? {} : { unread: shape.unread }),
});

export function created(intent: Address, signature: string, shape: Shape = {}): EngineTransaction {
  const event = getIntentCreatedEventEncoder().encode({
    intent,
    owner: intent,
    nonce: 0n,
    kind: 4,
    inputMint: intent,
    outputMint: intent,
    receiver: intent,
    escrowed: 0n,
    expiresAt: 0n,
    rentPayer: intent,
    flags: 0,
    bounty: 0,
    createFee: 0,
  });
  return plain(signature, { ...shape, emitted: [tagged(event)] });
}

export function released(intent: Address, shape: Shape = {}): EngineTransaction {
  const event = getIntentAttestedEventEncoder().encode({
    intent,
    owner: intent,
    solver: intent,
    payee: intent,
    attestor: intent,
    amountIn: 100n,
    result: 1n,
    fee: 1n,
    net: 99n,
    filled: 100n,
    remaining: 0n,
    partnerFee: 0n,
  });
  return plain(RELEASE, { ...shape, emitted: [tagged(event)] });
}

const listedOf = (tx: EngineTransaction): ListedSignature => ({
  signature: tx.signature,
  slot: tx.slot,
  blockTime: tx.blockTime,
  failed: tx.failed,
  memo: tx.memos === undefined ? null : tx.memos.map((memo) => `[${memo.length}] ${memo}`).join("; "),
});

export type Node = { transport: Transport; pages: number; batches: number[] };

export function node(intent: Address, history: readonly EngineTransaction[], options: { page?: number; held?: AccountView | null; listing?: boolean } = {}): Node {
  const { page, held = null, listing = true } = options;
  const listed = history.map(listedOf);
  const bySignature = new Map(history.map((tx) => [tx.signature, tx]));
  const made: Node = { transport: {} as Transport, pages: 0, batches: [] };
  const base = {
    getAccount: async (address: Address) => (address === intent ? held : null),
    engineTransactions: async () => [...history],
    transactionOf: async (signature: string) => bySignature.get(signature) ?? null,
  };
  const paged = {
    signaturesOf: async (_of: Address, limit: number, before?: string) => {
      made.pages++;
      const from = before === undefined ? 0 : listed.findIndex((entry) => entry.signature === before) + 1;
      return listed.slice(from, from + Math.min(limit, page ?? limit));
    },
    transactionsOf: async (batch: readonly ListedSignature[]) => {
      if (batch.length === 0 || batch.length > TRANSACTION_FETCHES) {
        throw new Error(`asked for a batch of ${batch.length} transactions`);
      }
      made.batches.push(batch.length);
      return batch.map((entry) => bySignature.get(entry.signature) as EngineTransaction);
    },
  };
  made.transport = (listing ? { ...base, ...paged } : base) as unknown as Transport;
  return made;
}

export const newcomer = async (): Promise<Address> => (await generateKeyPairSigner()).address;
