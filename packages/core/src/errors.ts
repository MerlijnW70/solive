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
] as const;

export type CoreErrorCode = (typeof CORE_ERROR_CODES)[number];

export class IntentCoreError extends Error {
  readonly code: CoreErrorCode;

  constructor(code: CoreErrorCode) {
    super(code);
    this.name = "IntentCoreError";
    this.code = code;
  }
}
