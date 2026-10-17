import { describe, expect, it } from "vitest";
import { I64_MAX, I64_MIN, Kind, U64_MAX } from "@intent-engine/core";
import { AUTO_PRICE_CAP, MAX_PRIORITY_PRICE } from "../src/compute.js";
import { DEFAULT_CONCURRENCY, DEFAULT_MAX_RENT, DEFAULT_MAX_SOL_COST, MAX_CONCURRENCY } from "@intent-engine/solver";
import {
  DEFAULT_URL,
  WATCH_INTERVAL,
  AGENT_DEFAULT_HOURLY_LAMPORTS,
  AGENT_NEEDS_OWNERS,
  ISSUE_ALONE,
  ISSUE_FORMAT,
  INVENTORY_ALONE,
  INVENTORY_FORMAT,
  ONE_MARKET,
  RELAY_NEEDS_FEES,
  RELAY_DEFAULT_HOURLY_LAMPORTS,
  RELAY_DEFAULT_TTL,
  MAX_RENT_FORMAT,
  MAX_SOL_COST_FORMAT,
  solveFeeAboveCap,
  zeroProfit,
  parse,
  parseFeeBps,
  parseI64,
  parseKinds,
  parseLimit,
  MAX_EVENT_LIMIT,
  parsePause,
  parseU64,
  UsageError,
  clusterUrl,
  ENV_KEYPAIR,
  ENV_URL,
  MAX_FOLLOW_INTERVAL,
  outputOf,
  parsePriority,
  SHAPES,
  TOKEN_SIDES,
  COMMANDS,
  USAGE,
  usageOf,
  MANDATE_USE_KINDS,
  WALLET_LIMITS_NEED_WALLET,
} from "../src/args.js";
import { DEVNET_TEST_MINT as TEST_TOKEN, NATIVE_MINT } from "@intent-engine/core";

const OWNER = "11111111111111111111111111111112";
const MINT_A = "So11111111111111111111111111111111111111112";
const MINT_B = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function usage(argv: string[], env: Record<string, string> = {}): string {
  try {
    parse(argv, env);
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    return (error as Error).message;
  }
  throw new Error(`parsed ${argv.join(" ")}`);
}

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

