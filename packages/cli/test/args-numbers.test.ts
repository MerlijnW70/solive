import { describe, expect, it } from "vitest";
import { I64_MAX, I64_MIN, U64_MAX } from "@intent-engine/core/internal";
import { AUTO_PRICE_CAP } from "../src/compute.js";
import { DEFAULT_CONCURRENCY, DEFAULT_MAX_RENT, DEFAULT_MAX_SOL_COST, MAX_BUNDLE, MAX_CONCURRENCY } from "@intent-engine/solver";
import {
  BUNDLE_SIZE_NEEDS_JITO,
  DEFAULT_URL,
  WATCH_INTERVAL,
  ISSUE_ALONE,
  ISSUE_FORMAT,
  INVENTORY_ALONE,
  INVENTORY_FORMAT,
  ONE_MARKET,
  MAX_RENT_FORMAT,
  MAX_SOL_COST_FORMAT,
  solveFeeAboveCap,
  zeroProfit,
  parse,
  parseI64,
  parseU64,
  UsageError,
  usageOf,
  MANDATE_USE_KINDS,
} from "../src/args.js";
import { NATIVE_MINT } from "@intent-engine/core";
import { SOL_VALUE_FORMAT, SOL_VALUE_NATIVE } from "../src/command-builders.js";
import { MINT_A, MINT_B, OWNER, usage } from "./args-kit.js";

