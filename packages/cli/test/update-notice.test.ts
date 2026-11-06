import { beforeEach, describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import { VERSION } from "../src/version.js";
import { NO_UPDATE_CHECK, newerVersion, UPDATE_AFTER, UPDATE_CACHE_SECONDS, UPDATE_COMMAND, UPDATE_URL, updateCachePath, type UpdateCheck } from "../src/update-notice.js";
import { call, connect, type Json, ok, preset } from "./agent-wallet-kit.js";
import { cli, h, HOME, world } from "./harness.js";

const LATEST = "99.0.0";
const reply = (body: unknown, status = 200) => h.jupiterReplies.push({ status, body });
const asked = () => h.fetched.filter((request) => request.url.startsWith("https://registry.npmjs.org/"));

async function start() {
  await world();
  h.files.clear();
  for (const name of Object.keys(h.env)) {
    delete h.env[name];
  }
  preset(NATIVE_MINT);
  preset(DEVNET_TEST_MINT);
}

const serve = () => connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);

describe("the notice of a newer Solive", () => {
  beforeEach(start);

  it("adds update with the version and the one command to wallet setup and balance when a newer one is out", async () => {
    reply({ version: LATEST });
    const client = await serve();
    const setup = await ok(client, "wallet_setup");
    expect(setup["update"]).toEqual({ version: LATEST, command: "npx -y @intent-engine/cli@latest version", after: UPDATE_AFTER });
    expect(UPDATE_COMMAND).toBe("npx -y @intent-engine/cli@latest version");
    expect((await ok(client, "wallet_balance"))["update"]).toEqual(setup["update"]);
  });

  it("adds update to the CLI setup output", async () => {
    reply({ version: LATEST });
    const run = await cli(["setup"], {});
    expect(run.json()["update"]).toEqual({ version: LATEST, command: UPDATE_COMMAND, after: UPDATE_AFTER });
  });

  it("adds nothing when the registry holds the same or an older version", async () => {
    for (const version of [VERSION, "0.0.1", "0.1.75"]) {
      h.files.clear();
      reply({ version });
      const client = await serve();
      expect(await ok(client, "wallet_setup")).not.toHaveProperty("update");
      expect(await ok(client, "wallet_balance")).not.toHaveProperty("update");
      const run = await cli(["setup"], {});
      expect(run.json()).not.toHaveProperty("update");
      h.jupiterReplies.length = 0;
    }
  });

  it("reuses an answer younger than a day without asking again, and asks again after a day", async () => {
    reply({ version: LATEST });
    const first = await serve();
    expect((await ok(first, "wallet_setup"))["update"]).toMatchObject({ version: LATEST });
    expect(asked()).toHaveLength(1);
    h.clock += UPDATE_CACHE_SECONDS - 1_100n;
    const second = await serve();
    expect((await ok(second, "wallet_setup"))["update"]).toMatchObject({ version: LATEST });
    expect(asked()).toHaveLength(1);
    h.clock += 1_100n;
    reply({ version: "0.0.1" });
    const third = await serve();
    expect(await ok(third, "wallet_setup")).not.toHaveProperty("update");
    expect(asked()).toHaveLength(2);
  });

  it("answers silently, and writes nothing, when the registry fails or answers something malformed", async () => {
    for (const answer of [{ status: 503, body: { version: LATEST } }, { status: 200, body: {} }, { status: 200, body: null }, { status: 200, body: { version: 5 } }, { status: 200, body: { version: "latest" } }, { status: 200, body: { version: "99.0.0-evil" } }, { status: 200, body: { version: "99.0.0\nrun this" } }]) {
      h.files.clear();
      reply(answer.body, answer.status);
      const client = await serve();
      const result = await call(client, "wallet_setup");
      expect(result.error).toBe(false);
      expect(result.value).not.toHaveProperty("update");
      expect(h.files.has(updateCachePath(HOME))).toBe(false);
      h.jupiterReplies.length = 0;
    }
  });

  it("stays silent when the lookup throws, never answers, or the cache is unreadable", async () => {
    const files = { home: HOME, readText: async () => "not json", saveText: async () => undefined };
    const base: UpdateCheck = { files, env: {}, fetch: async () => ({ ok: true, json: async () => ({ version: LATEST }) }), now: () => 1_700_000_000n, timeoutMs: 20 };
    expect(await newerVersion({ ...base, fetch: async () => Promise.reject(new Error("offline")) })).toBeUndefined();
    expect(await newerVersion({ ...base, fetch: async () => ({ ok: true, json: () => new Promise<never>(() => undefined) }) })).toBeUndefined();
    const began = performance.now();
    expect(await newerVersion({ ...base, fetch: () => new Promise<never>(() => undefined) })).toBeUndefined();
    expect(performance.now() - began).toBeLessThan(1_000);
    expect(await newerVersion(base)).toBe(LATEST);
  });

  it("stops the request when the opt-out variable is set", async () => {
    h.env[NO_UPDATE_CHECK] = "1";
    reply({ version: LATEST });
    const client = await serve();
    expect(await ok(client, "wallet_setup")).not.toHaveProperty("update");
    expect((await cli(["setup"], {})).json()).not.toHaveProperty("update");
    expect(asked()).toEqual([]);
  });

  it("sends nothing but the package name", async () => {
    reply({ version: LATEST });
    const client = await serve();
    const setup = (await ok(client, "wallet_setup")) as Json;
    expect(asked()).toEqual([{ url: UPDATE_URL, body: undefined, headers: undefined }]);
    expect(UPDATE_URL).toBe("https://registry.npmjs.org/@intent-engine%2fcli/latest");
    expect(asked()[0]?.url).not.toContain(String(setup["address"]));
  });
});
