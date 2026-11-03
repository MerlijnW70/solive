import type { Address, Base64EncodedWireTransaction, Blockhash } from "@solana/kit";
import type { FillContext } from "./build.js";
import type { Hold } from "./holds.js";
import type { Plan } from "./plan.js";
import type { Rent } from "./rent.js";
import type { Report } from "./types.js";

export type Outcome =
  | { kind: "filled" | "sent"; entry: Report["sent"][number] }
  | { kind: "skipped"; entry: Report["skipped"][number] }
  | { kind: "failed"; entry: Report["failed"][number] };

export type Ready = {
  plan: Plan;
  context: FillContext;
  tables: Record<Address, Address[]>;
  probe: Base64EncodedWireTransaction;
  latest: { blockhash: Blockhash; lastValidBlockHeight: bigint };
  solverInput: Address;
  solverOutput: Address;
};

export type Planned = Outcome | { kind: "ready"; ready: Ready };

export type Checked = { kind: "checked"; wire: Base64EncodedWireTransaction; entry: Omit<Report["sent"][number], "signature">; holds?: Hold; spend(): void };

export const skipped = (intent: Address, reason: string, rent?: bigint): Outcome => ({
  kind: "skipped",
  entry: { intent, reason, ...(rent === undefined ? {} : { rent }) },
});

export const failed = (intent: Address, error: string): Outcome => ({ kind: "failed", entry: { intent, error } });

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export type Caps = { cost: bigint; rent: bigint; rate: Rent };
