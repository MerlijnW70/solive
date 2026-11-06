import { isSolanaError, SOLANA_ERROR__TRANSACTION__SIGNATURES_MISSING } from "@solana/kit";

export const EXIT_REFUSED = 78;

export const EXIT_RETRY = 75;

export const EXIT_SENT = 76;

export class JudgeRefused extends Error {
  readonly exitCode: number = EXIT_REFUSED;

  constructor(reason: string) {
    super(reason);
    this.name = "JudgeRefused";
  }
}

export class JudgeDeferred extends JudgeRefused {
  constructor(reason: string) {
    super(reason);
    this.name = "JudgeDeferred";
  }
}

export class JudgeUnreadable extends JudgeDeferred {
  override readonly exitCode: number = EXIT_RETRY;

  constructor(reason: string) {
    super(reason);
    this.name = "JudgeUnreadable";
  }
}

export const unreadableSkipped = (tries: number, last: string): string =>
  `the work or its spec could not be read ${tries} times, so this watch does not fetch it again; this is not a verdict on the work. The last: ${last}`;

export class ReleaseUncertain extends Error {
  readonly exitCode: number = EXIT_SENT;

  constructor(reason: string, cause?: unknown) {
    super(reason, { cause });
    this.name = "ReleaseUncertain";
  }
}

export const sendUnconfirmed = (intent: string, signature: string | undefined, reason: string): string =>
  `the check passed and the release was signed and handed to the RPC node${signature === undefined ? "" : ` in ${signature}`}, but the send was not confirmed (${reason}), so the release may have landed. Read intent ${intent} before judging it again; no verdict was written`;

export const verdictUnwritten = (intent: string, signature: string, path: string, reason: string): string =>
  `the check passed and the release was sent and confirmed in ${signature}, but the verdict could not be written to ${path} (${reason}); read intent ${intent} to see the payment`;

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const sendFailure = (handed: boolean, intent: string, signature: string | undefined, error: unknown): unknown =>
  handed && !isSolanaError(error, SOLANA_ERROR__TRANSACTION__SIGNATURES_MISSING) ? new ReleaseUncertain(sendUnconfirmed(intent, signature, reasonOf(error)), error) : error;

export const failedSend = (error: unknown): string => reasonOf(error instanceof ReleaseUncertain ? error.cause : error);

export const INFRA_NEXT = "nothing was signed or paid and no verdict was written; this is not a verdict on the work, so fix the cause if needed and run the judge again";

export class JudgeInfraError extends JudgeDeferred {
  override readonly exitCode: number = EXIT_RETRY;

  constructor(reason: string) {
    super(`infrastructure error, not a verdict: ${reason}; ${INFRA_NEXT}`);
    this.name = "JudgeInfraError";
  }
}

export const infraSkipped = (runs: number, last: string): string =>
  `the check stopped on an infrastructure error ${runs} times, so this watch does not run it again; this is not a verdict on the work. The last: ${last}`;

export const timedOutInfra = (seconds: number): string => `the check did not finish within --timeout ${seconds} seconds, so it was stopped and removed`;

export const oomInfra = (memory: string): string =>
  `the check's container was killed with signal 9, as the kernel does when it uses all of its ${memory} memory; raise --sandbox-memory if the check needs more`;

export const oomInfraUnpinned = (memory: string): string =>
  `the check's container was killed with signal 9, as the kernel does when it uses all of its ${memory} memory; the spec's judge-run block pins no memory, so the check ran with the judge's default ${memory}, and a different --sandbox-memory is refused: the check gets more only if the spec's author pins memory in that block`;

export class JudgeInterrupted extends Error {
  readonly exitCode: number;

  constructor(signal: InterruptSignal, reason?: string) {
    super(reason ?? `the check was interrupted by ${signal}; nothing was paid and no verdict was written`);
    this.name = "JudgeInterrupted";
    this.exitCode = SIGNAL_EXIT[signal];
  }
}

export const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143 } as const;

export type InterruptSignal = keyof typeof SIGNAL_EXIT;
