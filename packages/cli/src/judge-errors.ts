export class JudgeRefused extends Error {
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
  constructor(reason: string) {
    super(reason);
    this.name = "JudgeUnreadable";
  }
}

export const unreadableSkipped = (tries: number, last: string): string =>
  `the work or its spec could not be read ${tries} times, so this watch does not fetch it again; this is not a verdict on the work. The last: ${last}`;

export const EXIT_RETRY = 75;

export const INFRA_NEXT = "nothing was signed or paid and no verdict was written; this is not a verdict on the work, so fix the cause if needed and run the judge again";

export class JudgeInfraError extends JudgeDeferred {
  readonly exitCode = EXIT_RETRY;

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
