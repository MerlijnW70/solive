import type { Address } from "@solana/kit";
import type { EncryptionKeyError } from "./encryption-key.js";
import type { NotInvited, SealedError } from "./sealed.js";
import type { AccountVersionError } from "./versions.js";

const BRAND: unique symbol = Symbol.for("@intent-engine/sdk-error");

export interface SdkErrors {
  "invalid-input": InvalidInput;
  "intent-core-error": IntentCoreError;
  "encryption-key-error": EncryptionKeyError;
  "sealed-error": SealedError;
  "not-invited": NotInvited;
  "account-version-error": AccountVersionError;
  "not-an-engine-account": NotAnEngineAccount;
  "no-signature": NoSignature;
}

export type SdkErrorCode = keyof SdkErrors;

export type AnySdkError = SdkErrors[SdkErrorCode];

export abstract class SdkError extends Error {
  abstract readonly code: SdkErrorCode;
  readonly [BRAND] = true;
}

export function isSdkError(error: unknown): error is AnySdkError;
export function isSdkError<C extends SdkErrorCode>(error: unknown, code: C): error is SdkErrors[C];
export function isSdkError(error: unknown, code?: SdkErrorCode): boolean {
  if (!(error instanceof Error) || (error as { [BRAND]?: unknown })[BRAND] !== true) {
    return false;
  }
  return code === undefined || (error as SdkError).code === code;
}

export type InputRule = "range" | "length" | "format" | "conflict" | "duplicate" | "order" | "missing" | "unsupported";

export class InvalidInput extends SdkError {
  readonly code = "invalid-input";
  override readonly name = "InvalidInput";
  readonly field: string;
  readonly rule: InputRule;

  constructor(field: string, rule: InputRule, message: string, options?: ErrorOptions) {
    super(message, options);
    this.field = field;
    this.rule = rule;
  }
}

export class NotAnEngineAccount extends SdkError {
  readonly code = "not-an-engine-account";
  override readonly name = "NotAnEngineAccount";
  readonly address: Address | null;

  constructor(address: Address | null, message: string) {
    super(message);
    this.address = address;
  }
}

export class NoSignature extends SdkError {
  readonly code = "no-signature";
  override readonly name = "NoSignature";
  readonly signer: Address;

  constructor(signer: Address) {
    super(`${signer} returned no signature for the message`);
    this.signer = signer;
  }
}

export const CORE_ERROR_CODES = [
  "Overflow",
  "DivideByZero",
  "Truncated",
  "NonCanonical",
  "UnknownKind",
  "UnknownStatus",
  "InvalidParams",
  "AmountMismatch",
  "InsufficientOutput",
  "InvalidTransition",
  "IntentExpired",
  "NotExpired",
  "NonceUsed",
  "NonceOutOfWindow",
  "NonceRegression",
  "SigProgram",
  "SigHeader",
  "SigPubkey",
  "SigMessage",
  "KindMismatch",
  "ResultOutOfBounds",
  "FlashEndProgram",
  "FlashEndDiscriminator",
  "FlashEndIntent",
  "ExtTooLong",
  "ExtMalformed",
  "ExtUnknown",
  "FlagsUnknown",
  "PartnerFeeTooHigh",
  "MandateInvalid",
  "MandateExpired",
  "MandateKind",
  "MandateTtl",
  "MandateCap",
  "MandateBudget",
  "MandateCount",
  "MandatePrice",
  "CommitteeInvalid",
  "CommitteeSigners",
  "ClaimTerms",
  "ClaimHeld",
  "ProfileInvalid",
  "ClaimCooldown",
  "LineWaiting",
  "LineEmpty",
  "JobNotHeld",
  "ClaimListInvalid",
  "ClaimListIncomplete",
  "NotListed",
  "BlobMalformed",
  "AnnouncementState",
  "AnnouncementOpen",
  "AnnouncementRetained",
  "RefuteNotEarlier",
  "RefuteSamePayee",
  "SplitCountMismatch",
] as const;

export type CoreErrorCode = (typeof CORE_ERROR_CODES)[number];

export class IntentCoreError extends SdkError {
  readonly code = "intent-core-error";
  override readonly name = "IntentCoreError";
  readonly engineError: CoreErrorCode;

  constructor(engineError: CoreErrorCode) {
    super(engineError);
    this.engineError = engineError;
  }
}
