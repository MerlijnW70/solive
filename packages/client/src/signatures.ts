import { isSignature, type Signature } from "@solana/kit";
import { InvalidInput, SdkError } from "@intent-engine/core";

export function isTransactionSignature(value: unknown): value is Signature {
  if (typeof value !== "string") {
    return false;
  }
  try {
    return isSignature(value);
  } catch {
    return false;
  }
}

export class NotASignature extends SdkError {
  readonly code = "not-a-signature";
  override readonly name = "NotASignature";
  readonly method: string;

  constructor(method: string) {
    super(`the RPC node answered ${method} with a value that is not a transaction signature`);
    this.method = method;
  }
}

export function nodeSignature(value: unknown, method: string): Signature {
  if (!isTransactionSignature(value)) {
    throw new NotASignature(method);
  }
  return value;
}

export function askedSignature(value: string, field = "signature"): Signature {
  if (!isTransactionSignature(value)) {
    throw new InvalidInput(field, "format", `${field} is not a transaction signature: base58 that decodes to 64 bytes`);
  }
  return value;
}
