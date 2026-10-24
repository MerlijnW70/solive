import type { Address, TransactionSigner } from "@solana/kit";
import { type Config, getSetCommitteeFloorInstruction } from "../generated/client/index.js";
import { events } from "./builder-accounts.js";
import { U64_MAX } from "./math.js";
import { InvalidInput } from "./errors.js";

export const MAX_COMMITTEE_FLOORS = 8;
export const FLOOR_THRESHOLD = 2;

export type CommitteeFloor = { mint: Address; floor: bigint };

type Floors = Pick<Config, "floorMints" | "floorAmounts">;

export function committeeFloors(config: Floors): CommitteeFloor[] {
  return config.floorMints.flatMap((mint, i) => {
    const floor = config.floorAmounts[i] ?? 0n;
    return floor === 0n ? [] : [{ mint, floor }];
  });
}

export function committeeFloorOf(config: Floors, mint: Address): bigint {
  return committeeFloors(config).find((entry) => entry.mint === mint)?.floor ?? 0n;
}

export function needsCommittee(floor: bigint, escrow: bigint): boolean {
  return floor !== 0n && escrow >= floor;
}

export function countsAsCommittee(committee: { threshold: number } | null | undefined): boolean {
  return committee !== null && committee !== undefined && committee.threshold >= FLOOR_THRESHOLD;
}

export async function buildSetCommitteeFloor(input: { admin: TransactionSigner; mint: Address; floor: bigint }) {
  if (input.floor < 0n || input.floor > U64_MAX) {
    throw new InvalidInput("floor", "range", "the committee floor must be zero, meaning none, or a raw amount");
  }
  return getSetCommitteeFloorInstruction({ admin: input.admin, mint: input.mint, floor: input.floor, ...(await events()) });
}
