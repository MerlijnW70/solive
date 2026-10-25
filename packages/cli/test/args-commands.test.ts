import { describe, expect, it } from "vitest";
import { U64_MAX } from "@intent-engine/core/internal";
import {
  DEFAULT_URL,
  AGENT_DEFAULT_HOURLY_LAMPORTS,
  AGENT_NEEDS_OWNERS,
  RELAY_NEEDS_FEES,
  RELAY_DEFAULT_HOURLY_LAMPORTS,
  RELAY_DEFAULT_TTL,
  parse,
  TOKEN_SIDES,
  WALLET_LIMITS_NEED_WALLET,
} from "../src/args.js";
import { DEVNET_TEST_MINT as TEST_TOKEN, NATIVE_MINT } from "@intent-engine/core";
import { MINT_A, MINT_B, OWNER, usage } from "./args-kit.js";

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
      yes: false,
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