describe("commands", () => {
  it("parses pda without touching the network", () => {
    expect(parse(["pda", "--owner", OWNER, "--nonce", "3"])).toEqual({ name: "pda", owner: OWNER, nonce: 3n });
  });

  it("defaults the url and honours an override", () => {
    expect(parse(["show", "config"])).toEqual({ name: "show-config", url: DEFAULT_URL, priority: 0n });
    expect(DEFAULT_URL).toBe("http://127.0.0.1:8899");
    expect(parse(["show", "config", "--url", "http://x"])).toEqual({ name: "show-config", url: "http://x", priority: 0n });
  });

  it("parses an agent server with an optional relayer key and its limits", () => {
    expect(parse(["mcp", "--url", "http://x"])).toEqual({ name: "mcp", url: "http://x", priority: 0n, relay: undefined, agent: undefined, wallet: null, allTools: false });
    expect(parse(["mcp", "--url", "devnet", "--wallet"])).toMatchObject({ name: "mcp", wallet: { perTrade: new Map(), perHour: new Map() } });
    expect(parse(["mcp", "--url", "devnet", "--wallet", "--wallet-per-trade", "SOL=0.1, test=20", "--wallet-per-hour", "sol=0.5"])).toMatchObject({
      wallet: { perTrade: new Map([[NATIVE_MINT, "0.1"], [TEST_TOKEN, "20"]]), perHour: new Map([[NATIVE_MINT, "0.5"]]) },
    });
    expect(usage(["mcp", "--wallet-per-trade", "SOL=1"])).toBe(WALLET_LIMITS_NEED_WALLET);
    for (const bad of ["SOL", "SOL=lots", "SOL=1=2", "SOL=-1"]) {
      expect(usage(["mcp", "--url", "devnet", "--wallet", "--wallet-per-trade", bad])).toBe(
        "--wallet-per-trade takes token=amount pairs separated by commas, such as SOL=0.1,TEST=20",
      );
    }
    expect(usage(["mcp", "--url", "devnet", "--wallet", "--wallet-per-hour", "SOL=1,sol=2"])).toBe("--wallet-per-hour names sol twice");
    expect(usage(["mcp", "--url", "http://x", "--wallet", "--wallet-per-hour", "TEST=1"])).toMatch(/^--wallet-per-hour: /);
    const free = ["--relay-fee", "11111111111111111111111111111112=0"];
    expect(usage(["mcp", "--relayer", "r.json"])).toBe(RELAY_NEEDS_FEES);
    expect(RELAY_NEEDS_FEES).toBe(
      "--relayer needs --relay-fee naming every input token it relays as mint=amount; amount may be 0, and other tokens are refused",
    );
    expect(parse(["mcp", "--relayer", "r.json", ...free])).toEqual({
      name: "mcp",
      url: DEFAULT_URL,
      priority: 0n,
      relay: {
        keypair: "r.json",
        maxLamports: 0n,
        maxTtl: 86_400n,
        perHour: 10,
        hourlyLamports: 100_000_000n,
        fees: new Map([["11111111111111111111111111111112", 0n]]),
      },
      agent: undefined,
      wallet: null,
      allTools: false,
    });
    expect([RELAY_DEFAULT_TTL, RELAY_DEFAULT_HOURLY_LAMPORTS, AGENT_DEFAULT_HOURLY_LAMPORTS]).toEqual([
      86_400,
      100_000_000n,
      50_000_000n,
    ]);
    expect(usage(["mcp", "--agent", "a.json"])).toBe(AGENT_NEEDS_OWNERS);
    expect(AGENT_NEEDS_OWNERS).toBe("--agent needs --agent-owners naming every owner whose mandates this agent key may use");
    expect(parse(["mcp", "--agent", "a.json", "--agent-owners", "11111111111111111111111111111112"])).toMatchObject({
      relay: undefined,
      agent: { keypair: "a.json", hourlyLamports: 50_000_000n, owners: ["11111111111111111111111111111112"] },
    });
    const owners = "11111111111111111111111111111112, SysvarC1ock11111111111111111111111111111111";
    expect(parse(["mcp", "--agent", "a", "--agent-hourly-lamports", "7", "--agent-owners", owners])).toMatchObject({
      agent: {
        keypair: "a",
        hourlyLamports: 7n,
        owners: ["11111111111111111111111111111112", "SysvarC1ock11111111111111111111111111111111"],
      },
    });
    expect(usage(["mcp", "--agent", "a", "--agent-owners", "nope"])).toBe("--agent-owners is not a base58 address");
    for (const lone of ["--agent-hourly-lamports", "--agent-owners"]) {
      expect(usage(["mcp", lone, "1"])).toBe("the --agent-* limits need --agent");
    }
    expect(parse(["mcp", "--relayer", "r", ...free, "--relay-hourly-lamports", "9"])).toMatchObject({ relay: { hourlyLamports: 9n } });
    const limited = ["mcp", "--relayer", "r", ...free, "--relay-max-lamports", "90000", "--relay-max-ttl", "60", "--relay-per-hour", "1"];
    expect(parse(limited)).toMatchObject({ relay: { maxLamports: 90_000n, maxTtl: 60n, perHour: 1 } });
    expect(parse(["mcp", "--relayer", "r", ...free, "--relay-max-ttl", "31536000", "--relay-per-hour", "3600"])).toMatchObject({
      relay: { maxTtl: 31_536_000n, perHour: 3_600 },
    });
    expect(usage(["mcp", "--relayer", "r", ...free, "--relay-max-ttl", "31536001"])).toBe("--relay-max-ttl must be an integer from 0 to 31536000");
    expect(usage(["mcp", "--relayer", "r", ...free, "--relay-per-hour", "3601"])).toBe("--relay-per-hour must be an integer from 0 to 3600");
    for (const bad of [["--relay-max-ttl", "59"], ["--relay-per-hour", "0"]]) {
      expect(usage(["mcp", "--relayer", "r", ...free, ...bad])).toBe("--relay-max-ttl must be at least 60 and --relay-per-hour at least 1");
    }
    const fees = "11111111111111111111111111111112=25, SysvarC1ock11111111111111111111111111111111 = 0";
    expect(parse(["mcp", "--relayer", "r", "--relay-fee", fees])).toMatchObject({
      relay: {
        fees: new Map([
          ["11111111111111111111111111111112", 25n],
          ["SysvarC1ock11111111111111111111111111111111", 0n],
        ]),
      },
    });
    const shape = "--relay-fee takes mint=amount pairs separated by commas";
    for (const [bad, message] of [
      ["11111111111111111111111111111112", shape],
      ["11111111111111111111111111111112=1=2", shape],
      ["nope=1", "--relay-fee is not a base58 address"],
      ["11111111111111111111111111111112=-1", `--relay-fee must be an integer from 0 to ${U64_MAX}`],
      ["11111111111111111111111111111112=1,11111111111111111111111111111112=2", "--relay-fee names 11111111111111111111111111111112 twice"],
    ]) {
      expect(usage(["mcp", "--relayer", "r", "--relay-fee", bad as string])).toBe(message);
    }
    for (const lone of ["--relay-max-lamports", "--relay-max-ttl", "--relay-per-hour", "--relay-hourly-lamports", "--relay-fee"]) {
      expect(usage(["mcp", lone, "100"])).toBe("the --relay-* limits need --relayer");
    }
    expect(usage(["mcp", "extra"])).toBe("unexpected argument extra");
    expect(usage(["mcp", "--keypair", "k"])).toBe("mcp does not take --keypair");
  });

  it("parses domain", () => {
    expect(parse(["domain", "--url", "http://x"])).toEqual({ name: "domain", url: "http://x", priority: 0n });
    expect(usage(["domain", "extra"])).toBe("unexpected argument extra");
  });

  it("parses show intent and quote", () => {
    expect(parse(["show", "intent", "--owner", OWNER, "--nonce", "1"])).toEqual({
      name: "show-intent",
      url: DEFAULT_URL,
      priority: 0n,
      owner: OWNER,
      nonce: 1n,
    });
    expect(parse(["quote", "--owner", OWNER, "--nonce", "1"])).toEqual({
      name: "quote",
      url: DEFAULT_URL,
      priority: 0n,
      owner: OWNER,
      nonce: 1n,
      at: undefined,
    });
    expect(parse(["quote", "--owner", OWNER, "--nonce", "1", "--at=-7"])).toMatchObject({ at: -7n });
    expect(usage(["quote", "--owner", OWNER, "--nonce", "1", "--at", "-7"])).toMatch(/ambiguous/);
  });

  it("parses the keyed maintenance commands", () => {
    expect(parse(["cancel", "--keypair", "k.json", "--nonce", "2"])).toEqual({
      name: "cancel",
      url: DEFAULT_URL,
      priority: 0n,
      keypair: "k.json",
      yes: false,
      nonce: 2n,
      close: false,
    });
    expect(parse(["cancel", "--keypair", "k.json", "--nonce", "2", "--close", "--yes"])).toMatchObject({ yes: true, close: true });
    for (const verb of ["expire", "close"] as const) {
      expect(parse([verb, "--keypair", "k.json", "--owner", OWNER, "--nonce", "4"])).toEqual({
        name: verb,
        url: DEFAULT_URL,
        priority: 0n,
        keypair: "k.json",
        yes: false,
        owner: OWNER,
        nonce: 4n,
      });
      expect(parse([verb, "--keypair", "k.json", "--owner", OWNER, "--nonce", "4", "--yes"])).toMatchObject({ yes: true });
      expect(usage([verb, "--keypair", "k.json", "--owner", OWNER, "--nonce", "4", "--close"])).toBe(`${verb} does not take --close`);
    }
    expect(parse(["advance-epoch", "--keypair", "k.json"])).toEqual({
      name: "advance-epoch",
      url: DEFAULT_URL,
      priority: 0n,
      keypair: "k.json",
    });
    expect(parse(["advance-nonce", "--keypair", "k.json", "--base", "9"])).toEqual({
      name: "advance-nonce",
      url: DEFAULT_URL,
      priority: 0n,
      keypair: "k.json",
      base: 9n,
    });
  });

  it("parses create for every kind with an optional nonce and either form of expiry", () => {
    const common = ["--keypair", "k", "--input-mint", MINT_A, "--output-mint", MINT_B, "--units", "raw"];
    expect(parse(["create", "swap", ...common, "--nonce", "5", "--expires-at", "100", "--amount-in", "10", "--min-out", "9"])).toEqual({
      name: "flow",
      url: DEFAULT_URL,
      priority: 0n,
      flow: "create",
      keypair: "k",
      yes: false,
      input: {
        input_mint: MINT_A,
        output_mint: MINT_B,
        order: { kind: "swap", amount_in: "10", min_out: "9" },
        expires_at: "100",
        nonce: "5",
      },
    });
    const later = [...common, "--expires-in", "600"];
    expect(parse(["create", "limit", ...later, "--make", "3", "--take", "4", "--yes"])).toMatchObject({
      yes: true,
      input: { order: { kind: "limit", make_amount: "3", take_amount: "4" }, expires_in: 600 },
    });
    expect(
      parse([
        "create",
        "dutch",
        ...later,
        "--amount-in",
        "10",
        "--start-out",
        "9",
        "--end-out",
        "5",
        "--start-at=-1",
        "--end-at",
        "50",
      ]),
    ).toMatchObject({
      input: { order: { kind: "dutch", amount_in: "10", start_out: "9", end_out: "5", start_time: "-1", end_time: "50" } },
    });
    expect(
      parse(["create", "attested", ...later, "--amount-in", "10", "--min-result", "1", "--max-result", "2", "--attestor", OWNER, "--spec-hash", "AB".repeat(32)]),
    ).toMatchObject({
      input: { order: { kind: "attested", amount_in: "10", min_result: "1", max_result: "2", attestor: OWNER, spec_hash: "ab".repeat(32) } },
    });
    expect((parse(["create", "swap", ...later, "--amount-in", "1", "--min-out", "1"]) as { input: object }).input).not.toHaveProperty(
      "nonce",
    );
    const kindless = "name the order kind: swap, limit, dutch or attested";
    expect(usage(["create", "fly", ...later])).toBe(kindless);
    expect(usage(["create", ...later])).toBe(kindless);
    expect(usage(["create", "swap", ...later, "--amount-in", "10"])).toBe("missing --min-out");
    expect(usage(["create", "swap", ...later, "--amount-in", "1", "--min-out", "1", "--make", "2"])).toBe(
      "a swap order does not take --make",
    );
    expect(usage(["create", "swap", ...common, "--amount-in", "1", "--min-out", "1"])).toBe(
      "give exactly one of --expires-at or --expires-in",
    );
    expect(usage(["create", "swap", ...later, "--expires-at", "5", "--amount-in", "1", "--min-out", "1"])).toBe(
      "give exactly one of --expires-at or --expires-in",
    );
    expect(usage(["create", "swap", ...common, "--expires-in", "31536001", "--amount-in", "1", "--min-out", "1"])).toBe(
      "--expires-in must be an integer from 60 to 31536000",
    );
  });

  it("reads token amounts only when asked to, and keeps attested results and nonces raw", () => {
    const base = ["create", "attested", "--keypair", "k", "--input-mint", MINT_A, "--output-mint", MINT_B, "--expires-in", "60", "--spec-hash", "ab".repeat(32)];
    const tokens = [...base, "--units", "tokens", "--amount-in", "1.5", "--min-result", "7", "--max-result", "9", "--attestor", OWNER];
    expect(parse(tokens)).toMatchObject({
      input: { order: { amount_in: { tokens: "1.5", side: "input" }, min_result: "7", max_result: "9" } },
    });
    expect(usage([...base, "--units", "tokens", "--amount-in", "1,5", "--min-result", "7", "--max-result", "9", "--attestor", OWNER])).toBe(
      "--amount-in must be a token amount like 12 or 0.5",
    );
    expect(usage([...base, "--units", "tokens", "--amount-in", "1", "--min-result", "0.5", "--max-result", "9", "--attestor", OWNER])).toBe(
      `--min-result must be an integer from 0 to ${U64_MAX}`,
    );
    expect(usage([...base, "--units", "bananas", "--amount-in", "1", "--min-result", "1", "--max-result", "9", "--attestor", OWNER])).toBe(
      "--units must be raw or tokens",
    );
    expect(parse([...base, "--units", "raw", "--amount-in", "2", "--min-result", "1", "--max-result", "9", "--attestor", OWNER])).toMatchObject({
      input: { order: { amount_in: "2" } },
    });
    expect(TOKEN_SIDES).toEqual({
      "amount-in": "input",
      make: "input",
      "per-intent": "input",
      total: "input",
      "agent-fee": "input",
      "floor-in": "input",
      "relayer-fee": "input",
      "judge-fee": "input",
      amount: "input",
      "min-out": "output",
      take: "output",
      "start-out": "output",
      "end-out": "output",
      "floor-out": "output",
    });
  });

  it("parses listing, allowances, mandates and signed intents", () => {
    expect(parse(["list", "--owner", OWNER])).toEqual({
      name: "lookup",
      url: DEFAULT_URL,
      priority: 0n,
      lookup: "list",
      keypair: undefined,
      input: { owner: OWNER },
    });
    expect(parse(["list", "--keypair", "k"])).toMatchObject({ keypair: "k", input: {} });
    expect(usage(["list"])).toBe("list needs --owner or --keypair");
    expect(parse(["approve", "--keypair", "k", "--mint", MINT_A, "--amount", "7", "--units", "raw", "--yes"])).toMatchObject({
      flow: "approve",
      yes: true,
      input: { mint: MINT_A, amount: "7" },
    });
    expect(parse(["revoke-approval", "--keypair", "k", "--mint", MINT_A])).toMatchObject({
      flow: "revoke-approval",
      yes: false,
      input: { mint: MINT_A },
    });
    const grant = [
      "mandate",
      "grant",
      "--keypair",
      "k",
      "--agent",
      OWNER,
      "--input-mint",
      MINT_A,
      "--output-mint",
      MINT_B,
      "--kinds",
      "swap,dutch",
      "--per-intent",
      "4",
      "--total",
      "8",
      "--max-intents",
      "2",
      "--max-ttl",
      "600",
      "--valid-for",
      "3600",
      "--floor-out",
      "1",
      "--floor-in",
      "2",
      "--units",
      "raw",
    ];
    expect(parse(grant)).toMatchObject({
      flow: "mandate-grant",
      input: {
        agent: OWNER,
        kinds: ["swap", "dutch"],
        per_intent: "4",
        total: "8",
        max_intents: 2,
        max_ttl: 600,
        valid_for: 3600,
        floor: { out: "1", in: "2" },
      },
    });
    expect(parse([...grant, "--id", "3", "--agent-fee", "1"])).toMatchObject({ input: { id: "3", agent_fee: "1" } });
    expect(usage([...grant.slice(0, 11), "attested", ...grant.slice(12)])).toBe(
      "--kinds takes a comma list of swap, limit, dutch; got attested",
    );
    expect(parse(["mandate", "show", "--agent", OWNER, "--owner", MINT_A])).toMatchObject({
      name: "lookup",
      lookup: "mandate-show",
      input: { agent: OWNER, owner: MINT_A },
    });
    expect(parse(["mandate", "revoke", "--keypair", "k", "--agent", OWNER, "--id", "2"])).toMatchObject({
      flow: "mandate-revoke",
      input: { agent: OWNER, id: "2" },
    });
    expect(
      parse(["mandate", "use", "swap", "--keypair", "k", "--owner", OWNER, "--expires-in", "60", "--amount-in", "3", "--min-out", "2", "--units", "raw"]),
    ).toMatchObject({
      flow: "mandate-use",
      input: { owner: OWNER, order: { kind: "swap", amount_in: "3", min_out: "2" }, expires_in: 60 },
    });
    expect(usage(["mandate", "fly", "--keypair", "k"])).toBe("mandate needs grant, show, revoke or use");
    expect(usage(["mandate", "show", "x", "--agent", OWNER])).toBe("unexpected argument x");
    const signed = ["signed", "prepare", "swap", "--keypair", "k", "--out", "s.json", "--input-mint", MINT_A, "--output-mint", MINT_B, "--units", "raw"];
    expect(parse([...signed, "--expires-in", "60", "--amount-in", "3", "--min-out", "2", "--submit-within", "120", "--relayer-fee", "4"])).toMatchObject({
      name: "signed-prepare",
      out: "s.json",
      yes: false,
      input: { order: { kind: "swap" }, submit_within: 120, relayer_fee: "4" },
    });
    expect(parse(["signed", "submit", "--keypair", "r", "--file", "s.json"])).toEqual({
      name: "signed-submit",
      url: DEFAULT_URL,
      priority: 0n,
      keypair: "r",
      yes: false,
      file: "s.json",
    });
    expect(usage(["signed", "fly"])).toBe("signed needs prepare or submit");
    expect(usage(["signed", "submit", "--keypair", "r"])).toBe("missing --file");
    expect(usage(["signed", "prepare", "swap", "x", "--keypair", "k"])).toBe("unexpected argument x");
  });

  it("rejects malformed input with usage errors", () => {
    expect(usage([])).toMatch(/^usage: setup \| add-to claude\|codex \| balance \| pda \| domain \| mcp \| show config/);
    expect(usage(["fly"])).toMatch(/^usage:/);
    expect(usage(["pda", "--owner", OWNER])).toBe("missing --nonce");
    expect(usage(["pda", "--nonce", "1"])).toBe("missing --owner");
    expect(usage(["pda", "--owner", "nope", "--nonce", "1"])).toBe("--owner is not a base58 address");
    expect(usage(["pda", "x", "--owner", OWNER, "--nonce", "1"])).toBe("unexpected argument x");
    expect(usage(["show"])).toBe("show needs config, intent or mint-cap");
    expect(usage(["show", "user"])).toBe("show needs config, intent or mint-cap");
    expect(usage(["show", "mint-cap"])).toBe("missing --mint");
    expect(usage(["show", "config", "extra"])).toBe("unexpected argument extra");
    expect(usage(["show", "config", "--bogus"])).toMatch(/bogus/);
    expect(usage(["quote", "x", "--owner", OWNER, "--nonce", "1"])).toBe("unexpected argument x");
    expect(usage(["cancel", "x", "--keypair", "k", "--nonce", "1"])).toBe("unexpected argument x");
    expect(usage(["cancel", "--nonce", "1"])).toBe("missing --keypair");
    expect(usage(["close", "x", "--keypair", "k", "--owner", OWNER, "--nonce", "1"])).toBe("unexpected argument x");
    expect(usage(["advance-nonce", "x", "--keypair", "k", "--base", "1"])).toBe("unexpected argument x");
  });
});

