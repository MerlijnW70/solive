import { type Address, getAddressDecoder, getBase58Decoder, getBase64Decoder } from "@solana/kit";
import { attestedResult, DEVNET_TEST_MINT, IntentStatus, Kind, NATIVE_MINT } from "@intent-engine/core";
import {
  encodeParams,
  EVENT_IX_TAG,
  getCommitteeAttestedEventEncoder,
  getCreateIntentInstructionDataEncoder,
  getDeliveryAnnouncedEventEncoder,
  getDeliveryReleasedEventEncoder,
  getIntentAttestedEventEncoder,
  getIntentCancelledEventEncoder,
  getIntentCreatedEventEncoder,
  getIntentEncoder,
  getIntentExpiredEventEncoder,
  getIntentFilledEventEncoder,
  getIntentSplitEventEncoder,
  getJobClaimedEventEncoder,
  getProfileSetEventEncoder,
  getShareHeldEventEncoder,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  INTENT_VERSION,
} from "@intent-engine/core/internal";

export const addressOf = (seed: number): Address => getAddressDecoder().decode(new Uint8Array(32).fill(seed));

export const signatureOf = (seed: number): string => getBase58Decoder().decode(new Uint8Array(64).fill(seed));

export const OWNER = addressOf(11);
export const WORKER = addressOf(12);
export const JUDGE = addressOf(13);
export const SOLVER = addressOf(14);
export const COMMITTEE = addressOf(15);
export const HOUSE_WALLET = addressOf(16);
export const FEE_PAYER = addressOf(17);
export const FIZZBUZZ_HASH = "638375b5fb917437e51237bfcbcf690bdb583eeac4ee2d07bd8e39e9d921ae70";
export const CUSTOM_HASH = "ab".repeat(32);

const ZERO = addressOf(0);
const tagged = (body: ArrayLike<number>): Uint8Array => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);
const hexBytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));

export const created = (intent: Address, owner: Address, escrowed: bigint, mint: Address = NATIVE_MINT, nonce = 0n): Uint8Array =>
  tagged(
    getIntentCreatedEventEncoder().encode({
      intent,
      owner,
      nonce,
      kind: Kind.AttestedResult,
      inputMint: mint,
      outputMint: mint,
      receiver: owner,
      escrowed,
      expiresAt: 4_000_000_000n,
      rentPayer: owner,
      flags: 0,
      bounty: 0,
      createFee: 0,
    }),
  );

export const paramsOf = (attestor: Address, specHash: string, amountIn: bigint): Uint8Array =>
  encodeParams(attestedResult({ amountIn, minResult: 0n, maxResult: 1n, attestor, specHash: hexBytes(specHash), judgeFee: 0n }));

export const createCall = (attestor: Address, specHash: string, amountIn: bigint, nonce = 0n): Uint8Array =>
  Uint8Array.from(
    getCreateIntentInstructionDataEncoder().encode({
      args: { nonce, kind: Kind.AttestedResult, flags: 0, params: paramsOf(attestor, specHash, amountIn), expiresAt: 4_000_000_000n, ext: new Uint8Array(), maxCreateFee: 0, maxBounty: 0 },
    }),
  );

export const claimed = (intent: Address, worker: Address, stake: bigint): Uint8Array =>
  tagged(getJobClaimedEventEncoder().encode({ intent, worker, until: 0n, stake }));

export const announced = (intent: Address, worker: Address, attestor: Address): Uint8Array =>
  tagged(
    getDeliveryAnnouncedEventEncoder().encode({
      intent,
      announcement: addressOf(40),
      seq: 0n,
      worker,
      payer: worker,
      attestor,
      commitment: new Uint8Array(32).fill(7),
      slot: 1n,
      recipients: 0,
    }),
  );

export const released = (intent: Address, worker: Address, attestor: Address): Uint8Array =>
  tagged(
    getDeliveryReleasedEventEncoder().encode({
      intent,
      announcement: addressOf(40),
      seq: 0n,
      worker,
      attestor,
      delivered: new Uint8Array(32),
      salt: new Uint8Array(32),
      splitHash: new Uint8Array(32),
    }),
  );

export const attested = (intent: Address, owner: Address, payee: Address, attestor: Address, net: bigint): Uint8Array =>
  tagged(
    getIntentAttestedEventEncoder().encode({
      intent,
      owner,
      solver: payee,
      payee,
      attestor,
      amountIn: net,
      result: 1n,
      fee: 0n,
      net,
      filled: net,
      remaining: 0n,
      partnerFee: 0n,
    }),
  );

export const split = (intent: Address, owner: Address, solver: Address, attestor: Address, net: bigint): Uint8Array =>
  tagged(
    getIntentSplitEventEncoder().encode({ intent, owner, solver, attestor, amountIn: net, result: 1n, fee: 0n, net, partnerFee: 0n, recipients: 2, splitHash: new Uint8Array(32) }),
  );

