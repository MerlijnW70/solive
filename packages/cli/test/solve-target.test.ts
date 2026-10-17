import { generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import type { Transport } from "@intent-engine/client";
import { parse, UsageError } from "../src/args.js";
import { MAX_PATIENCE, PATIENCE_NEEDS_TARGET, targetBelowFloor, targetWithoutFloor } from "../src/command-builders.js";
import type { Runtime } from "../src/runtime.js";
import { type SolveCommand, solverOptions } from "../src/solve-commands.js";

const MINT_A = "So11111111111111111111111111111111111111112";
const MINT_B = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SOLVE = ["solve", "--keypair", "k", "--jupiter", "https://" + "q.example", "--min-profit", `${MINT_A}=10,${MINT_B}=1`];

function usage(argv: string[]): string {
  try {
    parse(argv, {});
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    return (error as Error).message;
  }
  throw new Error(`parsed ${argv.join(" ")}`);
}

describe("solve --target-profit and --patience", () => {
  it("is off unless asked for", () => {
    const plain = parse(SOLVE, {});
    expect(plain).not.toHaveProperty("target");
    expect(plain).not.toHaveProperty("patience");
    expect(plain).toMatchObject({ minProfit: new Map([[MINT_A, 10n], [MINT_B, 1n]]) });
  });

  it("parses targets with the syntax of --min-profit and an optional patience", () => {
    expect(parse([...SOLVE, "--target-profit", `${MINT_A}=500, ${MINT_B}=1`], {})).toMatchObject({
      target: new Map([[MINT_A, 500n], [MINT_B, 1n]]),
    });
    expect(parse([...SOLVE, "--target-profit", `${MINT_A}=10`], {})).not.toHaveProperty("patience");
    expect(parse([...SOLVE, "--target-profit", `${MINT_A}=10`, "--patience", "0"], {})).toMatchObject({ patience: 0 });
    expect(MAX_PATIENCE).toBe(3_600);
    expect(parse([...SOLVE, "--target-profit", `${MINT_A}=10`, "--patience", "3600"], {})).toMatchObject({ patience: 3_600 });
    expect(parse([...SOLVE, `--target-profit=${MINT_A}=10`, "--patience=45"], {})).toMatchObject({ patience: 45 });
  });

  it("refuses a target below its floor, for a mint with no floor, or written wrong", () => {
    expect(usage([...SOLVE, "--target-profit", `${MINT_A}=9`])).toBe(targetBelowFloor(MINT_A, 9n, 10n));
    expect(targetBelowFloor(MINT_A, 9n, 10n)).toBe(`--target-profit for ${MINT_A} is 9, below its --min-profit of 10`);
    const other = "11111111111111111111111111111112";
    expect(usage([...SOLVE, "--target-profit", `${other}=50`])).toBe(targetWithoutFloor(other));
    expect(targetWithoutFloor(other)).toContain(other);
    expect(usage([...SOLVE, "--target-profit", "50"])).toBe("--target-profit takes mint=amount pairs separated by commas");
    expect(usage([...SOLVE, "--target-profit", `${MINT_A}=5,${MINT_A}=50`])).toBe(`--target-profit names ${MINT_A} twice`);
    expect(usage([...SOLVE, "--target-profit", `${MINT_A}=-5`])).toContain("--target-profit must be an integer from 0");
    expect(usage([...SOLVE, "--target-profit", "nope=5"])).toBe("--target-profit is not a base58 address");
  });

  it("refuses a patience without a target or outside 0 to 3600 seconds", () => {
    expect(usage([...SOLVE, "--patience", "30"])).toBe(PATIENCE_NEEDS_TARGET);
    expect(PATIENCE_NEEDS_TARGET).toBe("--patience needs --target-profit");
    for (const bad of ["3601", "1.5", "x", ""]) {
      expect(usage([...SOLVE, "--target-profit", `${MINT_A}=10`, "--patience", bad])).toBe(
        "--patience must be an integer from 0 to 3600",
      );
    }
    expect(usage([...SOLVE, "--target-profit", `${MINT_A}=10`, "--patience=-1"])).toBe("--patience must be an integer from 0 to 3600");
    expect(usage(["crank", "--keypair", "k", "--patience", "30"])).toBe("crank does not take --patience");
    expect(usage(["crank", "--keypair", "k", "--target-profit", `${MINT_A}=10`])).toBe("crank does not take --target-profit");
  });

  it("hands the target and patience to the solver's strategy", async () => {
    const signer = await generateKeyPairSigner();
    const runtime = { loadSigner: async () => signer, env: {}, fetch: async () => new Response("{}"), entropy: () => 0 } as unknown as Runtime;
    const strategyOf = async (flags: string[]) =>
      (await solverOptions(parse([...SOLVE, ...flags], {}) as SolveCommand, runtime, {} as Transport)).strategy;
    expect(await strategyOf([])).toEqual({ minProfit: new Map([[MINT_A, 10n], [MINT_B, 1n]]), maxFeeBps: 100 });
    expect(await strategyOf(["--target-profit", `${MINT_A}=40`, "--patience", "12"])).toEqual({
      minProfit: new Map([[MINT_A, 10n], [MINT_B, 1n]]),
      maxFeeBps: 100,
      target: new Map([[MINT_A, 40n]]),
      patience: 12,
    });
    expect(await strategyOf(["--target-profit", `${MINT_A}=40`])).not.toHaveProperty("patience");
  });
});
