import type { Address } from "@solana/kit";
import type { DeliveryOpener } from "@intent-engine/core";
import { type FirstOpeningRefused, isSdkError, type Transport } from "@intent-engine/client";
import { type FirstOpeningOutcome, firstOpeningIn } from "@intent-engine/client/internal";
import { type OwnDelivery, ownDelivery } from "./delivery-record.js";
import { EXIT_RETRY, JudgeDeferred } from "./judge-errors.js";
import type { Runtime } from "./runtime.js";
import { ANNOUNCE_POLL } from "./announce-wait.js";

export { ANNOUNCE_POLL, ANNOUNCE_WAIT, MAX_ANNOUNCE_WAIT } from "./announce-wait.js";

export class AnnouncementPending extends JudgeDeferred {
  override readonly exitCode: number = EXIT_RETRY;

  constructor(reason: string) {
    super(reason);
    this.name = "AnnouncementPending";
  }
}

export const waitedFor = (seconds: number): string => `waited ${seconds} seconds for an announcement of this work; --announce-wait sets how long`;

export const ownPending = (own: OwnDelivery, seconds: number): string =>
  `this machine's deliver confirmed announcement ${own.announcement} (seq ${own.seq}, signature ${own.signature ?? "unknown"}) of the work ${own.sha256} to intent ${own.intent}, but the RPC node did not list it within ${seconds} seconds; nothing was run or paid; run judge again in a few seconds`;

const pendingRefusal = (refusal: FirstOpeningRefused): boolean => refusal.reason === "nothing-opens" || (refusal.reason === "incomplete" && !refusal.closed);

const pending = (outcome: FirstOpeningOutcome): boolean => isSdkError(outcome.opening, "first-opening-refused") && pendingRefusal(outcome.opening);

export type WaitedOpening = FirstOpeningOutcome & { waited: number; own: OwnDelivery | null };

type OpeningInput = { intent: Address; sha256: string; keypair: DeliveryOpener[] };

export async function openingAfterWait(
  transport: Transport,
  runtime: Pick<Runtime, "home" | "readText" | "sleep">,
  input: OpeningInput,
  wait: number,
  stop?: AbortSignal,
): Promise<WaitedOpening> {
  let outcome = await firstOpeningIn(transport, input);
  let waited = 0;
  while (pending(outcome) && waited < wait) {
    const step = Math.min(ANNOUNCE_POLL, wait - waited);
    if (!(await runtime.sleep(step, stop))) {
      break;
    }
    waited += step;
    outcome = await firstOpeningIn(transport, input);
  }
  const own = pending(outcome) ? await ownDelivery(runtime, input.intent, input.sha256) : null;
  return { ...outcome, waited, own };
}

export function waitedRefusal(refusal: FirstOpeningRefused, opening: WaitedOpening, text: string): JudgeDeferred {
  if (!pendingRefusal(refusal)) {
    return new JudgeDeferred(text);
  }
  if (opening.own !== null) {
    return new AnnouncementPending(ownPending(opening.own, opening.waited));
  }
  return new JudgeDeferred(`${text}; ${waitedFor(opening.waited)}`);
}
