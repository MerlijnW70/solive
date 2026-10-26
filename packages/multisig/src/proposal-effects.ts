import { type Address, type Instruction, isWritableRole } from "@solana/kit";
import { systemTransferSummary } from "./system-transfer.js";

export type Writers = ReadonlyMap<Address, readonly number[]>;

export type SetTarget = { account: Address; sets: "idl" | "code" };

const keepsData = (ix: Instruction) => systemTransferSummary(ix) !== null;

export function earlierWrites(instructions: readonly Instruction[]): Writers[] {
  const written = new Map<Address, number[]>();
  return instructions.map((ix, i) => {
    const before: Writers = new Map(Array.from(written, ([key, list]) => [key, [...list]]));
    if (!keepsData(ix)) {
      for (const meta of ix.accounts ?? []) {
        const list = written.get(meta.address) ?? [];
        if (isWritableRole(meta.role) && !list.includes(i + 1)) {
          written.set(meta.address, [...list, i + 1]);
        }
      }
    }
    return before;
  });
}

const positions = (writers: readonly number[]) =>
  writers.length === 1 ? `instruction ${writers[0]}` : `instructions ${writers.slice(0, -1).join(", ")} and ${writers[writers.length - 1]}`;

export const staleText = (writers: readonly number[]) =>
  `but ${positions(writers)} of the same proposal may write the buffer first, so that is the buffer before the transaction, not what this instruction reads`;

export const rewrittenText = (position: number, buffer: Address, writers: readonly number[], sets: "idl" | "code") =>
  `instruction ${position} ${sets === "idl" ? "sets the IDL" : "upgrades the program"} from buffer ${buffer}, which ${positions(writers)} of the same proposal may write first, so the buffer as it stands now is not what instruction ${position} reads and its hash proves nothing`;

export function uniqueTargets(targets: readonly SetTarget[]): SetTarget[] {
  const out: SetTarget[] = [];
  for (const target of targets) {
    if (!out.some((t) => t.account === target.account)) {
      out.push(target);
    }
  }
  return out;
}
