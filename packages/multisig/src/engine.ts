import { type Instruction, isSignerRole } from "@solana/kit";
import { IntentEngineInstruction, parseIntentEngineInstruction } from "@intent-engine/core";

type Parsable = Parameters<typeof parseIntentEngineInstruction>[0];

export const jsonText = (value: unknown, indent = 0): string =>
  JSON.stringify(value, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Array.from(v) : v), indent);

export function engineSummary(ix: Instruction): string {
  const accounts = ix.accounts ?? [];
  const data = ix.data ?? new Uint8Array();
  const signers = [...new Set(accounts.filter((k) => isSignerRole(k.role)).map((k) => k.address))];
  const by = `signed by ${signers.join(", ") || "nobody"}`;
  try {
    const parsed = parseIntentEngineInstruction({ programAddress: ix.programAddress, accounts, data: new Uint8Array(data) } as unknown as Parsable);
    const name = (IntentEngineInstruction as Record<number, string>)[parsed.instructionType] ?? String(parsed.instructionType);
    const fields = "data" in parsed ? (parsed.data as Record<string, unknown>) : {};
    const args = Object.fromEntries(Object.entries(fields).filter(([key]) => key !== "discriminator"));
    return `Intent engine ${name} ${jsonText(args)}, ${by}`;
  } catch {
    return `Intent engine instruction that this version cannot decode (${data.length} bytes of data), ${by}`;
  }
}