describe("admin commands", () => {
  it("names kinds and pause flags instead of raw masks", () => {
    expect(parseKinds("swap")).toBe(2n);
    expect(parseKinds("limit")).toBe(4n);
    expect(parseKinds("dutch")).toBe(8n);
    expect(parseKinds("attested")).toBe(16n);
    expect(parseKinds("swap,limit,dutch,attested")).toBe(30n);
    expect(parseKinds("swap,swap")).toBe(2n);
    expect(() => parseKinds("swap,auction")).toThrow(
      "--kinds takes a comma list of swap, limit, dutch, attested; got auction",
    );
    expect(() => parseKinds("")).toThrow(UsageError);
    expect([parsePause("none", "f"), parsePause("create", "f"), parsePause("fill", "f"), parsePause("all", "f")]).toEqual([
      0, 1, 2, 3,
    ]);
    expect(() => parsePause("everything", "flags")).toThrow("--flags must be none, create, fill or all");
  });

  it("bounds the base fee to the program's cap of 100 bps", () => {
    expect(parseFeeBps("0")).toBe(0);
    expect(parseFeeBps("100")).toBe(100);
    for (const bad of ["101", "65536", "-1", "1.5", "x", ""]) {
      expect(() => parseFeeBps(bad)).toThrow("--fee-bps must be an integer from 0 to 100");
    }
  });

  it("parses init-config and the pause commands", () => {
    const base = ["--keypair", "a.json", "--guardian", OWNER, "--fee-recipient", MINT_A, "--fee-bps", "5", "--kinds", "swap"];
    expect(parse(["init-config", ...base])).toEqual({
      name: "init-config",
      url: DEFAULT_URL,
      priority: 0n,
      by: { keypair: "a.json", yes: false },
      guardian: OWNER,
      feeRecipient: MINT_A,
      feeBps: 5,
      enabledKinds: 2n,
      paused: 0,
    });
    expect(parse(["init-config", ...base, "--flags", "all"])).toMatchObject({ paused: 3 });
    for (const verb of ["raise-pause", "lower-pause"]) {
      expect(parse([verb, "--keypair", "k", "--yes", "--flags", "fill"])).toMatchObject({ by: { keypair: "k", yes: true } });
    }
    expect(parse(["propose-admin", "--keypair", "k", "--yes", "--new-admin", OWNER])).toMatchObject({ by: { keypair: "k", yes: true } });
    expect(parse(["accept-admin", "--keypair", "k", "--yes"])).toMatchObject({ by: { keypair: "k", yes: true } });
    expect(usage(["accept-admin", "--authority", OWNER, "--yes"])).toBe(
      "--yes signs and sends with --keypair; --authority only prints an unsigned transaction",
    );
    expect(usage(["init-config", "x", ...base])).toBe("unexpected argument x");
    expect(usage(["init-config", "--keypair", "a.json"])).toBe("missing --guardian");
    expect(parse(["raise-pause", "--authority", OWNER, "--flags", "fill"])).toMatchObject({ by: { authority: OWNER }, flags: 2 });
    expect(usage(["raise-pause", "--authority", OWNER, "--keypair", "k", "--flags", "fill"])).toBe(
      "pass --keypair to sign and send, or --authority to print an unsigned transaction, not both",
    );
    expect(usage(["raise-pause", "--authority", "nope", "--flags", "fill"])).toBe("--authority is not a base58 address");
    expect(parse(["update-config", "--authority", OWNER, "--fill-disabled", "none"])).toEqual({
      name: "update-config",
      url: DEFAULT_URL,
      priority: 0n,
      by: { authority: OWNER },
      change: { guardian: undefined, feeRecipient: undefined, feeBps: undefined, enabledKinds: undefined, fillDisabledKinds: 0n },
    });
    expect(
      parse(["update-config", "--keypair", "k", "--guardian", OWNER, "--fee-recipient", MINT_A, "--fee-bps", "7", "--kinds", "swap,limit", "--fill-disabled", "dutch"]),
    ).toMatchObject({ change: { guardian: OWNER, feeRecipient: MINT_A, feeBps: 7, enabledKinds: 6n, fillDisabledKinds: 8n } });
    expect(usage(["update-config", "--keypair", "k"])).toBe(
      "update-config needs at least one of --guardian, --fee-recipient, --fee-bps, --kinds, --fill-disabled",
    );
    expect(usage(["update-config", "--keypair", "k", "--fill-disabled", "bogus"])).toBe(
      "--fill-disabled takes none or a comma list of swap, limit, dutch, attested; got bogus",
    );
    expect(usage(["update-config", "--keypair", "k", "--kinds", "none"])).toBe(
      "--kinds takes a comma list of swap, limit, dutch, attested; got none",
    );
    expect(parse(["propose-admin", "--keypair", "k", "--new-admin", OWNER])).toMatchObject({
      name: "propose-admin",
      by: { keypair: "k", yes: false },
      pendingAdmin: OWNER,
    });
    expect(usage(["propose-admin", "--keypair", "k"])).toBe("missing --new-admin");
    expect(parse(["accept-admin", "--authority", OWNER])).toEqual({
      name: "accept-admin",
      url: DEFAULT_URL,
      priority: 0n,
      by: { authority: OWNER },
    });
    expect(usage(["accept-admin"])).toBe("missing --keypair");
    for (const verb of ["raise-pause", "lower-pause"] as const) {
      expect(parse([verb, "--keypair", "k", "--flags", "create"])).toEqual({
        name: verb,
        url: DEFAULT_URL,
        priority: 0n,
        by: { keypair: "k", yes: false },
        flags: 1,
      });
      expect(usage([verb, "--keypair", "k", "--flags", "none"])).toBe(
        "--flags must name at least one of create, fill or all",
      );
      expect(usage([verb, "--keypair", "k"])).toBe("missing --flags");
      expect(usage([verb, "x", "--keypair", "k", "--flags", "fill"])).toBe("unexpected argument x");
    }
  });
});

