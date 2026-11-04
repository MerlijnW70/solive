import { formatAmount } from "@intent-engine/core";
import { stakeBelowRent as stakeBelowRentText } from "@intent-engine/core/internal";
import type { Transport } from "@intent-engine/client";
import { rentFor, rentRate } from "./agent/budget.js";

export const stakeBelowRent = (floor: bigint): string => `StakeBelowRent: ${stakeBelowRentText(`${formatAmount(floor, 9)} SOL`)}`;

export const claimFloor = async (transport: Transport): Promise<bigint> => rentFor(0, await rentRate(transport));
