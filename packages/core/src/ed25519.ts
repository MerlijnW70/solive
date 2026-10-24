import type { Address, Instruction, MessagePartialSigner } from "@solana/kit";
import { compareKeys, concat, key, u16le } from "./bytes.js";
import { COSIGN_KEYS_AT, MAX_COSIGNERS } from "./sig.js";

export const ED25519_PROGRAM_ADDRESS =
  "Ed25519SigVerify111111111111111111111111111" as Address<"Ed25519SigVerify111111111111111111111111111">;

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
  signer: MessagePartialSigner,
  message: Uint8Array,
): Promise<Instruction> {
  const [signed] = await signer.signMessages([{ content: message, signatures: {} }]);
  const signature = signed?.[signer.address];
  if (signature === undefined) {
    throw new RangeError(`${signer.address} returned no signature for the message`);
  }
  return buildEd25519Instruction({ publicKey: signer.address, signature: new Uint8Array(signature), message });
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

export function buildEd25519CosignInstruction(input: {
  entries: { publicKey: Address; signature: Uint8Array }[];
  message: Uint8Array;
}): Instruction {
  const listed = input.message[COSIGN_KEYS_AT - 1] ?? 0;
  const slots = Array.from({ length: listed }, (_, i) => input.message.slice(COSIGN_KEYS_AT + 32 * i, COSIGN_KEYS_AT + 32 * (i + 1)));
  const entries = [...input.entries].sort((a, b) => compareKeys(key(a.publicKey), key(b.publicKey)));
  const m = entries.length;
  if (m === 0 || m > MAX_COSIGNERS) {
    throw new RangeError(`a cosign batch holds 1 to ${MAX_COSIGNERS} signers, got ${m}`);
  }
  const len = input.message.length;
  if (len > 0xffff) {
    throw new RangeError(`an Ed25519 message of ${len} bytes does not fit the instruction header`);
  }
  const sigsAt = 2 + 14 * m;
  const messageAt = sigsAt + 64 * m;
  const parts: ArrayLike<number>[] = [new Uint8Array([m, 0])];
  const seen = new Set<Address>();
  entries.forEach((e, k) => {
    if (e.signature.length !== 64) {
      throw new RangeError("an Ed25519 signature is 64 bytes");
    }
    if (seen.has(e.publicKey)) {
      throw new RangeError(`${e.publicKey} signs a cosign batch twice`);
    }
    seen.add(e.publicKey);
    const slot = slots.findIndex((s) => compareKeys(s, key(e.publicKey)) === 0);
    if (slot < 0) {
      throw new RangeError(`${e.publicKey} is not listed in the cosign envelope`);
    }
    parts.push(
      concat(
        [u16le(sigsAt + 64 * k), u16le(0xffff), u16le(messageAt + COSIGN_KEYS_AT + 32 * slot), u16le(0xffff), u16le(messageAt), u16le(len), u16le(0xffff)],
        14,
      ),
    );
  });
  for (const e of entries) {
    parts.push(e.signature);
  }
  parts.push(input.message);
  return {
    programAddress: ED25519_PROGRAM_ADDRESS,
    data: concat(parts, messageAt + len),
  };
}
