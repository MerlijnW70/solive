import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_URL, ENV_URL, parse } from "../src/args.js";
import { NO_WALLET, PASS_KEYPAIR } from "../src/arg-values.js";
import { askInstantFaucet, FAUCET_DAILY_SIGN, type FaucetFetch, waitFor } from "../src/faucet.js";
import { EXIT_FAILED, EXIT_USAGE, main, NO_NODE_SET, unreachable } from "../src/main.js";
import { whyAirdrop, WHY_DAILY, WHY_LIMITED, whyShort } from "../src/wallet.js";
import { cli, h, instant, runtime, transport, world } from "./harness.js";
import { DEVNET_URL } from "../src/tokens.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const service = readFileSync(join(ROOT, "services/faucet/src/drip.ts"), "utf8");
const said = (name: string): string => new RegExp(`${name}: "([^"]+)"`).exec(service)?.[1] ?? "";
const DAILY = said("daily");
const RECENT = said("recent");

const answering =
  (status: number, body: unknown): FaucetFetch =>
  async () => ({ status, json: async () => body });

const askedWith = (status: number, body: unknown) => askInstantFaucet(answering(status, body), {}, "a");

describe("the faucet's refusal shows the real wait", () => {
  beforeEach(async () => {
    await world();
    h.files.clear();
    for (const name of Object.keys(h.env)) {
      delete h.env[name];
    }
    h.airdropRefused = false;
  });

  afterEach(() => {
    instant.fetch = undefined;
  });

  it("reads the texts it rewrites from the service as deployed", () => {
    expect(DAILY).toContain("wait retry_after seconds");
    expect(DAILY).toContain(FAUCET_DAILY_SIGN);
    expect(RECENT).toContain("wait retry_after seconds");
    expect(RECENT).not.toContain(FAUCET_DAILY_SIGN);
  });

  it("puts the wait in place of the field name, in seconds, minutes or hours", async () => {
    expect(await askedWith(429, { error: DAILY, retry_after: 85_213 })).toEqual({
      refused: DAILY.replace("retry_after seconds", "about 24 hours"),
      kind: "daily",
    });
    expect(await askedWith(429, { error: RECENT, retry_after: 90 })).toEqual({ refused: RECENT.replace("retry_after seconds", "90 seconds"), kind: "limited" });
    expect(await askedWith(429, { error: RECENT, retry_after: 3_000 })).toMatchObject({ refused: expect.stringContaining("wait about 50 minutes before") });
    expect(waitFor(1)).toBe("1 second");
    expect(waitFor(2)).toBe("2 seconds");
    expect(waitFor(119)).toBe("119 seconds");
    expect(waitFor(120)).toBe("about 2 minutes");
    expect(waitFor(7_199)).toBe("about 120 minutes");
    expect(waitFor(7_200)).toBe("about 2 hours");
  });

  it("says to try again later when the faucet gave no wait, and never prints the field name", async () => {
    for (const body of [{ error: DAILY }, { error: DAILY, retry_after: "soon" }, { error: DAILY, retry_after: 0 }, { error: DAILY, retry_after: -5 }, { error: DAILY, retry_after: 1.5 }]) {
      const got = await askedWith(429, body);
      expect(got).toMatchObject({ kind: "daily" });
      expect((got as { refused: string }).refused).toContain("so try again later, or get devnet SOL at https://faucet.solana.com.");
      expect((got as { refused: string }).refused).not.toContain("retry_after");
    }
  });

  it("treats an absurd wait as no wait", async () => {
    for (const retry_after of [2_501_999_792_983 * 3600, 8 * 24 * 3600, Number.MAX_SAFE_INTEGER]) {
      const got = (await askedWith(429, { error: DAILY, retry_after })) as { refused: string };
      expect(got.refused).toContain("so try again later");
      expect(got.refused).not.toMatch(/about \d+ hours/);
    }
    expect(((await askedWith(429, { error: DAILY, retry_after: 7 * 24 * 3600 })) as { refused: string }).refused).toContain("about 168 hours");
  });

  it("names a whole-faucet limit as one, and keeps the per-address limit for the others", () => {
    expect(whyShort({ refused: "x", kind: "daily" }, false, DEVNET_URL)).toBe(WHY_DAILY);
    expect(whyShort({ refused: "x", kind: "limited" }, false, DEVNET_URL)).toBe(WHY_LIMITED);
    expect(WHY_DAILY).not.toContain("address or network");
    expect(WHY_DAILY).toContain("for every address");
  });

  it("shows both in the setup result", async () => {
    h.airdropRefused = true;
    instant.fetch = answering(429, { error: DAILY, retry_after: 7_200 });
    const made = (await cli(["setup"], {})).json();
    expect(made["faucet"]).toEqual({ refused: DAILY.replace("retry_after seconds", "about 2 hours") });
    expect(made["why"]).toBe(`${WHY_DAILY}; ${whyAirdrop(DEVNET_URL)}`);
  });
});

