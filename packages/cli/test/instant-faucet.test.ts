import { type Address, lamports } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askInstantFaucet, FAUCET_BLOCKED, FAUCET_BUSY, FAUCET_DEFAULT_URL, FAUCET_DOWN, FAUCET_SILENT, GH_HINT, FAUCET_PLAIN_URL, FAUCET_TIMED_OUT, FAUCET_TIMEOUT_MS, FAUCET_UNREACHABLE, type FaucetFetch, REFUSAL_LIMIT } from "../src/faucet.js";
import { AIRDROPS, airdropRefused, CLI_START, holdsEnough, INSTANT_REFUSED, instantSent, otherWays, setup } from "../src/wallet.js";
import { WALLET_START } from "../src/agent/wallet/account.js";
import { DEVNET_URL } from "../src/tokens.js";
import { cli, h, instant, runtime, transport, world } from "./harness.js";
import { fresh, ok } from "./agent-wallet-kit.js";

const SIGNATURE = "5".repeat(88);
const SENT = 500_000_000n;
const URL_ENV = "INTENT_ENGINE_FAUCET_URL";

type Call = { url: string; body: string; method: string };

function answering(status: number, body: unknown, calls: Call[], credit = false): FaucetFetch {
  return async (url, init) => {
    calls.push({ url, body: init.body, method: init.method });
    if (credit) {
      h.svm.airdrop((JSON.parse(init.body) as { address: Address }).address, lamports(SENT));
    }
    return { status, json: async () => body };
  };
}

