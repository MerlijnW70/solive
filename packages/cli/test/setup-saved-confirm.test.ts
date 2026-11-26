import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import { define, invoke, OutputMismatch } from "../src/agent/actions.js";
import { callOf, claimsOf } from "../src/agent/claims.js";
import { InvalidInput, amount, object } from "../src/agent/schema.js";
import { walletSetup } from "../src/agent/wallet/account.js";
import { redactUrl } from "../src/render.js";
import { defaultWallet, settingsPath, setup } from "../src/wallet.js";
import { funded, h, HOME, runtime, world } from "./harness.js";
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
  it("names the settings file in the error when the node fails after the write", async () => {
    const owner = await funded();
    const live = runtime({ "owner.json": owner });
    const real = live.transport("devnet");
    const broken = { ...real, getAccount: async () => { throw new Error("node down"); } } as typeof real;
    const failure = (await setup(broken, live, "devnet", "owner.json").then(() => new Error("no failure"), (error: unknown) => error)) as Error;
    expect(failure.message).toContain("node down");
    expect(h.files.has(SETTINGS)).toBe(true);
    expect(failure.message).toContain(`setup had already saved ${SETTINGS}`);
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
    const detail = String(failed.value["untrustedDetail"]);
    expect(detail).toContain("outside its schema");
    expect(h.files.get(SETTINGS)).not.toBe(old);
    expect(detail).toContain(`it had already saved ${SETTINGS}`);
    expect((await takeMisses()).length).toBe(1);
  });

  it("lists in a mismatch error what the action wrote, and nothing when it wrote nothing", async () => {
    const lying = define({ name: "lying", title: "t", description: "d", effect: "submit", input: object({}), output: object({ n: amount() }), run: async (_ctx, _input, call) => { call.wrote.push("saved /a", "sent transaction b"); return { n: 5 }; } });
    const ctx = { transport: {} as never, relay: undefined, agent: undefined, claims: claimsOf() };
    const outcome = await invoke(lying, ctx, {});
    expect(outcome).toMatchObject({ ok: false, problem: { untrustedDetail: expect.stringContaining("it had already saved /a, sent transaction b, and that stays") } });
    expect(new OutputMismatch("x", new InvalidInput([])).message).not.toContain("already");
    expect(callOf().wrote).toEqual([]);
  });
});