describe("crank", () => {
  it("parses a live and a dry crank", () => {
    expect(parse(["crank", "--keypair", "k"])).toEqual({
      name: "crank",
      url: DEFAULT_URL,
      priority: 0n,
      keypair: "k",
      dryRun: false,
      fundAccounts: false,
    });
    expect(parse(["crank", "--keypair", "k", "--dry-run"])).toMatchObject({ dryRun: true });
    expect(usage(["crank"])).toBe("missing --keypair");
    expect(usage(["crank", "x", "--keypair", "k"])).toBe("unexpected argument x");
    expect(usage(["crank", "--keypair", "k", "--dry-run=yes"])).toMatch(/dry-run/);
  });
});

describe("global options", () => {
  it("reads a priority fee as micro-lamports or auto on commands that send", () => {
    expect(parse(["cancel", "--keypair", "k", "--nonce", "1", "--priority-fee", "250"])).toMatchObject({ priority: 250n });
    expect(parse(["cancel", "--keypair", "k", "--nonce", "1", "--priority-fee", "auto"])).toMatchObject({ priority: "auto" });
    expect(parsePriority(undefined)).toBe(0n);
    expect(parsePriority(MAX_PRIORITY_PRICE.toString())).toBe(MAX_PRIORITY_PRICE);
    expect(() => parsePriority((MAX_PRIORITY_PRICE + 1n).toString())).toThrow(
      `--priority-fee is micro-lamports per compute unit and at most ${MAX_PRIORITY_PRICE}; use auto for the recent market price`,
    );
    expect(usage(["cancel", "--keypair", "k", "--nonce", "1", "--priority-fee=-1"])).toBe(
      `--priority-fee must be an integer from 0 to ${U64_MAX}`,
    );
    expect(usage(["show", "config", "--priority-fee", "1"])).toBe("show does not take --priority-fee");
  });

  it("names clusters, takes the url and keypair from the environment and lets flags win", () => {
    expect(clusterUrl("devnet")).toBe("https://api.devnet.solana.com");
    expect(clusterUrl("mainnet-beta")).toBe("https://api.mainnet-beta.solana.com");
    expect(clusterUrl("testnet")).toBe("https://api.testnet.solana.com");
    expect(clusterUrl("localnet")).toBe(DEFAULT_URL);
    expect(clusterUrl("https://rpc.example")).toBe("https://rpc.example");
    expect(parse(["show", "config", "--url", "devnet"])).toMatchObject({ url: "https://api.devnet.solana.com" });
    const env = { [ENV_URL]: "testnet", [ENV_KEYPAIR]: "env.json" };
    expect(parse(["cancel", "--nonce", "1"], env)).toMatchObject({ url: "https://api.testnet.solana.com", keypair: "env.json" });
    expect(parse(["cancel", "--nonce", "1", "--keypair", "k", "--url", "devnet"], env)).toMatchObject({
      url: "https://api.devnet.solana.com",
      keypair: "k",
    });
    expect(parse(["raise-pause", "--authority", OWNER, "--flags", "all"], env)).toMatchObject({ by: { authority: OWNER } });
    expect(parse(["list"], env)).toMatchObject({ keypair: "env.json" });
    expect(usage(["signed", "submit", "--file", "s.json"], env)).toBe("missing --keypair");
    expect(parse(["mandate", "show", "--agent", OWNER], env)).toMatchObject({ keypair: "env.json" });
    expect(() => parse(["pda", "--owner", OWNER, "--nonce", "1"], env)).not.toThrow();
    expect([ENV_URL, ENV_KEYPAIR]).toEqual(["INTENT_ENGINE_URL", "INTENT_ENGINE_KEYPAIR"]);
  });

  it("applies the default keypair only to commands that take one, so read-only sub-commands still run with a configured wallet", () => {
    const env = { [ENV_KEYPAIR]: "env.json" };
    expect(parse(["claims", "show", "--owner", OWNER, "--nonce", "1"], env)).not.toHaveProperty("keypair");
    expect(parse(["profile", "show", "--wallet", OWNER], env)).not.toHaveProperty("keypair");
    expect(parse(["committee", "show", "--committee", OWNER], env)).not.toHaveProperty("keypair");
    expect(parse(["claims", "take", "--owner", OWNER, "--nonce", "1", "--secs", "60"], env)).toMatchObject({ keypair: "env.json" });
    expect(usage(["claims", "show", "--owner", OWNER, "--nonce", "1", "--keypair", "k"], env)).toBe("claims show does not take --keypair");
  });

  it("chooses json or text output and answers help for any command", () => {
    expect(outputOf(["show", "config"])).toBe("json");
    expect(outputOf(["show", "config", "--output", "text"])).toBe("text");
    expect(outputOf(["show", "config", "--output=text"])).toBe("text");
    expect(outputOf(["--output", "json", "--output", "text"])).toBe("text");
    expect(() => outputOf(["--output", "xml"])).toThrow("--output must be json or text");
    expect(usage(["show", "config", "--output", "xml"])).toBe("--output must be json or text");
    expect(parse(["show", "config", "--output", "text"])).toMatchObject({ name: "show-config" });
    expect(parse(["help"])).toEqual({ name: "help", verb: undefined });
    expect(parse(["help", "create"])).toEqual({ name: "help", verb: "create" });
    expect(parse(["cancel", "--help"])).toEqual({ name: "help", verb: "cancel" });
    expect(usageOf("cancel")).toEqual({
      usage: "cancel --keypair <file> --nonce <n> [--close] [--yes]",
      options: ["--url", "--priority-fee", "--keypair", "--yes", "--nonce", "--close", "--output", "--help"],
    });
    expect(usageOf("domain").usage).toBe("domain");
    expect(usageOf(undefined)).toEqual({ usage: COMMANDS, options: [] });
    expect(usageOf("fly")).toEqual({ usage: COMMANDS, options: [] });
    expect(USAGE).toBe(`usage: ${COMMANDS}`);
    expect(USAGE).toMatch(/\| help \[command\]$/);
    for (const verb of Object.keys(SHAPES)) {
      expect(usageOf(verb).options.length, verb).toBeGreaterThan(1);
    }
  });
});

