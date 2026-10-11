export type CoreErrorCode =
  | "Overflow"
  | "DivideByZero"
  | "Truncated"
  | "NonCanonical"
  | "UnknownKind"
  | "UnknownStatus"
  | "InvalidParams"
  | "AmountMismatch"
  | "InsufficientOutput"
  | "InvalidTransition"
  | "IntentExpired"
  | "NotExpired"
  | "NonceUsed"
  | "NonceOutOfWindow"
  | "NonceRegression"
  | "SigProgram"
  | "SigHeader"
  | "SigPubkey"
  | "SigMessage"
  | "KindMismatch"
  | "ResultOutOfBounds"
  | "FlashEndProgram"
  | "FlashEndDiscriminator"
  | "FlashEndIntent"
  | "ExtTooLong"
  | "ExtMalformed"
  | "ExtUnknown"
  | "FlagsUnknown"
  | "PartnerFeeTooHigh";

export class IntentCoreError extends Error {
  readonly code: CoreErrorCode;

  constructor(code: CoreErrorCode) {
    super(code);
    this.name = "IntentCoreError";
    this.code = code;
  }
}
