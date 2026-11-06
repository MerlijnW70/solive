import type { Address } from "@solana/kit";
import { writeReceipt } from "../src/judge-receipt.js";
import { CURRENT_PINS } from "../src/receipt-gate.js";
import { HOME } from "./harness-state.js";
import { transport } from "./harness-transport.js";

export type Judged = { owner: Address; nonce: bigint; intent: Address; specSha256: string; deliveredSha256: string; announcement: Address };

export async function judgedBy(judges: readonly Address[], at: Judged, home: string = HOME): Promise<void> {
  const cluster = await transport.genesisHash();
  for (const judge of judges) {
    await writeReceipt(home, { ...at, judge, cluster, outcome: "pass", route: { sandbox: "viper", command: "viper", engine: CURRENT_PINS } });
  }
}
