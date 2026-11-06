import type { Signature, TransactionSigner } from "@solana/kit";
import type { LiteSVM } from "litesvm";
import type { Client, IntentRef } from "../src/index.js";
import { NOTICE_SECS } from "../src/internal.js";

export function passNotice(svm: LiteSVM, seconds: bigint = NOTICE_SECS): void {
  const clock = svm.getClock();
  clock.unixTimestamp += seconds;
  svm.setClock(clock);
}

export async function cancelAfterNotice(client: Client, svm: LiteSVM, owner: TransactionSigner, ref: IntentRef): Promise<Signature> {
  await client.requestCancel(owner, ref);
  passNotice(svm);
  return client.cancel(owner, ref);
}
