import type { TransactionInstruction } from "@solana/web3.js";
import { IntentEngineInstruction, parseIntentEngineInstruction } from "@intent-engine/core";

type Parsable = Parameters<typeof parseIntentEngineInstruction>[0];

const READONLY_SIGNER = 2;
const WRITABLE = 1;

export const jsonText = (value: unknown, indent = 0): string =>
  JSON.stringify(value, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Array.from(v) : v), indent);

export function engineSummary(ix: TransactionInstruction): string {
  const signers = ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58());
  const by = `signed by ${signers.join(", ") || "nobody"}`;
  const raw = {
    programAddress: ix.programId.toBase58(),
    accounts: ix.keys.map((k) => ({ address: k.pubkey.toBase58(), role: (k.isSigner ? READONLY_SIGNER : 0) | (k.isWritable ? WRITABLE : 0) })),
    data: new Uint8Array(ix.data),
  };
  try {
    const parsed = parseIntentEngineInstruction(raw as unknown as Parsable);
    const name = (IntentEngineInstruction as Record<number, string>)[parsed.instructionType] ?? String(parsed.instructionType);
    const data = "data" in parsed ? (parsed.data as Record<string, unknown>) : {};
    const args = Object.fromEntries(Object.entries(data).filter(([key]) => key !== "discriminator"));
    return `Intent engine ${name} ${jsonText(args)}, ${by}`;
  } catch {
    return `Intent engine instruction that this version cannot decode (${ix.data.length} bytes of data), ${by}`;
  }
}