describe("numbers", () => {
  it("parses a solver run and refuses unsafe or incomplete endpoints", () => {
    expect(
      parse([
        "solve",
        "--keypair",
        "k",
        "--jupiter",
        "https://quote.example/swap/v1//",
        "--jito",
        "https://engine.example",
        "--tip",
        "10000",
        "--min-profit",
        `${MINT_A}=5`,
        "--max-fee-bps",
        "200",
        "--slippage-bps",
        "10000",
      ]),
    ).toEqual({
      name: "solve",
      url: DEFAULT_URL,
      priority: 0n,
      keypair: "k",
      jupiter: "https://quote.example/swap/v1",
      issue: [],
      inventory: [],
      jito: "https://engine.example",
      tipLamports: 10_000n,
      bundleSize: MAX_BUNDLE,
      minProfit: new Map([[MINT_A, 5n]]),
      maxFeeBps: 200,
      maxSolCost: DEFAULT_MAX_SOL_COST,
      maxRent: DEFAULT_MAX_RENT,
      slippageBps: 10_000,
      routeProgram: undefined,
      lookupTables: [],
      concurrency: DEFAULT_CONCURRENCY,
      watch: null,
    });
    const watching = ["solve", "--keypair", "k", "--jupiter", "https://q.example", "--min-profit", `${MINT_A}=1`];
    expect(parse([...watching, "--watch"])).toMatchObject({ watch: WATCH_INTERVAL });
    expect(parse([...watching, "--watch", "--interval", "2"])).toMatchObject({ watch: 2 });
    expect(usage([...watching, "--interval", "2"])).toBe("--interval needs --watch");
    expect(parse(["solve", "--keypair", "k", "--jupiter", "https://q.example", "--min-profit", `${MINT_A}=1`, "--lookup-table", `${OWNER}, ${MINT_A}`])).toMatchObject({
      lookupTables: [OWNER, MINT_A],
    });
    expect(usage(["solve", "--keypair", "k", "--jupiter", "https://q.example", "--min-profit", `${MINT_A}=1`, "--lookup-table", `${OWNER},,`])).toBe(
      "--lookup-table takes a comma list of addresses",
    );
    const issuing = ["solve", "--keypair", "k", "--min-profit", `${MINT_A}=1`, "--issue"];
    expect(parse([...issuing, `${MINT_A}:${OWNER}=200/1, ${OWNER}:${MINT_A}=1/3`])).toMatchObject({
      jupiter: undefined,
      issue: [
        { inputMint: MINT_A, outputMint: OWNER, out: 200n, in: 1n },
        { inputMint: OWNER, outputMint: MINT_A, out: 1n, in: 3n },
      ],
    });
    for (const bad of [`${MINT_A}:${OWNER}=200`, `${MINT_A}=200/1`, `${MINT_A}:${OWNER}=200/1/2`, `${MINT_A}:${OWNER}:${MINT_A}=1/1`, ""]) {
      expect(usage([...issuing, bad])).toBe(ISSUE_FORMAT);
    }
    expect(usage([...issuing, `${MINT_A}:${OWNER}=0/1`])).toBe("--issue rates must be positive on both sides");
    expect(usage([...issuing, `${MINT_A}:${OWNER}=1/0`])).toBe("--issue rates must be positive on both sides");
    expect(usage([...issuing, `${MINT_A}:${OWNER}=1/x`])).toMatch(/^--issue/);
    expect(usage([...issuing, `${MINT_A}:${OWNER}=1/1,${MINT_A}:${OWNER}=2/1`])).toBe(`--issue names ${MINT_A}:${OWNER} twice`);
    expect(usage([...issuing, `${MINT_A}:${OWNER}=1/1`, "--jupiter", "https://q.example"])).toBe(ONE_MARKET);
    expect(usage(["solve", "--keypair", "k", "--min-profit", `${MINT_A}=1`])).toBe(ONE_MARKET);
    expect(usage([...issuing, `${MINT_A}:${OWNER}=1/1`, "--slippage-bps", "10"])).toBe(ISSUE_ALONE);
    expect(usage([...issuing, `${MINT_A}:${OWNER}=1/1`, "--route-program", OWNER])).toBe(ISSUE_ALONE);
    const stocking = ["solve", "--keypair", "k", "--min-profit", `${MINT_A}=1`, "--inventory"];
    expect(parse([...stocking, `${MINT_A}:${OWNER}=200/1, ${OWNER}:${MINT_A}=1/3`])).toMatchObject({
      jupiter: undefined,
      issue: [],
      inventory: [
        { inputMint: MINT_A, outputMint: OWNER, out: 200n, in: 1n },
        { inputMint: OWNER, outputMint: MINT_A, out: 1n, in: 3n },
      ],
    });
    expect(parse([...stocking, `${MINT_A}:${OWNER}=2/1`, "--issue", `${MINT_A}:${OWNER}=1/1`])).toMatchObject({
      jupiter: undefined,
      issue: [{ inputMint: MINT_A, outputMint: OWNER, out: 1n, in: 1n }],
      inventory: [{ inputMint: MINT_A, outputMint: OWNER, out: 2n, in: 1n }],
    });
    expect(parse([...stocking, `${MINT_A}:${OWNER}=2/1`, "--jupiter", "https://q.example", "--slippage-bps", "10"])).toMatchObject({
      jupiter: "https://q.example",
      issue: [],
      inventory: [{ inputMint: MINT_A, outputMint: OWNER, out: 2n, in: 1n }],
      slippageBps: 10,
    });
    expect(parse([...issuing, `${MINT_A}:${OWNER}=1/1`])).toMatchObject({ inventory: [] });
    for (const bad of [`${MINT_A}:${OWNER}=200`, `${MINT_A}=200/1`, ""]) {
      expect(usage([...stocking, bad])).toBe(INVENTORY_FORMAT);
    }
    expect(usage([...stocking, `${MINT_A}:${OWNER}=0/1`])).toBe("--inventory rates must be positive on both sides");
    expect(usage([...stocking, `${MINT_A}:${OWNER}=1/1,${MINT_A}:${OWNER}=2/1`])).toBe(`--inventory names ${MINT_A}:${OWNER} twice`);
    expect(usage([...stocking, `${MINT_A}:${OWNER}=1/x`])).toMatch(/^--inventory/);
    expect(usage([...stocking, `${MINT_A}:${OWNER}=1/1`, "--issue", `${MINT_A}:${OWNER}=1/1`, "--jupiter", "https://q.example"])).toBe(ONE_MARKET);
    expect(usage([...stocking, `${MINT_A}:${OWNER}=1/1`, "--slippage-bps", "10"])).toBe(INVENTORY_ALONE);
    expect(usage([...stocking, `${MINT_A}:${OWNER}=1/1`, "--route-program", OWNER])).toBe(INVENTORY_ALONE);
    expect(usage([...stocking, `${MINT_A}:${OWNER}=1/1`, "--issue", `${MINT_A}:${OWNER}=1/1`, "--slippage-bps", "10"])).toBe(ISSUE_ALONE);
    expect(parse(["solver-table", "--solver", OWNER, "--mints", MINT_A])).toEqual({
      name: "solver-table",
      url: DEFAULT_URL,
      priority: 0n,
      solver: OWNER,
      mints: [MINT_A],
    });
    expect(usage(["solver-table", "--mints", MINT_A])).toBe("missing --solver");
    expect(usage(["solver-table", "--solver", OWNER])).toBe("missing --mints");
    const base = ["solve", "--keypair", "k", "--jupiter", "https://q.example", "--min-profit", `${MINT_A}=1`];
    expect(usage(["solve", "--keypair", "k", "--jupiter", "https://q.example", "--min-profit", "5"])).toBe(
      "--min-profit takes mint=amount pairs separated by commas",
    );
    expect(parse(base)).toMatchObject({ jito: undefined, tipLamports: 0n, maxFeeBps: 100, slippageBps: 50 });
    expect(usage([...base, "--tip", "5"])).toBe("--tip pays a jito tip and needs --jito");
    expect(parse([...base, "--tip", "0"])).toMatchObject({ tipLamports: 0n, jito: undefined });
    expect(parse(base)).not.toHaveProperty("bundleSize");
    const jito = [...base, "--jito", "https://" + "engine.example"];
    expect(parse(jito)).toMatchObject({ bundleSize: MAX_BUNDLE });
    expect(parse([...jito, "--bundle-size", "1"])).toMatchObject({ bundleSize: 1 });
    expect(parse([...jito, "--bundle-size", String(MAX_BUNDLE)])).toMatchObject({ bundleSize: MAX_BUNDLE });
    for (const bad of ["0", String(MAX_BUNDLE + 1), "1.5", "x", ""]) {
      expect(usage([...jito, "--bundle-size", bad])).toBe(`--bundle-size must be an integer from 1 to ${MAX_BUNDLE}`);
    }
    expect(usage([...base, "--bundle-size", "2"])).toBe(BUNDLE_SIZE_NEEDS_JITO);
    expect(BUNDLE_SIZE_NEEDS_JITO).toBe("--bundle-size sets how many fills share one jito bundle and needs --jito");
    expect(parse([...base, "--route-program", "11111111111111111111111111111112"])).toMatchObject({
      routeProgram: "11111111111111111111111111111112",
    });
    expect(usage([...base, "--route-program", "nope"])).toBe("--route-program is not a base58 address");
    expect(usage(["solve", "--keypair", "k", "--jupiter", "http://q.example", "--min-profit", "1"])).toBe(
      "--jupiter must be an https url",
    );
    expect(usage(["solve", "--keypair", "k", "--jupiter", "nope", "--min-profit", "1"])).toBe("--jupiter is not a url");
    expect(usage([...base, "--jito", "ftp://x"])).toBe("--jito must be an https url");
    expect(usage(["solve", "--keypair", "k", "--jupiter", "https://q.example"])).toBe("missing --min-profit");
    expect(usage([...base, "--max-fee-bps", "201"])).toBe("--max-fee-bps must be an integer from 0 to 200");
    expect(usage([...base, "--slippage-bps", "10001"])).toBe("--slippage-bps must be an integer from 0 to 10000");
    expect(DEFAULT_CONCURRENCY).toBe(4);
    expect(MAX_CONCURRENCY).toBe(32);
    expect(parse([...base, "--concurrency", "1"])).toMatchObject({ concurrency: 1 });
    expect(parse([...base, "--concurrency", "32"])).toMatchObject({ concurrency: 32 });
    for (const bad of ["0", "33", "1.5", "x", ""]) {
      expect(usage([...base, "--concurrency", bad])).toBe("--concurrency must be an integer from 1 to 32");
    }
  });

  it("solve refuses a zero min profit", () => {
    const solve = ["solve", "--keypair", "k", "--jupiter", "https://q.example", "--min-profit"];
    expect(usage([...solve, `${MINT_A}=0`])).toBe(zeroProfit(MINT_A));
    expect(usage([...solve, `${MINT_A}=1,${OWNER}=0`])).toBe(zeroProfit(OWNER));
    expect(zeroProfit(OWNER)).toContain(OWNER);
    expect(parse([...solve, `${MINT_A}=1,${OWNER}=2`])).toMatchObject({ minProfit: new Map([[MINT_A, 1n], [OWNER, 2n]]) });
  });

  it("solve refuses a priority fee above the auto cap", () => {
    const solve = ["solve", "--keypair", "k", "--jupiter", "https://q.example", "--min-profit", `${MINT_A}=1`, "--priority-fee"];
    expect(usage([...solve, (AUTO_PRICE_CAP + 1n).toString()])).toBe(solveFeeAboveCap);
    expect(parse([...solve, AUTO_PRICE_CAP.toString()])).toMatchObject({ priority: AUTO_PRICE_CAP });
    expect(parse([...solve, "auto"])).toMatchObject({ priority: "auto" });
    expect(parse(["cancel", "--keypair", "k", "--nonce", "1", "--priority-fee", (AUTO_PRICE_CAP + 1n).toString()])).toMatchObject({
      priority: AUTO_PRICE_CAP + 1n,
    });
  });

  it("solve parses max sol cost", () => {
    const solve = ["solve", "--keypair", "k", "--jupiter", "https://q.example", "--min-profit", `${MINT_A}=1`];
    expect(DEFAULT_MAX_SOL_COST).toBe(10_000_000n);
    expect(parse(solve)).toMatchObject({ maxSolCost: DEFAULT_MAX_SOL_COST });
    expect(parse([...solve, "--max-sol-cost", "0.002"])).toMatchObject({ maxSolCost: 2_000_000n });
    expect(parse([...solve, "--max-sol-cost", "1"])).toMatchObject({ maxSolCost: 1_000_000_000n });
    expect(parse([...solve, "--max-sol-cost", "0.000000001"])).toMatchObject({ maxSolCost: 1n });
    for (const bad of ["0", "0.0", "0.0000000001", "-1", "1e-3", "abc", ""]) {
      expect(usage([...solve, `--max-sol-cost=${bad}`])).toBe(MAX_SOL_COST_FORMAT);
    }
    expect(usageOf("solve").options).toContain("--max-sol-cost");
  });

  it("solve parses max rent", () => {
    const solve = ["solve", "--keypair", "k", "--jupiter", "https://q.example", "--min-profit", `${MINT_A}=1`];
    expect(DEFAULT_MAX_RENT).toBe(10_000_000n);
    expect(parse(solve)).toMatchObject({ maxRent: DEFAULT_MAX_RENT, maxSolCost: DEFAULT_MAX_SOL_COST });
    expect(parse([...solve, "--max-rent", "0.005"])).toMatchObject({ maxRent: 5_000_000n, maxSolCost: DEFAULT_MAX_SOL_COST });
    expect(parse([...solve, "--max-rent", "2"])).toMatchObject({ maxRent: 2_000_000_000n });
    expect(parse([...solve, "--max-rent", "0.000000001", "--max-sol-cost", "0.002"])).toMatchObject({ maxRent: 1n, maxSolCost: 2_000_000n });
    for (const bad of ["0", "0.0", "0.0000000001", "-1", "1e-3", "abc", ""]) {
      expect(usage([...solve, `--max-rent=${bad}`])).toBe(MAX_RENT_FORMAT);
    }
    expect(usageOf("solve").options).toContain("--max-rent");
    expect(usageOf("solve").usage).toContain("[--max-rent <SOL>]");
  });

  it("solve parses sol values with the syntax of --issue and refuses bad ones", () => {
    const solve = ["solve", "--keypair", "k", "--jupiter", "https://q.example", "--min-profit", `${MINT_A}=1`];
    expect(parse(solve)).not.toHaveProperty("solValue");
    expect(parse([...solve, "--sol-value", `${MINT_B}=200/1, ${OWNER}=1/3`])).toMatchObject({
      solValue: new Map([
        [MINT_B, { raw: 200n, lamports: 1n }],
        [OWNER, { raw: 1n, lamports: 3n }],
      ]),
    });
    for (const bad of [`${MINT_B}=200`, `${MINT_B}:${OWNER}=1/1`, `${MINT_B}=1/1/2`, ""]) {
      expect(usage([...solve, `--sol-value=${bad}`])).toBe(SOL_VALUE_FORMAT);
    }
    expect(usage([...solve, "--sol-value", `${MINT_B}=0/1`])).toBe("--sol-value rates must be positive on both sides");
    expect(usage([...solve, "--sol-value", `${MINT_B}=1/0`])).toBe("--sol-value rates must be positive on both sides");
    expect(usage([...solve, "--sol-value", `${MINT_B}=1/x`])).toMatch(/^--sol-value/);
    expect(usage([...solve, "--sol-value", "nope=1/1"])).toBe("--sol-value is not a base58 address");
    expect(usage([...solve, "--sol-value", `${MINT_B}=1/1,${MINT_B}=2/1`])).toBe(`--sol-value names ${MINT_B} twice`);
    expect(usage([...solve, "--sol-value", `${NATIVE_MINT}=1/1`])).toBe(SOL_VALUE_NATIVE);
    expect(usageOf("solve").options).toContain("--sol-value");
    expect(usageOf("solve").usage).toContain("[--sol-value <mint>=<raw>/<lamports>,...]");
  });

  it("reads an optional partner for create and needs both halves of it", () => {
    const base = [
      "create",
      "swap",
      "--keypair",
      "k",
      "--nonce",
      "1",
      "--input-mint",
      "11111111111111111111111111111112",
      "--output-mint",
      "11111111111111111111111111111113",
      "--expires-at",
      "9",
      "--amount-in",
      "5",
      "--min-out",
      "1",
    ];
    expect((parse(base) as { input: object }).input).not.toHaveProperty("partner");
    expect(parse([...base, "--partner", "11111111111111111111111111111114", "--partner-bps", "100"])).toMatchObject({
      input: { partner: { account: "11111111111111111111111111111114", bps: 100 } },
    });
    expect(usage([...base, "--partner", "11111111111111111111111111111114"])).toBe("missing --partner-bps");
    expect(usage([...base, "--partner-bps", "5"])).toBe("missing --partner");
    expect(usage([...base, "--partner", "11111111111111111111111111111114", "--partner-bps", "101"])).toBe(
      "--partner-bps must be an integer from 0 to 100",
    );
  });

  it("parses economics with per-kind fees and refuses malformed or out-of-range values", () => {
    expect(
      parse([
        "set-economics",
        "--keypair",
        "k",
        "--bounty",
        "4294967295",
        "--create-fee",
        "0",
        "--kind-fees",
        "limit=100,dutch=0,attested=300",
        "--partner-cut",
        "65535",
      ]),
    ).toEqual({
      name: "set-economics",
      url: DEFAULT_URL,
      priority: 0n,
      by: { keypair: "k", yes: false },
      economics: {
        kindFeeMask: 0b1_1100,
        kindFeeBps: [0, 100, 0, 300],
        partnerCutBps: 65_535,
        crankBounty: 4_294_967_295,
        createFee: 0,
      },
    });
    expect(parse(["set-economics", "--keypair", "k", "--bounty", "1", "--create-fee", "2"])).toMatchObject({
      economics: { kindFeeMask: 0, kindFeeBps: [0, 0, 0, 0], partnerCutBps: 0, crankBounty: 1, createFee: 2 },
    });
    const base = ["set-economics", "--keypair", "k", "--bounty", "1", "--create-fee", "1"];
    expect(usage([...base, "--kind-fees", "swap=1,swap=2"])).toBe("--kind-fees names swap twice");
    expect(usage([...base, "--kind-fees", "fly=1"])).toBe(
      "--kind-fees takes name=bps pairs for swap, limit, dutch, attested; got fly=1",
    );
    expect(usage([...base, "--kind-fees", "swap"])).toBe(
      "--kind-fees takes name=bps pairs for swap, limit, dutch, attested; got swap",
    );
    expect(usage([...base, "--kind-fees", "swap=101"])).toBe("--kind-fees swap must be an integer from 0 to 100 bps");
    expect(usage([...base, "--kind-fees", "attested=301"])).toBe("--kind-fees attested must be an integer from 0 to 300 bps");
    expect(usage([...base, "--kind-fees", "dutch=1.5"])).toBe("--kind-fees dutch must be an integer from 0 to 100 bps");
    expect(usage([...base, "--partner-cut", "1.5"])).toBe("--partner-cut must be an integer from 0 to 65535");
    expect(usage(["set-economics", "--keypair", "k", "--bounty", "4294967296", "--create-fee", "1"])).toBe(
      "--bounty must be an integer from 0 to 4294967295",
    );
    expect(usage(["set-economics", "--keypair", "k", "--create-fee", "1"])).toBe("missing --bounty");
    expect(usage(["set-economics", "--keypair", "k", "--bounty", "1"])).toBe("missing --create-fee");
  });

  it("refuses options the command does not use and reads the crank funding flag", () => {
    expect(usage(["domain", "--keypair", "k.json"])).toBe("domain does not take --keypair");
    expect(usage(["advance-epoch", "--keypair", "k", "--base", "1"])).toBe("advance-epoch does not take --base");
    expect(usage(["cancel", "--keypair", "k", "--nonce", "1", "--fund-accounts"])).toBe(
      "cancel does not take --fund-accounts",
    );
    expect(usage(["cancel", "--keypair", "k", "--nonce", "1", "--nonce", "2"])).toBe("--nonce is given more than once");
    expect(usage(["cancel", "--keypair", "k", "--nonce=1", "--nonce", "2"])).toBe("--nonce is given more than once");
    expect(usage(["mandate", "grant", "--keypair", "k", "--amount-in", "1"])).toBe("mandate grant does not take --amount-in");
    expect(usage(["mandate", "revoke", "--keypair", "k", "--agent", OWNER, "--owner", OWNER])).toBe(
      "mandate revoke does not take --owner",
    );
    expect(usage(["mandate", "show", "--agent", OWNER, "--yes"])).toBe("mandate show does not take --yes");
    expect(usage(["mandate", "use", "swap", "--keypair", "k", "--kinds", "swap"])).toBe("mandate use does not take --kinds");
    expect(usage(["mandate", "use", "attested", "--keypair", "k", "--owner", OWNER, "--expires-in", "60", "--amount-in", "3", "--min-result", "1", "--max-result", "2", "--attestor", OWNER])).toBe(
      "mandate use does not take --min-result",
    );
    expect(usage(["mandate", "use", "attested", "--keypair", "k", "--owner", OWNER, "--expires-in", "60", "--amount-in", "3"])).toBe(MANDATE_USE_KINDS);
    expect(usage(["signed", "prepare", "swap", "--keypair", "k", "--file", "f"])).toBe("signed prepare does not take --file");
    expect(usage(["signed", "submit", "--keypair", "k", "--file", "f", "--out", "o"])).toBe("signed submit does not take --out");
    expect(usage(["mandate", "nothing", "--keypair", "k"])).toBe("mandate needs grant, show, revoke or use");
    expect(parse(["crank", "--keypair", "k.json"])).toEqual({
      name: "crank",
      url: DEFAULT_URL,
      priority: 0n,
      keypair: "k.json",
      dryRun: false,
      fundAccounts: false,
    });
    expect(parse(["crank", "--keypair", "k.json", "--fund-accounts", "--dry-run"])).toMatchObject({
      dryRun: true,
      fundAccounts: true,
    });
  });

  it("accepts the full u64 range and nothing else", () => {
    expect(parseU64("0", "n")).toBe(0n);
    expect(parseU64(U64_MAX.toString(), "n")).toBe(U64_MAX);
    expect(() => parseU64((U64_MAX + 1n).toString(), "n")).toThrow("--n must be an integer from 0 to");
    expect(() => parseU64("-1", "n")).toThrow(UsageError);
    expect(() => parseU64("1.5", "n")).toThrow(UsageError);
    expect(() => parseU64("", "n")).toThrow(UsageError);
    expect(() => parseU64("x1", "n")).toThrow(UsageError);
    expect(() => parseU64("1x", "n")).toThrow(UsageError);
  });

  it("accepts the full i64 range and nothing else", () => {
    expect(parseI64(I64_MIN.toString(), "t")).toBe(I64_MIN);
    expect(parseI64(I64_MAX.toString(), "t")).toBe(I64_MAX);
    expect(parseI64("-5", "t")).toBe(-5n);
    expect(() => parseI64((I64_MIN - 1n).toString(), "t")).toThrow("--t must be an integer from");
    expect(() => parseI64((I64_MAX + 1n).toString(), "t")).toThrow(UsageError);
    expect(() => parseI64("--5", "t")).toThrow(UsageError);
    expect(() => parseI64("5-", "t")).toThrow(UsageError);
    expect(() => parseI64("-", "t")).toThrow(UsageError);
  });
});