export const held = (intent: Address, wallet: Address, share: bigint): Uint8Array =>
  tagged(getShareHeldEventEncoder().encode({ intent, announcement: addressOf(40), wallet, account: addressOf(41), index: 0, share }));

export const committeeAttested = (intent: Address, signers: Address[]): Uint8Array =>
  tagged(getCommitteeAttestedEventEncoder().encode({ intent, committee: COMMITTEE, signers }));

export const profileSet = (wallet: Address, text: string): Uint8Array =>
  tagged(getProfileSetEventEncoder().encode({ wallet, skills: [text], endpoint: text, docUrl: text, docHash: new Uint8Array(32), encryptionKey: new Uint8Array(32) }));

export const cancelled =(intent: Address, owner: Address, refunded: bigint): Uint8Array => tagged(getIntentCancelledEventEncoder().encode({ intent, owner, refunded }));

export const expired = (intent: Address, owner: Address, refunded: bigint): Uint8Array =>
  tagged(getIntentExpiredEventEncoder().encode({ intent, owner, refunded, refundTo: owner, by: SOLVER, bounty: 0 }));

export const filled = (intent: Address, owner: Address, solver: Address, amountIn: bigint): Uint8Array =>
  tagged(
    getIntentFilledEventEncoder().encode({
      intent,
      owner,
      solver,
      receiver: owner,
      solverInput: solver,
      amountIn,
      delivered: amountIn,
      required: amountIn,
      fee: 0n,
      net: amountIn,
      filled: amountIn,
      remaining: 0n,
      partnerFee: 0n,
    }),
  );

export const intentData = (owner: Address, attestor: Address, specHash: string, escrowed: bigint, mint: Address = DEVNET_TEST_MINT): string =>
  getBase64Decoder().decode(
    getIntentEncoder().encode({
      owner,
      inputMint: mint,
      outputMint: mint,
      receiver: owner,
      nonce: 0n,
      escrowed,
      createdAt: 1n,
      expiresAt: 4_000_000_000n,
      kind: Kind.AttestedResult,
      status: IntentStatus.Open,
      bump: 255,
      vaultBump: 255,
      version: INTENT_VERSION,
      held: 0,
      flags: 0,
      params: paramsOf(attestor, specHash, escrowed),
      rentPayer: owner,
      filled: 0n,
      revision: 0,
      partnerBps: 0,
      partnerCutBps: 0,
      inFlight: 0n,
      partner: ZERO,
      bounty: 0,
      mandate: ZERO,
      feeBps: 0,
      gap: new Uint8Array(2),
      mandateSerial: 0n,
      agentFee: 0n,
      claims: 0,
      gap2: new Uint8Array(7),
      capped: 0n,
    }),
  );

export type Tx = {
  signature: string;
  slot: number;
  blockTime: number;
  events: Uint8Array[];
  calls?: { data: Uint8Array; accounts: Address[] }[];
  logs?: string[];
  memo?: string;
  mints?: Address[];
};

export function transactionJson(tx: Tx): unknown {
  const keys: string[] = [FEE_PAYER];
  const index = (key: string): number => {
    const at = keys.indexOf(key);
    if (at !== -1) {
      return at;
    }
    keys.push(key);
    return keys.length - 1;
  };
  const program = index(INTENT_ENGINE_PROGRAM_ADDRESS);
  const b58 = (bytes: Uint8Array) => getBase58Decoder().decode(bytes);
  const instructions = (tx.calls ?? []).map((call) => ({ programIdIndex: program, accounts: call.accounts.map(index), data: b58(call.data) }));
  if (tx.memo !== undefined) {
    instructions.push({ programIdIndex: index("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), accounts: [0], data: b58(new TextEncoder().encode(tx.memo)) });
  }
  const balances = (tx.mints ?? []).map((mint, i) => ({ accountIndex: index(addressOf(60 + i)), mint, owner: OWNER, uiTokenAmount: { amount: "0", decimals: 9, uiAmount: 0, uiAmountString: "0" } }));
  return {
    slot: tx.slot,
    blockTime: tx.blockTime,
    transaction: {
      signatures: [tx.signature],
      message: { accountKeys: keys, header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 }, instructions, recentBlockhash: b58(new Uint8Array(32)) },
    },
    meta: {
      err: null,
      fee: 5000,
      logMessages: tx.logs ?? [],
      innerInstructions: [{ index: 0, instructions: tx.events.map((data) => ({ programIdIndex: program, accounts: [], data: b58(data), stackHeight: 2 })) }],
      preBalances: keys.map(() => 0),
      postBalances: keys.map(() => 0),
      preTokenBalances: balances,
      postTokenBalances: balances,
      loadedAddresses: { writable: [], readonly: [] },
    },
    version: 0,
  };
}