describe("events", () => {
  it("follows new events at an interval only when asked", () => {
    expect(parse(["events", "--follow"])).toEqual({ name: "follow", url: DEFAULT_URL, priority: 0n, limit: 20, interval: 10 });
    expect(parse(["events", "--follow", "--interval", "3600", "--limit", "5"])).toMatchObject({ interval: 3600, limit: 5 });
    expect(usage(["events", "--follow", "--interval", "3601"])).toBe(`--interval must be an integer from 1 to ${MAX_FOLLOW_INTERVAL}`);
    expect(usage(["events", "--follow", "--interval", "0"])).toBe(`--interval must be an integer from 1 to ${MAX_FOLLOW_INTERVAL}`);
    expect(parse(["events", "--follow", "--interval", "1"])).toMatchObject({ interval: 1 });
    expect(usage(["events", "--interval", "5"])).toBe("--interval needs --follow");
  });

  it("reads a bounded transaction limit", () => {
    expect(parse(["events"])).toEqual({ name: "events", url: DEFAULT_URL, priority: 0n, limit: 20 });
    expect(parse(["events", "--limit", "1000"])).toMatchObject({ limit: 1000 });
    expect(MAX_EVENT_LIMIT).toBe(1000);
    expect(parseLimit("1")).toBe(1);
    for (const bad of ["0", "1001", "-1", "1.5", "x"]) {
      expect(() => parseLimit(bad)).toThrow("--limit must be an integer from 1 to 1000");
    }
    expect(usage(["events", "x"])).toBe("unexpected argument x");
  });
});
