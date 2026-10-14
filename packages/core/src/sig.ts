import {
  type Address,
  getAddressEncoder,
  type Instruction,
  type KeyPairSigner,
  signBytes,
} from "@solana/kit";
import { INTENT_ENGINE_PROGRAM_ADDRESS } from "../generated/client/index.js";
import { checkFlags, EXT_MAX_LEN, FILL_EXT_TAGS, partnerOf, validateExt } from "./ext.js";
import { I64_MAX, I64_MIN, PARAMS_LEN } from "./kinds.js";
import { U64_MAX } from "./math.js";

export const ED25519_PROGRAM_ADDRESS =
  "Ed25519SigVerify111111111111111111111111111" as Address<"Ed25519SigVerify111111111111111111111111111">;

const ascii = (s: string) => new TextEncoder().encode(s);
export const INTENT_TAG = ascii("intent-engine-v1");
export const ATTEST_TAG = ascii("intent-engine-at");
export const ATTEST_PROOF_TAG = ascii("intent-engine-pf");
export const ATTEST_SPLIT_TAG = ascii("intent-engine-sp");
export const SPLIT_COSIGN_TAG = ascii("intent-engine-split-cosigner\0\0\0\0");
export const OFFCHAIN_PREFIX = new Uint8Array([0xff, ...ascii("solana offchain")]);
export const PREIMAGE_LEN = 448;
export const ENVELOPE_LEN = 114;
export const ATTEST_PREIMAGE_LEN = 206;
export const ATTEST_PROOF_PREIMAGE_LEN = 238;
export const ATTEST_SPLIT_PREIMAGE_LEN = 238;

const key = (a: Address) => getAddressEncoder().encode(a);

function u64le(v: bigint): Uint8Array {
  if (v < 0n || v > U64_MAX) {
    throw new RangeError(`${v} is outside u64`);
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
}

function i64le(v: bigint): Uint8Array {
  if (v < I64_MIN || v > I64_MAX) {
    throw new RangeError(`${v} is outside i64`);
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, v, true);
  return out;
}

function u32le(v: number): Uint8Array {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff_ffff) {
    throw new RangeError(`${v} is outside u32`);
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, v, true);
  return out;
}

function u16le(v: number): Uint8Array {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff) {
    throw new RangeError(`${v} is outside u16`);
  }
  return Uint8Array.of(v & 0xff, v >> 8);
}

function kindWord(kind: number, flags: number): number[] {
  if (!Number.isInteger(kind) || kind < 0 || kind > 255) {
    throw new RangeError(`${kind} is not a kind byte`);
  }
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xffff) {
    throw new RangeError(`${flags} is not a u16 flag set`);
  }
  return [kind, flags & 0xff, flags >> 8, 0, 0, 0, 0, 0];
}

function concat(parts: ArrayLike<number>[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  if (at !== length) {
    throw new RangeError(`expected ${length} bytes, built ${at}`);
  }
  return out;
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

export function offchainEnvelope(signer: Address, digest: Uint8Array): Uint8Array {
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  return concat([OFFCHAIN_PREFIX, [1, 1], key(signer), ascii(hex)], ENVELOPE_LEN);
}

export function splitCosignEnvelope(digest: Uint8Array): Uint8Array {
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  return concat([OFFCHAIN_PREFIX, [1, 1], SPLIT_COSIGN_TAG, ascii(hex)], ENVELOPE_LEN);
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

export async function attestedProofMessage(
  attestor: Address,
  f: AttestedProofFields,
): Promise<Uint8Array> {
  validateExt(f.ext ?? new Uint8Array(), FILL_EXT_TAGS);
  return offchainEnvelope(attestor, await sha256(await attestedProofPreimage(f)));
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

export async function attestedSplitMessage(f: AttestedSplitFields): Promise<Uint8Array> {
  validateExt(f.ext ?? new Uint8Array(), FILL_EXT_TAGS);
  return splitCosignEnvelope(await sha256(await attestedSplitPreimage(f)));
}

export function ed25519Header(messageLength: number): Uint8Array {
  if (!Number.isInteger(messageLength) || messageLength < 0 || messageLength > 0xffff) {
    throw new RangeError(`an Ed25519 message of ${messageLength} bytes does not fit the instruction header`);
  }
  const out = new Uint8Array(16);
  const view = new DataView(out.buffer);
  out[0] = 1;
  [48, 0xffff, 16, 0xffff, 112, messageLength, 0xffff].forEach((v, i) => {
    view.setUint16(2 + i * 2, v, true);
  });
  return out;
}

export function buildEd25519Instruction(input: {
  publicKey: Address;
  signature: Uint8Array;
  message: Uint8Array;
}): Instruction {
  if (input.signature.length !== 64) {
    throw new RangeError("an Ed25519 signature is 64 bytes");
  }
  return {
    programAddress: ED25519_PROGRAM_ADDRESS,
    data: concat(
      [ed25519Header(input.message.length), key(input.publicKey), input.signature, input.message],
      112 + input.message.length,
    ),
  };
}

export async function signEd25519Instruction(
  signer: KeyPairSigner,
  message: Uint8Array,
): Promise<Instruction> {
  const signature = new Uint8Array(await signBytes(signer.keyPair.privateKey, message));
  return buildEd25519Instruction({ publicKey: signer.address, signature, message });
}

export const MAX_ED25519_BATCH = 255;

export function buildEd25519BatchInstruction(input: {
  entries: { publicKey: Address; signature: Uint8Array }[];
  message: Uint8Array;
}): Instruction {
  const m = input.entries.length;
  if (m === 0) {
    throw new RangeError("an Ed25519 batch needs at least one signer");
  }
  if (m > MAX_ED25519_BATCH) {
    throw new RangeError(`an Ed25519 batch holds at most ${MAX_ED25519_BATCH} signers, got ${m}`);
  }
  for (const e of input.entries) {
    if (e.signature.length !== 64) {
      throw new RangeError("an Ed25519 signature is 64 bytes");
    }
  }
  const len = input.message.length;
  if (len > 0xffff) {
    throw new RangeError(`an Ed25519 message of ${len} bytes does not fit the instruction header`);
  }
  const pubkeysAt = 2 + 14 * m;
  const sigsAt = pubkeysAt + 32 * m;
  const messageAt = sigsAt + 64 * m;
  const parts: ArrayLike<number>[] = [new Uint8Array([m, 0])];
  input.entries.forEach((_, k) => {
    parts.push(
      concat(
        [
          u16le(sigsAt + 64 * k),
          u16le(0xffff),
          u16le(pubkeysAt + 32 * k),
          u16le(0xffff),
          u16le(messageAt),
          u16le(len),
          u16le(0xffff),
        ],
        14,
      ),
    );
  });
  for (const e of input.entries) {
    parts.push(key(e.publicKey));
  }
  for (const e of input.entries) {
    parts.push(e.signature);
  }
  parts.push(input.message);
  return {
    programAddress: ED25519_PROGRAM_ADDRESS,
    data: concat(parts, messageAt + len),
  };
}
