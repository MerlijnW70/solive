import { describe, expect, it } from "vitest";
import { U64_MAX } from "@intent-engine/core/internal";
import { MAX_PRIORITY_PRICE } from "../src/compute.js";
import {
  DEFAULT_URL,
  parse,
  parseFeeBps,
  parseKinds,
  parseLimit,
  MAX_EVENT_LIMIT,
  parsePause,
  UsageError,
  clusterUrl,
  ENV_KEYPAIR,
  ENV_URL,
  MAX_FOLLOW_INTERVAL,
  outputOf,
  parsePriority,
  SHAPES,
  COMMANDS,
  USAGE,
  usageOf,
} from "../src/args.js";
import { MINT_A, OWNER, usage } from "./args-kit.js";

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
      usage: "cancel [--keypair <file>] --nonce <n> [--close] [--yes]",
      options: ["--url", "--priority-fee", "--keypair", "--yes", "--nonce", "--close", "--output", "--help", "--debug"],
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
