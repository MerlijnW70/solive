import { type Address } from "@solana/kit";

export const url = process.env["DEVNET_RPC"];
export const keypair = process.env["DEVNET_KEYPAIR"];
export const TOKEN_2022_PROGRAM_ADDRESS = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;
export const ESCROW = 400n;
export const MIN_OUT = 300n;
export const FUNDED = 4_000n;
export const RELAY_FEE = 3n;
export const AGENT_FEE = 2n;
export const PARTNER_BPS = 50;
export const PARTNERED = 40_000n;
