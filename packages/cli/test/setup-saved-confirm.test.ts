import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import { define, invoke, OutputMismatch } from "../src/agent/actions.js";
import { callOf, claimsOf } from "../src/agent/claims.js";
import { InvalidInput, amount, object } from "../src/agent/schema.js";
import { walletSetup } from "../src/agent/wallet/account.js";
import { redactUrl } from "../src/render.js";
import { defaultWallet, settingsPath } from "../src/wallet.js";
import { h, HOME, transport, world } from "./harness.js";
import { call, connect, ok, preset } from "./agent-wallet-kit.js";
import { takeMisses } from "./answer-guard.js";

const SETTINGS = settingsPath(HOME);
const WALLET = defaultWallet(HOME);
const SECOND = "https://second-node.example:8899/?api-key=hidden";

beforeEach(async () => {
  await world();
  h.files.clear();
  for (const name of Object.keys(h.env)) {
    delete h.env[name];
  }
  preset(NATIVE_MINT);
  preset(DEVNET_TEST_MINT);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const served = () => connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);

describe("wallet_setup with a saved confirm-url", () => {
  it("answers, names the second node without its key, and keeps it in the settings file", async () => {
    h.files.set(SETTINGS, JSON.stringify({ url: "devnet", keypair: WALLET, "confirm-url": SECOND }));
    const made = await ok(await served(), "wallet_setup");
    expect(made["confirm_url"]).toBe(redactUrl(SECOND));
    expect(JSON.stringify(made)).not.toContain("hidden");
    expect(JSON.parse(h.files.get(SETTINGS) ?? "{}")).toMatchObject({ "confirm-url": SECOND });
    expect(await takeMisses()).toEqual([]);
  });

  it("answers as before, with no confirm_url, when the settings hold none", async () => {
    h.files.set(SETTINGS, JSON.stringify({ url: "devnet", keypair: WALLET }));
    const made = await ok(await served(), "wallet_setup");
    expect(made).not.toHaveProperty("confirm_url");
    expect(JSON.parse(h.files.get(SETTINGS) ?? "{}")).not.toHaveProperty("confirm-url");
  });
});

describe("a failure after setup wrote", () => {
  const failing = async (error: Error) => {
    h.through = { ...transport, getAccount: async () => { throw error; } };
    const client = await served();
    const failed = await call(client, "wallet_setup");
    expect(failed.error).toBe(true);
    expect(h.files.has(SETTINGS)).toBe(true);
    return failed.value;
  };

  it.each([
    ["Failed", new Error("node down")],
    ["Unreachable", new TypeError("fetch failed")],
    ["RateLimited", new Error("429 Too Many Requests")],
  ])("names every file saved in wrote, whatever the code: %s", async (code, error) => {
    const problem = await failing(error);
    expect(problem["code"]).toBe(code);
    expect(problem["wrote"]).toEqual([`saved ${WALLET}`, `saved ${SETTINGS}`]);
  });

  it("lists the new key, the backup copy and then the settings file when it replaced a different one", async () => {
    h.files.set(SETTINGS, JSON.stringify({ url: "devnet", keypair: WALLET, extra: 1 }));
    const problem = await failing(new TypeError("fetch failed"));
    const wrote = problem["wrote"] as string[];
    expect(wrote).toHaveLength(3);
    expect(wrote[0]).toBe(`saved ${WALLET}`);
    expect(wrote[1]?.startsWith(`saved ${SETTINGS}.`) && wrote[1].endsWith(".bak")).toBe(true);
    expect(wrote[2]).toBe(`saved ${SETTINGS}`);
  });

  it("keeps wrote whole at realistic Windows path lengths and leaves the schema mismatch text first", async () => {
    const long = ["C:", "Users", "someone-with-a-long-name", "AppData", "Roaming", "intent-engine", ...Array<string>(12).fill("nested"), "config.json"].join(String.fromCharCode(92));
    const lying = define({
      name: "lying",
      title: "t",
      description: "d",
      effect: "submit",
      input: object({}),
      output: object({ n: amount() }),
      run: async (_ctx, _input, call) => {
        call.wrote.push(`saved ${long}`, `saved ${long}.bak`, `deleted ${long}.key`);
        return { n: 5 };
      },
    });
    const outcome = await invoke(lying, { transport: {} as never, relay: undefined, agent: undefined, claims: claimsOf() }, {});
    expect(outcome).toMatchObject({ ok: false, problem: { wrote: [`saved ${long}`, `saved ${long}.bak`, `deleted ${long}.key`] } });
    expect((outcome as { problem: { untrustedDetail: string } }).problem.untrustedDetail).toBe("lying produced output outside its schema: n: must be a whole number written as a decimal string");
  });

  it("says the settings file was saved when the answer then fails its output check", async () => {
    const old = JSON.stringify({ url: "devnet", keypair: WALLET, "confirm-url": SECOND });
    h.files.set(SETTINGS, old);
    const client = await served();
    vi.spyOn(walletSetup.output, "read").mockImplementation(() => {
      throw new InvalidInput([{ path: "confirm_url", message: "is not a known field" }]);
    });
    const failed = await call(client, "wallet_setup");
    expect(failed.error).toBe(true);
    expect(String(failed.value["untrustedDetail"])).toContain("outside its schema");
    expect(h.files.get(SETTINGS)).not.toBe(old);
    expect((failed.value["wrote"] as string[]).at(-1)).toBe(`saved ${SETTINGS}`);
    expect((await takeMisses()).length).toBe(1);
  });

  it("records nothing for a call that wrote nothing", async () => {
    const lying = define({ name: "lying", title: "t", description: "d", effect: "read", input: object({}), output: object({ n: amount() }), run: async () => ({ n: 5 }) });
    const outcome = await invoke(lying, { transport: {} as never, relay: undefined, agent: undefined, claims: claimsOf() }, {});
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome).not.toHaveProperty("problem.wrote");
    expect(new OutputMismatch("x", new InvalidInput([])).message).toBe("x produced output outside its schema: ");
    expect(callOf().wrote).toEqual([]);
  });
});
