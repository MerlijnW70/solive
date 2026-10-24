import type { Address, MessagePartialSigner } from "@solana/kit";
import { INTENT_ENGINE_PROGRAM_ADDRESS } from "../generated/client/index.js";
import { ascii, compareKeys, concat, i64le, key, sized, u16le, u32le, u64le } from "./bytes.js";
import { checkFlags, EXT_MAX_LEN, FILL_EXT_TAGS, partnerOf, validateExt } from "./ext.js";
import { PARAMS_LEN } from "./kinds.js";

export const INTENT_TAG = ascii("intent-engine-v1");
export const ATTEST_TAG = ascii("intent-engine-at");
export const ATTEST_PROOF_TAG = ascii("intent-engine-pf");
export const ATTEST_SPLIT_TAG = ascii("intent-engine-sp");
export const ATTEST_DELIVERY_TAG = ascii("intent-engine-dl");
export const ATTEST_SPLIT_DELIVERY_TAG = ascii("intent-engine-sd");
export const SPLIT_COSIGN_TAG = ascii("intent-engine-split-cosigner\0\0\0\0");
export const OFFCHAIN_PREFIX = new Uint8Array([0xff, ...ascii("solana offchain")]);
export const PREIMAGE_LEN = 448;
export const ENVELOPE_LEN = 114;
export const ATTEST_PREIMAGE_LEN = 206;
export const ATTEST_PROOF_PREIMAGE_LEN = 238;
export const ATTEST_SPLIT_PREIMAGE_LEN = 238;
export const ATTEST_DELIVERY_PREIMAGE_LEN = 326;
export const ATTEST_SPLIT_DELIVERY_PREIMAGE_LEN = 326;
export const MAX_COSIGNERS = 16;
export const COSIGN_KEYS_AT = 18;

function kindWord(kind: number, flags: number): number[] {
  if (!Number.isInteger(kind) || kind < 0 || kind > 255) {
    throw new RangeError(`${kind} is not a kind byte`);
  }
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xffff) {
    throw new RangeError(`${flags} is not a u16 flag set`);
  }
  return [kind, flags & 0xff, flags >> 8, 0, 0, 0, 0, 0];
}

export type SignedIntentFields = {
  domain: Uint8Array;
  owner: Address;
  ownerInput: Address;
  inputMint: Address;
  outputMint: Address;
  receiver: Address;
  nonce: bigint;
  expiresAt: bigint;
  submitBy: bigint;
  kind: number;
  params: Uint8Array;
  epoch: bigint;
  relayerFee?: bigint;
  flags?: number;
  ext?: Uint8Array;
  program?: Address;
};

export async function signedIntentPreimage(f: SignedIntentFields): Promise<Uint8Array> {
  if (f.domain.length !== 32 || f.params.length !== PARAMS_LEN) {
    throw new RangeError("domain must be 32 bytes and params 128 bytes");
  }
  const ext = f.ext ?? new Uint8Array();
  if (ext.length > EXT_MAX_LEN) {
    throw new RangeError(`ext must be at most ${EXT_MAX_LEN} bytes`);
  }
  const word = kindWord(f.kind, f.flags ?? 0);
  const epoch = u64le(f.epoch);
  const extHash = await sha256(ext);
  return concat(
    [
      INTENT_TAG,
      key(f.program ?? INTENT_ENGINE_PROGRAM_ADDRESS),
      f.domain,
      key(f.owner),
      key(f.ownerInput),
      key(f.inputMint),
      key(f.outputMint),
      key(f.receiver),
      u64le(f.nonce),
      i64le(f.expiresAt),
      i64le(f.submitBy),
      word,
      f.params,
      epoch,
      extHash,
      u64le(f.relayerFee ?? 0n),
    ],
    PREIMAGE_LEN,
  );
}

const hexOf = (digest: Uint8Array) => ascii(Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(""));

export function offchainEnvelope(signer: Address, digest: Uint8Array): Uint8Array {
  return concat([OFFCHAIN_PREFIX, [1, 1], key(signer), hexOf(digest)], ENVELOPE_LEN);
}

export function cosignerSet(keys: readonly Address[]): Address[] {
  if (keys.length === 0 || keys.length > MAX_COSIGNERS) {
    throw new RangeError(`a cosigned release lists 1 to ${MAX_COSIGNERS} keys, got ${keys.length}`);
  }
  return [...new Set(keys)].sort((a, b) => compareKeys(key(a), key(b)));
}

export function cosignEnvelope(keys: readonly Address[], digest: Uint8Array): Uint8Array {
  if (digest.length !== 32) {
    throw new RangeError(`a cosign digest is 32 bytes, got ${digest.length}`);
  }
  const listed = cosignerSet(keys);
  return concat([OFFCHAIN_PREFIX, [1, listed.length], ...listed.map(key), hexOf(digest)], COSIGN_KEYS_AT + 32 * listed.length + 64);
}

