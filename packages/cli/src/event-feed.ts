import { decodeEvent } from "@intent-engine/core";
import { RECONNECT_MS, type Transport } from "@intent-engine/client";
import type { Runtime } from "./runtime.js";

type EngineEvents = { signature: string; slot: bigint; blockTime: bigint | null; failed: boolean; events: object[] };

export async function engineEvents(transport: Transport, limit: number): Promise<EngineEvents[]> {
  return (await transport.engineTransactions(limit)).map((tx) => ({
    signature: tx.signature,
    slot: tx.slot,
    blockTime: tx.blockTime,
    failed: tx.failed,
    events: tx.failed ? [] : tx.emitted.map(decodeEvent).filter((e) => e !== null),
  }));
}

export const followGap = (limit: number) =>
  `more than ${limit} engine transactions landed since the last poll, so some were not shown; raise --limit or lower --interval`;

export async function follow(
  transport: Transport,
  runtime: Runtime,
  limit: number,
  interval: number,
  emit: (value: object) => void,
): Promise<number> {
  let seen = new Set<string>();
  let shown = 0;
  let failures = 0;
  for (;;) {
    let fetched: EngineEvents[];
    try {
      fetched = await engineEvents(transport, limit);
    } catch (error) {
      const retry = (RECONNECT_MS[Math.min(failures, RECONNECT_MS.length - 1)] ?? 0) / 1000;
      failures++;
      emit({ error: error instanceof Error ? error.message : String(error), retry_in: retry });
      if (!(await runtime.sleep(retry))) {
        return shown;
      }
      continue;
    }
    failures = 0;
    const fresh = fetched.filter((tx) => !seen.has(tx.signature)).reverse();
    if (seen.size > 0 && fetched.length >= limit && fresh.length === fetched.length) {
      emit({ gap: true, warning: followGap(limit) });
    }
    for (const tx of fresh) {
      emit(tx);
      shown++;
    }
    seen = new Set(fetched.map((tx) => tx.signature));
    if (!(await runtime.sleep(interval))) {
      return shown;
    }
  }
}
