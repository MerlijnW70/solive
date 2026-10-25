import { expect } from "vitest";
import { parse, UsageError } from "../src/args.js";

export const OWNER = "11111111111111111111111111111112";
export const MINT_A = "So11111111111111111111111111111111111111112";
export const MINT_B = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export function usage(argv: string[], env: Record<string, string> = {}): string {
  try {
    parse(argv, env);
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    return (error as Error).message;
  }
  throw new Error(`parsed ${argv.join(" ")}`);
}
