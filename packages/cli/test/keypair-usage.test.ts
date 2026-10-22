import { describe, expect, it } from "vitest";
import { parse, SHAPES, usageOf } from "../src/args.js";
import { defaultWallet, settingsPath, withSettings, type Files } from "../src/wallet.js";

const HOME = "/home/user";
const SAVED = defaultWallet(HOME);
const MINT_A = "So11111111111111111111111111111111111111112";
const MINT_B = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

const saved = (): Files => ({
  home: HOME,
  readText: async (path: string) => {
    if (path !== settingsPath(HOME)) {
      throw new Error("missing");
    }
    return JSON.stringify({ url: "https://api.devnet.solana.com", keypair: SAVED });
  },
  saveText: async () => {},
  loadSigner: async () => {
    throw new Error("unused");
  },
  loadKeypair: async () => {
    throw new Error("unused");
  },
});

describe("--keypair in usage", () => {
  it("is optional everywhere but the relayer key of signed submit", () => {
    const required = Object.entries(SHAPES).flatMap(([verb, shape]) =>
      [...shape.matchAll(/(\[|\| )?--keypair <([^>]*)>/g)].filter(([, bracket]) => bracket === undefined).map(([, , what]) => `${verb}: ${what}`),
    );
    expect(required).toEqual(["signed: relayer file"]);
  });

  it("shows create and cancel without a required key file", () => {
    expect(usageOf("cancel").usage).toBe("cancel [--keypair <file>] --nonce <n> [--close] [--yes]");
    expect(usageOf("create").usage).toMatch(/^create swap\|limit\|dutch\|attested \[--keypair <file>\] --input-mint/);
  });

  it("is filled from the wallet setup saved when it is not given", async () => {
    const env = await withSettings(saved(), {});
    expect(parse(["cancel", "--nonce", "1"], env)).toMatchObject({ keypair: SAVED });
    expect(
      parse(["create", "swap", "--input-mint", MINT_A, "--output-mint", MINT_B, "--expires-in", "60", "--amount-in", "1", "--min-out", "1"], env),
    ).toMatchObject({ keypair: SAVED });
    expect(parse(["cancel", "--nonce", "1", "--keypair", "other.json"], env)).toMatchObject({ keypair: "other.json" });
    expect(() => parse(["signed", "submit", "--file", "s.json"], env)).toThrow("missing --keypair");
  });
});