describe("the instant faucet in setup", () => {
  let calls: Call[];

  beforeEach(async () => {
    await world();
    h.files.clear();
    for (const name of Object.keys(h.env)) {
      delete h.env[name];
    }
    h.airdropRefused = false;
    h.airdrops = [];
    calls = [];
  });

  afterEach(() => {
    instant.fetch = undefined;
    vi.useRealTimers();
  });

  it("asks first on devnet, sends only the address, and reports the drip", async () => {
    instant.fetch = answering(200, { signature: SIGNATURE, lamports: String(SENT) }, calls, true);
    const made = (await cli(["setup"], {})).json();
    const address = made["address"] as Address;
    expect(calls).toEqual([{ url: FAUCET_DEFAULT_URL + "/api/drip", body: JSON.stringify({ address }), method: "POST" }]);
    expect(made).toMatchObject({ faucet: { lamports: String(SENT), signature: SIGNATURE }, sol: "0.5", next: instantSent("0.5") + holdsEnough("0.5", CLI_START) });
    expect(h.airdrops).toEqual([]);
  });

  it("falls back to the airdrop when the faucet answers 429 or 503, and shows its sentence", async () => {
    for (const [status, body] of [[429, { error: "Slow down.", retry_after: 30 }], [503, { error: "Empty for now." }]] as const) {
      h.files.clear();
      h.airdrops = [];
      instant.fetch = answering(status, body, calls);
      const made = (await cli(["setup"], {})).json();
      expect(made).toMatchObject({ faucet: { refused: body.error }, sol: "1", next: INSTANT_REFUSED + holdsEnough("1", CLI_START) });
      expect(made["faucet"]).not.toHaveProperty("lamports");
      expect(h.airdrops).toHaveLength(1);
    }
  });

  it("keeps going to the other faucets when nothing arrives", async () => {
    h.airdropRefused = true;
    instant.fetch = answering(503, { error: "Empty." }, calls);
    const made = (await cli(["setup"], {})).json();
    expect(made).toMatchObject({ faucet: { refused: "Empty." }, sol: "0" });
    expect(made["next"]).toContain("your wallet holds no SOL yet and devnet refused the airdrop");
    expect(made["next"]).not.toContain(INSTANT_REFUSED);
    expect(h.airdrops).toHaveLength(AIRDROPS.length);
  });

  it("falls back when the network fails", async () => {
    instant.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const made = (await cli(["setup"], {})).json();
    expect(made).toMatchObject({ faucet: { refused: FAUCET_UNREACHABLE }, sol: "1" });
    expect(h.airdrops).toHaveLength(1);
  });

  it("gives up after the timeout and falls back", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const silent: FaucetFetch = (_url, init) => {
      signal = init.signal;
      return new Promise(() => undefined);
    };
    const waiting = askInstantFaucet(silent, {}, "address");
    await vi.advanceTimersByTimeAsync(FAUCET_TIMEOUT_MS - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await waiting).toEqual({ refused: FAUCET_TIMED_OUT });
    expect(signal?.aborted).toBe(true);
    expect(FAUCET_TIMEOUT_MS).toBe(45000);
  });

  it("never asks off devnet", async () => {
    instant.fetch = answering(200, { signature: SIGNATURE, lamports: String(SENT) }, calls, true);
    for (const target of ["mainnet-beta", "localnet", "http://flag"]) {
      h.files.clear();
      const made = (await cli(["setup", "--url", target], {})).json();
      expect(made).not.toHaveProperty("faucet");
    }
    expect(calls).toEqual([]);
  });

  it("does not ask when the wallet already holds enough", async () => {
    instant.fetch = answering(200, { signature: SIGNATURE, lamports: String(SENT) }, calls, true);
    await cli(["setup"], {});
    await cli(["setup"], {});
    expect(calls).toHaveLength(1);
  });

  it("is turned off by the value off, and reads another url from the environment", async () => {
    instant.fetch = answering(200, { signature: SIGNATURE, lamports: String(SENT) }, calls, true);
    h.env[URL_ENV] = "off";
    const made = (await cli(["setup"], {})).json();
    expect(calls).toEqual([]);
    expect(made).not.toHaveProperty("faucet");
    h.files.clear();
    h.env[URL_ENV] = "https://" + "drip.example/base/";
    await cli(["setup"], {});
    expect(calls.map((call) => call.url)).toEqual(["https://" + "drip.example/base/api/drip"]);
  });

  it("refuses a plain http url that is not local, and allows localhost", async () => {
    instant.fetch = answering(200, { signature: SIGNATURE, lamports: String(SENT) }, calls, true);
    h.env[URL_ENV] = "http://" + "drip.example";
    const made = (await cli(["setup"], {})).json();
    expect(made).toMatchObject({ faucet: { refused: FAUCET_PLAIN_URL }, sol: "1" });
    expect(calls).toEqual([]);
    for (const local of ["http://" + "localhost:8787", "http://" + "127.0.0.1:8787", "http://" + "[::1]:8787"]) {
      expect(await askInstantFaucet(answering(200, { signature: SIGNATURE, lamports: String(SENT) }, calls), { [URL_ENV]: local }, "address")).toHaveProperty("lamports");
    }
    expect(calls.map((call) => call.url)).toEqual(["http://" + "localhost:8787/api/drip", "http://" + "127.0.0.1:8787/api/drip", "http://" + "[::1]:8787/api/drip"]);
    expect(await askInstantFaucet(instant.fetch, { [URL_ENV]: "not a url" }, "address")).toHaveProperty("refused");
  });

  it("cuts a long refusal and escapes control characters", async () => {
    instant.fetch = answering(429, { error: "x".repeat(500) }, calls);
    const long = (await cli(["setup"], {})).json();
    expect((long["faucet"] as { refused: string }).refused).toBe("x".repeat(REFUSAL_LIMIT));
    h.files.clear();
    instant.fetch = answering(503, { error: "line\nbreak\u001b[31m red‮" }, calls);
    const hidden = (await cli(["setup"], {})).json();
    expect((hidden["faucet"] as { refused: string }).refused).toBe("line\\u000abreak\\u001b[31m red\\u202e");
  });

  it("refuses a 200 whose fields are not a signature and an amount", async () => {
    for (const body of [{ signature: "evil\nline", lamports: "1" }, { signature: SIGNATURE, lamports: "lots" }, { signature: SIGNATURE }, null, "text"]) {
      expect(await askInstantFaucet(answering(200, body, []), {}, "address")).toHaveProperty("refused");
    }
  });

  it("gives a plain sentence without a status when the faucet sends no error", async () => {
    const cases: [number, unknown, string][] = [
      [403, null, FAUCET_BLOCKED],
      [429, "slow", FAUCET_BUSY],
      [503, null, FAUCET_DOWN],
      [405, {}, FAUCET_SILENT],
    ];
    for (const [status, body, sentence] of cases) {
      const refused = await askInstantFaucet(answering(status, body, []), {}, "address");
      expect(refused).toEqual({ refused: sentence });
      expect(sentence).not.toMatch(/status|\d/);
    }
  });

  it("keeps the no-SOL next within two sentences, with the other routes in other_ways", async () => {
    h.airdropRefused = true;
    for (const [status, body] of [[403, null], [429, "slow"], [503, null], [429, { error: "Slow down." }]] as const) {
      h.files.clear();
      instant.fetch = answering(status, body, calls);
      const made = (await cli(["setup"], {})).json();
      const address = made["address"] as string;
      expect(made["sol"]).toBe("0");
      expect(made["next"]).toBe(airdropRefused(address));
      expect((made["next"] as string).split(/[.!?](?:\s|$)/).filter((part) => part !== "").length).toBeLessThanOrEqual(2);
      expect(made["other_ways"]).toEqual(otherWays(address, GH_HINT));
      expect(made["next"]).not.toContain("GitHub");
    }
  });

  it("is skipped by setup called directly without a fetch", async () => {
    const made = await setup(transport, runtime({}), DEVNET_URL, undefined, false, undefined, undefined, CLI_START, CLI_START, undefined, { fetch: undefined, env: {} });
    expect(made).not.toHaveProperty("faucet");
  });

  it("is used by the MCP wallet setup with the same fields", async () => {
    instant.fetch = answering(503, { error: "Empty." }, calls);
    const client = await fresh();
    const made = await ok(client, "wallet_setup");
    expect(made).toMatchObject({ faucet: { refused: "Empty." }, sol: "1" });
    expect(made["next"]).toContain(INSTANT_REFUSED);
    expect(calls).toHaveLength(1);
  });

  it("is used by the MCP wallet setup on a 200", async () => {
    instant.fetch = answering(200, { signature: SIGNATURE, lamports: String(SENT) }, calls, true);
    const client = await fresh();
    const made = await ok(client, "wallet_setup");
    expect([calls.length, h.airdrops]).toEqual([1, []]);
    expect(made).toMatchObject({ faucet: { lamports: String(SENT), signature: SIGNATURE }, sol: "0.5", next: instantSent("0.5") + holdsEnough("0.5", WALLET_START) });
  });
});
