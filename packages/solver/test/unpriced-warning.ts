import type { Address } from "@solana/kit";
import { unpricedFloor } from "../src/index.js";

export const unpricedWarning = (mint: Address): string[] => [unpricedFloor(mint)];
