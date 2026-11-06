import { type IntentChanges, rateLimited } from "@intent-engine/client/internal";
import type { Clock } from "./wallet/guard.js";
import { elapsedOf } from "../monotonic.js";

export const WAIT_SLOW = 10;

export const WAIT_FALLBACK = 4;

export const WAIT_GAP = 2;

export const WAIT_BACKOFF_MAX = 20;

export async function waitForJobs(clock: Clock, within: number, read: () => Promise<boolean>, changes?: IntentChanges): Promise<number> {
  let listening = changes;
  const answered = { read: false };
  const limited: unknown[] = [];
  let delay = listening === undefined ? WAIT_FALLBACK : WAIT_SLOW;
  let waited = 0;
  const sleep = async (seconds: number): Promise<boolean> => {
    const slept = await clock.sleep(seconds);
    waited += seconds;
    return slept;
  };
  try {
    for (;;) {
      let done = false;
      try {
        done = await read();
        answered.read = true;
        delay = listening === undefined ? WAIT_FALLBACK : WAIT_SLOW;
      } catch (error) {
        if (!rateLimited(error)) {
          throw error;
        }
        limited.push(error);
        delay = Math.min(delay * 2, WAIT_BACKOFF_MAX);
      }
      if (done || waited >= within) {
        break;
      }
      const step = Math.min(delay, within - waited);
      if (listening === undefined) {
        if (!(await sleep(step))) {
          break;
        }
        continue;
      }
      const began = elapsedOf(clock);
      const heard = await listening.wait(step);
      if (heard === null) {
        listening = undefined;
        waited += step;
        continue;
      }
      if (heard.length === 0) {
        waited += step;
        continue;
      }
      const elapsed = Math.max(0, Math.floor((elapsedOf(clock) - began) / 1000));
      waited += elapsed;
      const rest = Math.min(WAIT_GAP - elapsed, within - waited);
      if (rest > 0 && !(await sleep(rest))) {
        break;
      }
    }
  } finally {
    changes?.close();
  }
  const [last] = limited.slice(-1);
  if (!answered.read && last !== undefined) {
    throw last;
  }
  return waited;
}
