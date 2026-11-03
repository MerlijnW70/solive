import { getBase58Decoder } from "@solana/kit";
import type { EngineAccountFilter } from "./rpc-shapes.js";
import { matchBytes } from "./intent-filters.js";

export const NODE_FILTER_LIMIT = 4;

export type ProgramFilter = { dataSize: bigint } | { memcmp: { offset: bigint; bytes: string; encoding: "base58" } };

type Piece = { offset: number; bytes: Uint8Array; rank: number };

export type FilterPlan = { filters: ProgramFilter[]; holds(data: Uint8Array): boolean };

const memcmp = (offset: number, bytes: Uint8Array): ProgramFilter => ({
  memcmp: { offset: BigInt(offset), bytes: getBase58Decoder().decode(bytes), encoding: "base58" },
});

const contains = (data: Uint8Array, { offset, bytes }: Piece): boolean =>
  data.length >= offset + bytes.length && bytes.every((byte, i) => data[offset + i] === byte);

function joinedAdjacent(pieces: readonly Piece[]): Piece[] {
  const joined: Piece[] = [];
  for (const piece of [...pieces].sort((a, b) => a.offset - b.offset)) {
    const last = joined[joined.length - 1];
    if (last !== undefined && last.offset + last.bytes.length === piece.offset) {
      joined[joined.length - 1] = { offset: last.offset, bytes: Uint8Array.from([...last.bytes, ...piece.bytes]), rank: Math.min(last.rank, piece.rank) };
    } else {
      joined.push(piece);
    }
  }
  return joined;
}

export function planFilters(filter?: EngineAccountFilter, preferred: readonly number[] = []): FilterPlan {
  if (filter === undefined) {
    return { filters: [], holds: () => true };
  }
  const rankOf = (offset: number): number => {
    const at = preferred.indexOf(offset);
    return at >= 0 ? at : preferred.length + offset;
  };
  const room = NODE_FILTER_LIMIT - 1 - (filter.dataSize === undefined ? 0 : 1);
  const pieces: Piece[] = (filter.match ?? []).map((match) => ({ offset: match.offset, bytes: matchBytes(match), rank: rankOf(match.offset) }));
  const fitting = pieces.length <= room;
  const joined = fitting ? pieces : joinedAdjacent(pieces);
  const chosen = fitting
    ? joined
    : [...joined]
        .sort((a, b) => b.bytes.length - a.bytes.length || a.rank - b.rank)
        .slice(0, Math.max(room, 0))
        .sort((a, b) => a.offset - b.offset);
  const unsent = fitting ? [] : joined.filter((piece) => !chosen.includes(piece));
  return {
    filters: [
      ...(filter.dataSize === undefined ? [] : [{ dataSize: BigInt(filter.dataSize) }]),
      memcmp(0, Uint8Array.from(filter.discriminator)),
      ...chosen.map(({ offset, bytes }) => memcmp(offset, bytes)),
    ],
    holds: (data) => unsent.every((piece) => contains(data, piece)),
  };
}
