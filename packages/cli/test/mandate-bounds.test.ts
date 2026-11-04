import { describe, expect, it } from "vitest";
import { MAX_EXPIRES_IN, MIN_EXPIRES_IN } from "../src/agent/create.js";
import { prepareMandate } from "../src/agent/mandate-grant.js";
import * as mandateState from "../src/agent/mandate-state.js";
import { MAX_MANDATE_INTENTS } from "../src/agent/mandate-state.js";
import { InvalidInput } from "../src/agent/schema.js";
import { parse } from "../src/args.js";
import { EXIT_USAGE, main } from "../src/main.js";
import { MINT_A, MINT_B, OWNER, usage } from "./args-kit.js";
import { runtime } from "./harness.js";

const grantArgs = (maxIntents: string, validFor = "3600") => [
  "mandate", "grant", "--keypair", "k", "--agent", OWNER, "--input-mint", MINT_A, "--output-mint", MINT_B, "--kinds", "swap",
  "--per-intent", "4", "--total", "8", "--max-intents", maxIntents, "--max-ttl", "600", "--valid-for", validFor, "--floor-out", "1", "--floor-in", "2", "--units", "raw",
];

const grantInput = (maxIntents: number, validFor = 3600) => ({
  owner: OWNER,
  agent: MINT_A,
  input_mint: MINT_A,
  output_mint: MINT_B,
  kinds: ["swap"],
  per_intent: "4",
  total: "8",
  max_intents: maxIntents,
  max_ttl: 600,
  valid_for: validFor,
  floor: { out: "1", in: "2" },
});

const cliTakes = (args: string[]): boolean => {
  try {
    parse(args);
    return true;
  } catch {
    return false;
  }
};

const mcpTakes = (input: object): boolean => {
  try {
    prepareMandate.input.read(input, "");
    return true;
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidInput);
    return false;
  }
};

describe("mandate grant bounds the CLI and the MCP schema share", () => {
  it("refuses --max-intents 0 as a usage error, as the MCP schema refuses max_intents 0", async () => {
    expect(usage(grantArgs("0"))).toBe(`--max-intents must be an integer from 1 to ${MAX_MANDATE_INTENTS}`);
    expect(await main(grantArgs("0"), runtime({}), { out: () => undefined, err: () => undefined })).toBe(EXIT_USAGE);
    expect(mcpTakes(grantInput(0))).toBe(false);
  });

  it("takes max intents from 1 to the same most in both", () => {
    for (const [count, taken] of [[0, false], [1, true], [MAX_MANDATE_INTENTS, true], [MAX_MANDATE_INTENTS + 1, false], [0xffff_ffff, false]] as const) {
      expect([count, cliTakes(grantArgs(String(count)))]).toEqual([count, taken]);
      expect([count, mcpTakes(grantInput(count))]).toEqual([count, taken]);
    }
    expect(usage(grantArgs(String(MAX_MANDATE_INTENTS + 1)))).toBe(`--max-intents must be an integer from 1 to ${MAX_MANDATE_INTENTS}`);
  });

  it("takes valid-for up to the one expiry bound in both", () => {
    for (const [seconds, taken] of [[MIN_EXPIRES_IN - 1, false], [MIN_EXPIRES_IN, true], [MAX_EXPIRES_IN, true], [MAX_EXPIRES_IN + 1, false]] as const) {
      expect([seconds, cliTakes(grantArgs("1", String(seconds)))]).toEqual([seconds, taken]);
      expect([seconds, mcpTakes(grantInput(1, seconds))]).toEqual([seconds, taken]);
    }
    expect(Object.keys(mandateState)).not.toContain("MAX_MANDATE_SECONDS");
  });
});