export function splitCosignEnvelope(digest: Uint8Array, cosigners: readonly Address[]): Uint8Array {
  return cosignEnvelope(cosigners, digest);
}

export async function signMessageBytes(signer: MessagePartialSigner, message: Uint8Array): Promise<Uint8Array> {
  const [signed] = await signer.signMessages([{ content: message, signatures: {} }]);
  const signature = signed?.[signer.address];
  if (signature === undefined) {
    throw new Error(`${signer.address} returned no signature for the message`);
  }
  return new Uint8Array(signature);
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice()));
}

export function checkSignable(f: SignedIntentFields): SignedIntentFields {
  checkFlags(f.flags ?? 0);
  partnerOf(f.ext ?? new Uint8Array());
  return f;
}

export async function signedIntentMessage(f: SignedIntentFields): Promise<Uint8Array> {
  return offchainEnvelope(f.owner, await sha256(await signedIntentPreimage(checkSignable(f))));
}

export type AttestedFillFields = {
  domain: Uint8Array;
  intent: Address;
  payee: Address;
  amountIn: bigint;
  result: bigint;
  filled?: bigint;
  revision?: number;
  maxFeeBps: number;
  ext?: Uint8Array;
  program?: Address;
};

export async function attestedFillPreimage(f: AttestedFillFields): Promise<Uint8Array> {
  if (f.domain.length !== 32) {
    throw new RangeError("domain must be 32 bytes");
  }
  const ext = f.ext ?? new Uint8Array();
  if (ext.length > EXT_MAX_LEN) {
    throw new RangeError(`ext must be at most ${EXT_MAX_LEN} bytes`);
  }
  const head = [
    ATTEST_TAG,
    key(f.program ?? INTENT_ENGINE_PROGRAM_ADDRESS),
    f.domain,
    key(f.intent),
    key(f.payee),
    u64le(f.amountIn),
    u64le(f.result),
    u64le(f.filled ?? 0n),
    u32le(f.revision ?? 0),
    u16le(f.maxFeeBps),
  ];
  return concat(
    [...head, await sha256(ext)],
    ATTEST_PREIMAGE_LEN,
  );
}

export async function attestedFillMessage(
  attestor: Address,
  f: AttestedFillFields,
): Promise<Uint8Array> {
  validateExt(f.ext ?? new Uint8Array(), FILL_EXT_TAGS);
  return offchainEnvelope(attestor, await sha256(await attestedFillPreimage(f)));
}

export type AttestedProofFields = AttestedFillFields & {
  specHash: Uint8Array;
};

export async function attestedProofPreimage(f: AttestedProofFields): Promise<Uint8Array> {
  if (f.specHash.length !== 32) {
    throw new RangeError("specHash must be 32 bytes");
  }
  if (f.domain.length !== 32) {
    throw new RangeError("domain must be 32 bytes");
  }
  const ext = f.ext ?? new Uint8Array();
  if (ext.length > EXT_MAX_LEN) {
    throw new RangeError(`ext must be at most ${EXT_MAX_LEN} bytes`);
  }
  const head = [
    ATTEST_PROOF_TAG,
    key(f.program ?? INTENT_ENGINE_PROGRAM_ADDRESS),
    f.domain,
    key(f.intent),
    key(f.payee),
    u64le(f.amountIn),
    u64le(f.result),
    u64le(f.filled ?? 0n),
    u32le(f.revision ?? 0),
    u16le(f.maxFeeBps),
  ];
  return concat(
    [...head, await sha256(ext), f.specHash],
    ATTEST_PROOF_PREIMAGE_LEN,
  );
}

export async function splitCommit(
  recipients: Address[],
  weights: number[],
): Promise<Uint8Array> {
  if (recipients.length !== weights.length) {
    throw new RangeError("recipients and weights must have equal length");
  }
  const parts: ArrayLike<number>[] = [];
  for (const [i, recipient] of recipients.entries()) {
    const weight = weights[i];
    if (weight === undefined) {
      throw new RangeError("recipients and weights must have equal length");
    }
    parts.push(key(recipient));
    parts.push(u16le(weight));
  }
  return sha256(concat(parts, recipients.length * 34));
}

export type AttestedSplitFields = Omit<AttestedFillFields, "payee"> & {
  specHash: Uint8Array;
  splitHash: Uint8Array;
};

