import { type Address, getAddressDecoder } from "@solana/kit";
import { type Intent, IntentStatus, Kind } from "@intent-engine/core";
import {
  encodeParams,
  EVENT_IX_TAG,
  getIntentCancelledEventEncoder,
  getIntentCreatedEventEncoder,
  getIntentDecoder,
  getIntentDiscriminatorBytes,
  getIntentEncoder,
  getIntentSize,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  INTENT_VERSION,
} from "@intent-engine/core/internal";
import type { AccountView, EngineTransaction } from "../src/index.js";
import { testSignature } from "../src/testing.js";

export const key = (byte: number): Address => getAddressDecoder().decode(new Uint8Array(32).fill(byte));

export const OWNER = key(9);
export const JUDGE = key(8);
export const MINT = key(7);

const blank = new Uint8Array(getIntentSize());
blank.set(getIntentDiscriminatorBytes());
export const BASE: Intent = { ...getIntentDecoder().decode(blank), owner: OWNER, inputMint: MINT, version: INTENT_VERSION, expiresAt: 1_000n };

export type ProofTerms = { amountIn?: bigint; judgeFee?: bigint; attestor?: Address; specHash?: Uint8Array };

export const proofParams = (terms: ProofTerms = {}): Uint8Array =>
  encodeParams({
    kind: Kind.AttestedResult,
    amountIn: terms.amountIn ?? 100n,
    minResult: 1n,
    maxResult: 1n,
    attestor: terms.attestor ?? JUDGE,
    specHash: terms.specHash ?? new Uint8Array(32).fill(7),
    judgeFee: terms.judgeFee ?? 0n,
  });

export const proofIntent = (patch: Partial<Intent> = {}, terms: ProofTerms = {}): Intent => ({
  ...BASE,
  kind: Kind.AttestedResult,
  status: IntentStatus.Open,
  escrowed: terms.amountIn ?? 100n,
  params: proofParams(terms),
  ...patch,
});

export const intentBytes = (intent: Intent): Uint8Array => Uint8Array.from(getIntentEncoder().encode(intent));

export const engineView = (data: Uint8Array): AccountView => ({ owner: INTENT_ENGINE_PROGRAM_ADDRESS, data, lamports: 1n });

export const clockView = (now: bigint): AccountView => {
  const data = new Uint8Array(40);
  new DataView(data.buffer).setBigInt64(32, now, true);
  return { owner: OWNER, data, lamports: 1n };
};

const tag = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);

export const createdEvent = (intent: Address, owner: Address): Uint8Array =>
  tag(
    getIntentCreatedEventEncoder().encode({
      intent,
      owner,
      nonce: 0n,
      kind: Kind.AttestedResult,
      inputMint: MINT,
      outputMint: MINT,
      receiver: owner,
      escrowed: 100n,
      expiresAt: 1_000n,
      rentPayer: owner,
      flags: 0,
      bounty: 0,
      createFee: 0,
    }),
  );

export const cancelledEvent = (intent: Address, owner: Address): Uint8Array => tag(getIntentCancelledEventEncoder().encode({ intent, owner, refunded: 0n }));

export const tx = (seed: string, patch: Partial<EngineTransaction> = {}): EngineTransaction => ({
  signature: testSignature(seed),
  slot: 1n,
  blockTime: null,
  failed: false,
  emitted: [],
  ...patch,
});
