import type { Address, Signature } from "@solana/kit";
import { SdkError } from "@intent-engine/core";
import { INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core/internal";
import { ENGINE_ERRORS, type EngineError } from "./errors.js";

export class MaybeSent extends SdkError {
  readonly code = "maybe-sent";
  override readonly name = "MaybeSent";
  readonly signature: Signature;
  readonly lastValidBlockHeight: bigint | null;

  constructor(signature: Signature, lastValidBlockHeight: bigint | null, message: string, options?: ErrorOptions) {
    super(message, options);
    this.signature = signature;
    this.lastValidBlockHeight = lastValidBlockHeight;
  }
}

export type Failure = { signature: Signature; err: unknown; program: Address | null; logs?: readonly string[]; engine?: EngineError };

export class FailedOnChain extends SdkError {
  readonly code = "failed-on-chain";
  override readonly name = "FailedOnChain";
  readonly signature: Signature;
  readonly err: unknown;
  readonly program: Address | null;
  declare readonly logs?: readonly string[];
  declare readonly engine?: EngineError;

  constructor(message: string, failure: Failure) {
    super(message);
    this.signature = failure.signature;
    this.err = failure.err;
    this.program = failure.program;
    if (failure.logs !== undefined) {
      this.logs = failure.logs;
    }
    if (failure.engine !== undefined) {
      this.engine = failure.engine;
    }
  }
}

export class BlockhashExpired extends SdkError {
  readonly code = "blockhash-expired";
  override readonly name = "BlockhashExpired";
}

export class BehindMinSlot extends SdkError {
  readonly code = "behind-min-slot";
  override readonly name = "BehindMinSlot";
  readonly slot: bigint;
  readonly minContextSlot: bigint;

  constructor(slot: bigint, minContextSlot: bigint) {
    super(`Minimum context slot has not been reached: the node read at slot ${slot}, below ${minContextSlot}`);
    this.slot = slot;
    this.minContextSlot = minContextSlot;
  }
}

export type SubscriptionEnd = "ended" | "no-result";

export class SubscriptionEnded extends SdkError {
  readonly code = "subscription-ended";
  override readonly name = "SubscriptionEnded";
  readonly signature: Signature;
  readonly reason: SubscriptionEnd;

  constructor(signature: Signature, reason: SubscriptionEnd) {
    super(
      reason === "ended"
        ? `the signature subscription for ${signature} ended without a notification`
        : `the signature notification for ${signature} carries no result`,
    );
    this.signature = signature;
    this.reason = reason;
  }
}

const FAILED = /^Program (\w{32,44}) failed: (.*)$/;
const CUSTOM = /^custom program error: 0x([0-9a-f]+)$/i;

function failingIn(logs: readonly string[]): { program: Address; code: number | null } | null {
  for (const line of logs) {
    const failed = FAILED.exec(line);
    if (failed !== null) {
      const custom = CUSTOM.exec(failed[2] ?? "");
      return { program: failed[1] as Address, code: custom === null ? null : Number.parseInt(custom[1] ?? "", 16) };
    }
  }
  return null;
}

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : typeof value === "bigint" ? Number(value) : null;

function instructionError(err: unknown): { index: number; detail: unknown } | null {
  const failed = (err as { InstructionError?: unknown } | null)?.InstructionError;
  if (!Array.isArray(failed)) {
    return null;
  }
  const index = asNumber(failed[0]);
  return index === null ? null : { index, detail: failed[1] };
}

const customOf = (detail: unknown): number | null => asNumber((detail as { Custom?: unknown } | null)?.Custom);

export function failure(signature: Signature, err: unknown, logs?: readonly string[], programs: readonly Address[] = []): Failure {
  const failing = logs === undefined ? null : failingIn(logs);
  const instruction = instructionError(err);
  const program = failing?.program ?? (instruction === null ? null : (programs[instruction.index] ?? null));
  const code = failing !== null ? failing.code : instruction === null ? null : customOf(instruction.detail);
  const engine = program === INTENT_ENGINE_PROGRAM_ADDRESS && code !== null ? ENGINE_ERRORS.get(code) : undefined;
  return { signature, err, program, ...(logs === undefined ? {} : { logs: [...logs] }), ...(engine === undefined ? {} : { engine }) };
}

export type SendStatus =
  | { status: "confirmed"; signature: Signature; slot?: bigint }
  | ({ status: "failed" } & Failure)
  | { status: "expired"; signature: Signature }
  | { status: "pending"; signature: Signature };