export async function attestedSplitPreimage(f: AttestedSplitFields): Promise<Uint8Array> {
  if (f.domain.length !== 32) {
    throw new RangeError("domain must be 32 bytes");
  }
  if (f.specHash.length !== 32) {
    throw new RangeError("specHash must be 32 bytes");
  }
  if (f.splitHash.length !== 32) {
    throw new RangeError("splitHash must be 32 bytes");
  }
  const ext = f.ext ?? new Uint8Array();
  if (ext.length > EXT_MAX_LEN) {
    throw new RangeError(`ext must be at most ${EXT_MAX_LEN} bytes`);
  }
  const head = [
    ATTEST_SPLIT_TAG,
    key(f.program ?? INTENT_ENGINE_PROGRAM_ADDRESS),
    f.domain,
    key(f.intent),
    u64le(f.amountIn),
    u64le(f.result),
    u64le(f.filled ?? 0n),
    u32le(f.revision ?? 0),
    u16le(f.maxFeeBps),
  ];
  return concat(
    [...head, await sha256(ext), f.specHash, f.splitHash],
    ATTEST_SPLIT_PREIMAGE_LEN,
  );
}

export type AttestedDeliveryFields = Omit<AttestedFillFields, "ext"> & {
  extHash: Uint8Array;
  specHash: Uint8Array;
  announcement: Address;
  seq: bigint;
  delivered: Uint8Array;
  salt: Uint8Array;
};

export type AttestedSplitDeliveryFields = Omit<AttestedDeliveryFields, "payee"> & { splitHash: Uint8Array };

export function attestedDeliveryPreimage(f: AttestedDeliveryFields): Uint8Array {
  return concat(
    [
      ATTEST_DELIVERY_TAG,
      key(f.program ?? INTENT_ENGINE_PROGRAM_ADDRESS),
      sized("domain", f.domain, 32),
      key(f.intent),
      key(f.payee),
      u64le(f.amountIn),
      u64le(f.result),
      u64le(f.filled ?? 0n),
      u32le(f.revision ?? 0),
      u16le(f.maxFeeBps),
      sized("extHash", f.extHash, 32),
      sized("specHash", f.specHash, 32),
      key(f.announcement),
      u64le(f.seq),
      sized("delivered", f.delivered, 32),
      sized("salt", f.salt, 16),
    ],
    ATTEST_DELIVERY_PREIMAGE_LEN,
  );
}

export function attestedSplitDeliveryPreimage(f: AttestedSplitDeliveryFields): Uint8Array {
  return concat(
    [
      ATTEST_SPLIT_DELIVERY_TAG,
      key(f.program ?? INTENT_ENGINE_PROGRAM_ADDRESS),
      sized("domain", f.domain, 32),
      key(f.intent),
      u64le(f.amountIn),
      u64le(f.result),
      u64le(f.filled ?? 0n),
      u32le(f.revision ?? 0),
      u16le(f.maxFeeBps),
      sized("extHash", f.extHash, 32),
      sized("specHash", f.specHash, 32),
      sized("splitHash", f.splitHash, 32),
      key(f.announcement),
      u64le(f.seq),
      sized("delivered", f.delivered, 32),
      sized("salt", f.salt, 16),
    ],
    ATTEST_SPLIT_DELIVERY_PREIMAGE_LEN,
  );
}

export type AttestedDeliveryTerms = Omit<AttestedDeliveryFields, "extHash"> & { ext?: Uint8Array };

export type AttestedSplitDeliveryTerms = Omit<AttestedSplitDeliveryFields, "extHash"> & { ext?: Uint8Array };

export async function settleExtHash(ext?: Uint8Array): Promise<Uint8Array> {
  return sha256(validateExt(ext ?? new Uint8Array(), FILL_EXT_TAGS));
}

export async function attestedDeliveryFields(f: AttestedDeliveryTerms): Promise<AttestedDeliveryFields> {
  const { ext, ...rest } = f;
  return { ...rest, extHash: await settleExtHash(ext) };
}

export async function attestedSplitDeliveryFields(f: AttestedSplitDeliveryTerms): Promise<AttestedSplitDeliveryFields> {
  const { ext, ...rest } = f;
  return { ...rest, extHash: await settleExtHash(ext) };
}

export async function attestedProofMessage(attestor: Address, f: AttestedDeliveryTerms): Promise<Uint8Array> {
  return offchainEnvelope(attestor, await sha256(attestedDeliveryPreimage(await attestedDeliveryFields(f))));
}

export async function attestedSplitDigest(f: AttestedSplitDeliveryTerms): Promise<Uint8Array> {
  const preimage = attestedSplitDeliveryPreimage(await attestedSplitDeliveryFields(f));
  return sha256(concat([SPLIT_COSIGN_TAG, preimage], SPLIT_COSIGN_TAG.length + preimage.length));
}

export async function attestedSplitMessage(f: AttestedSplitDeliveryTerms, cosigners: readonly Address[]): Promise<Uint8Array> {
  return cosignEnvelope(cosigners, await attestedSplitDigest(f));
}
