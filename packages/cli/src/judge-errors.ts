export class JudgeRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "JudgeRefused";
  }
}

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