describe("a fresh home", () => {
  beforeEach(async () => {
    await world();
    h.files.clear();
    for (const name of Object.keys(h.env)) {
      delete h.env[name];
    }
  });

  it("keeps the local node as the default and says nothing chose it when it is down", async () => {
    expect(parse(["show", "config"], {})).toMatchObject({ url: DEFAULT_URL });
    const down = {
      ...runtime({}),
      transport: () => ({
        ...transport,
        getAccount: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    };
    const unset: string[] = [];
    expect(await main(["show", "config"], down, { out: () => undefined, err: (text) => unset.push(text) })).toBe(EXIT_FAILED);
    expect(unset).toEqual([NO_NODE_SET(DEFAULT_URL)]);
    expect(NO_NODE_SET(DEFAULT_URL)).toContain("intent-engine setup");
    expect(NO_NODE_SET(DEFAULT_URL)).toContain("--url devnet");
    expect(unset[0]).not.toContain("check your network");
  });

  it("blames the network only when the url was chosen, by flag, equals form or environment", async () => {
    const lines: string[] = [];
    const base = runtime({});
    const down = (env: Record<string, string>) => ({
      ...base,
      env: { ...base.env, ...env },
      transport: () => ({
        ...transport,
        getAccount: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    });
    const run = (argv: string[], env: Record<string, string> = {}) => main(argv, down(env), { out: () => undefined, err: (text) => lines.push(text) });
    expect(await run(["show", "config", "--url", "localnet"])).toBe(EXIT_FAILED);
    expect(await run(["show", "config", `--url=${DEFAULT_URL}`])).toBe(EXIT_FAILED);
    expect(await run(["show", "config"], { [ENV_URL]: DEFAULT_URL })).toBe(EXIT_FAILED);
    expect(lines).toEqual([unreachable(DEFAULT_URL), unreachable(DEFAULT_URL), unreachable(DEFAULT_URL)]);
  });

  it("says to run setup when no wallet is set, from the command line and for the commands that need one", async () => {
    for (const argv of [["create", "attested"], ["deliver"], ["judge"], ["cancel", "--nonce", "1"]]) {
      const run = await cli(argv, {});
      expect([run.code, run.err], argv.join(" ")).toEqual([EXIT_USAGE, NO_WALLET]);
    }
    expect(NO_WALLET).toContain("intent-engine setup");
    const submit = ["signed", "submit", "--file", "s.json"];
    expect(() => parse(submit, {})).toThrow(NO_WALLET);
    expect(() => parse(submit, { INTENT_ENGINE_KEYPAIR: "wallet.json" })).toThrow(PASS_KEYPAIR);
    expect(PASS_KEYPAIR).not.toContain("no wallet");
    expect(NO_WALLET.startsWith("missing --keypair")).toBe(true);
  });
});
