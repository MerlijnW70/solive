import { getBase58Encoder } from "@solana/kit";
import { INTENT_ENGINE_PROGRAM_ADDRESS } from "../generated/client/index.js";
import { decodeEvent, type EngineEvent } from "./events.js";

export type EventPosition = { instruction: number; inner: number };

export type PositionedEvent = EngineEvent & EventPosition;

export type JsonInstruction = { programIdIndex: number; data: string };

export type JsonTransaction = {
  transaction: { message: { accountKeys: readonly string[] } };
  meta?: {
    err?: unknown;
    innerInstructions?: readonly { index: number; instructions: readonly JsonInstruction[] }[] | null;
    loadedAddresses?: { writable: readonly string[]; readonly: readonly string[] } | null;
  } | null;
};

export function transactionEvents(tx: JsonTransaction | null | undefined): PositionedEvent[] {
  if (tx === null || tx === undefined || (tx.meta?.err !== undefined && tx.meta.err !== null)) {
    return [];
  }
  const keys = [...tx.transaction.message.accountKeys, ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
  return (tx.meta?.innerInstructions ?? []).flatMap((group) =>
    group.instructions.flatMap((ix, inner) => {
      if (keys[ix.programIdIndex] !== INTENT_ENGINE_PROGRAM_ADDRESS) {
        return [];
      }
      let data: Uint8Array;
      try {
        data = Uint8Array.from(getBase58Encoder().encode(ix.data));
      } catch {
        return [];
      }
      const event = decodeEvent(data);
      return event === null ? [] : [{ ...event, instruction: Number(group.index), inner }];
    }),
  );
}
