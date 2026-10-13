import { U64_MAX } from "./math.js";

export const CONFIG_VERSION = 1;
export const USER_VERSION = 1;
export const INTENT_VERSION = 1;
export const PAUSE_CREATE = 1;
export const PAUSE_FILL = 2;
export const MAX_CREATE_FEE = 10_000_000;
export const MAX_CRANK_BOUNTY = 10_000_000;

export function remainingOf(intent: { escrowed: bigint; filled: bigint }): bigint {
  if (intent.filled > intent.escrowed) {
    throw new RangeError(`an intent cannot have filled ${intent.filled} of ${intent.escrowed}`);
  }
  return intent.escrowed - intent.filled;
}

export const IntentStatus = { Open: 0, Filled: 1, Cancelled: 2, Expired: 3, Filling: 4 } as const;

export type IntentStatusName = keyof typeof IntentStatus;

export function statusName(status: number): IntentStatusName | undefined {
  return (Object.keys(IntentStatus) as IntentStatusName[]).find((name) => IntentStatus[name] === status);
}

export type FeeConfig = { feeBps: number; kindFeeMask: number; kindFeeBps: readonly number[] };

export function feeBpsFor(config: FeeConfig, kind: number): number {
  if ((config.kindFeeMask & (1 << kind)) === 0) {
    return config.feeBps;
  }
  const bps = config.kindFeeBps.at(kind - 1);
  if (bps === undefined) {
    throw new RangeError(`no fee is configured for kind ${kind}`);
  }
  return bps;
}

export const NONCE_WINDOW_WORDS = 4;

export function nextFreeNonce(window: { nonceBase: bigint; nonceBitmap: readonly bigint[] }): bigint | null {
  if (window.nonceBitmap.length !== NONCE_WINDOW_WORDS) {
    throw new RangeError(`a nonce window has ${NONCE_WINDOW_WORDS} words, got ${window.nonceBitmap.length}`);
  }
  const word = window.nonceBitmap.findIndex((w) => w !== U64_MAX);
  if (word < 0) {
    return null;
  }
  let ones = 0n;
  for (let w = window.nonceBitmap[word] ?? 0n; (w & 1n) === 1n; w >>= 1n) {
    ones += 1n;
  }
  const next = window.nonceBase + BigInt(word) * 64n + ones;
  return next > U64_MAX ? null : next;
}
