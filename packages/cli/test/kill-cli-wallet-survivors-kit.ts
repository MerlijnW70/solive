import { type Address, getBase58Decoder, type Signature } from "@solana/kit";
import { DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import {
  EVENT_IX_TAG,
  getClaimDroppedEventEncoder,
  getDeliveryAnnouncedEventEncoder,
  getIntentAttestedEventEncoder,
  getIntentCancelledEventEncoder,
  getIntentClosedEventEncoder,
  getIntentCreatedEventEncoder,
  getIntentExpiredEventEncoder,
  getJobClaimedEventEncoder,
  getLineLeftEventEncoder,
  getStakeMovedEventEncoder,
  getStoodByEventEncoder,
  checkAccountVersion,
  findConfigPda,
  getConfigDecoder,
  getConfigEncoder,
  HELD_CLAIM_SECS,
  signMessageBytes,
} from "@intent-engine/core/internal";
import type { EngineTransaction, Transport } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { svmTransport } from "@intent-engine/client/svm";
import { testSignature } from "@intent-engine/client/testing";
import { connect, ok, preset } from "./agent-wallet-kit.js";
import { announced, keyed } from "./announce.js";
import { HELD_WEIGHTS, heldEscrow, keyOf } from "./held-kit.js";
import { DOMAIN, h, setNow, world } from "./harness.js";

export const tagged = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);

export function landed(signature: string, slot: bigint, emitted: Uint8Array[], extra: Partial<EngineTransaction> = {}): EngineTransaction {
  return { signature: signature as Signature, slot, blockTime: slot, failed: false, emitted, ...extra };
}

export const pair = (low: string, high: string): [string, string] => {
  const [a, b] = [testSignature(low), testSignature(high)];
  return a < b ? [a, b] : [b, a];
};

export const claimedEvent = (intent: Address, worker: Address, stake = 50_000_000n) => tagged(getJobClaimedEventEncoder().encode({ intent, worker, until: 0n, stake }));

export const movedEvent = (intent: Address, worker: Address, to: Address, role: number, amount = 50_000_000n) => tagged(getStakeMovedEventEncoder().encode({ intent, worker, to, amount, role }));

export const queuedEvent = (intent: Address, worker: Address, stake = 50_000_000n) => tagged(getStoodByEventEncoder().encode({ intent, worker, seq: 1, secs: 600, stake }));

export const droppedEvent = (intent: Address, worker: Address, refunded = 50_000_000n) => tagged(getClaimDroppedEventEncoder().encode({ intent, worker, refunded }));

export const leftEvent = (intent: Address, worker: Address, refunded = 50_000_000n) => tagged(getLineLeftEventEncoder().encode({ intent, worker, seq: 1, refunded }));

export const cancelledEvent = (intent: Address, owner: Address) => tagged(getIntentCancelledEventEncoder().encode({ intent, owner, refunded: 1n }));

export const expiredEvent = (intent: Address, owner: Address) => tagged(getIntentExpiredEventEncoder().encode({ intent, owner, refunded: 1n, refundTo: owner, by: owner, bounty: 0 }));

export const closedEvent = (intent: Address, owner: Address, bountyTo: Address, bounty: number) =>
  tagged(getIntentClosedEventEncoder().encode({ intent, owner, swept: 0n, refundTo: owner, by: bountyTo, bounty, bountyTo, rentTo: owner }));

export const announcedEvent = (intent: Address, announcement: Address, worker: Address, attestor: Address, seq = 1n) =>
  tagged(getDeliveryAnnouncedEventEncoder().encode({ intent, announcement, seq, worker, payer: worker, attestor, commitment: new Uint8Array(32), slot: 5n, recipients: 1 }));

export function createdEvent(intent: Address, owner: Address, createFee = 0, nonce = 0n, inputMint: Address = NATIVE_MINT) {
  return tagged(
    getIntentCreatedEventEncoder().encode({
      intent,
      owner,
      nonce,
      kind: 4,
      inputMint,
      outputMint: DEVNET_TEST_MINT,
      receiver: owner,
      escrowed: 1_000n,
      expiresAt: 0n,
      rentPayer: owner,
      flags: 0,
      bounty: 0,
      createFee,
    }),
  );
}

export function attestedEvent(intent: Address, owner: Address, payee: Address, net: bigint, fee: bigint, partnerFee: bigint) {
  return tagged(getIntentAttestedEventEncoder().encode({ intent, owner, solver: owner, payee, attestor: owner, amountIn: net + fee + partnerFee, result: 1n, fee, net, filled: net + fee + partnerFee, remaining: 0n, partnerFee }));
}

export async function heldWorld(closing = true) {
  await world();
  const through = svmTransport(h.svm, { genesisHash: getBase58Decoder().decode(DOMAIN) });
  h.through = through;
  preset(NATIVE_MINT);
  preset(DEVNET_TEST_MINT);
  const client = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
  const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
  const coauthor = await keyOf(wallet);
  const judge = await keyed();
  const work = "7f".repeat(32);
  const made = await heldEscrow(coauthor, work, through, judge.address);
  await announced(made.intent, coauthor, work, undefined, through);
  const sdk = createClient({ url: "http://cluster", transport: through });
  const target = {
    intent: { owner: made.owner.address, nonce: made.nonce },
    announcement: made.announcement,
    opening: { sha256: work, salt: made.salt },
    result: 1n,
    recipients: [
      { wallet: made.announcer.address, weight: HELD_WEIGHTS[0] ?? 0 },
      { wallet, weight: HELD_WEIGHTS[1] ?? 0 },
    ],
  };
  const ballot = await sdk.splitBallot(target);
  const signatures = await Promise.all([made.announcer, coauthor].map(async (signer) => ({ wallet: signer.address, signature: await signMessageBytes(signer, ballot.message) })));
  await sdk.settleSplit({ ...target, judge, signatures });
  const escrow = await sdk.intent(made.intent);
  if (!closing) {
    return { client, through: through as Transport, wallet, coauthor, made, close: null, work };
  }
  setNow((escrow?.intent.expiresAt ?? 0n) + HELD_CLAIM_SECS + 1n);
  const close = await sdk.close(await keyed(), made.intent);
  return { client, through: through as Transport, wallet, coauthor, made, close, work };
}

export function unreadFirst(through: Transport, intent: Address): Transport {
  const unread: EngineTransaction = { signature: testSignature("unread"), slot: 1_000_000_000n, blockTime: null, failed: false, emitted: [], unread: true };
  return {
    ...through,
    signaturesOf: undefined,
    transactionsOf: undefined,
    transactionOf: undefined,
    engineTransactions: async (limit: number, of?: Address) => [...(of === intent ? [unread] : []), ...(await through.engineTransactions(limit, of))],
  } as unknown as Transport;
}

export async function freeProtocol(): Promise<void> {
  const [at] = await findConfigPda();
  const held = h.svm.getAccount(at);
  if (!held.exists) {
    throw new Error("the config was not made");
  }
  const config = getConfigDecoder().decode(checkAccountVersion(Uint8Array.from(held.data)));
  h.svm.setAccount({ ...held, data: Uint8Array.from(getConfigEncoder().encode({ ...config, feeBps: 0, kindFeeMask: 0 })) });
}
