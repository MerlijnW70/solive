import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import { ENV_KEYPAIR, ENV_URL } from "../src/args.js";
import { EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { defaultWallet, settingsPath, setup, withSettings } from "../src/wallet.js";
import { cli, funded, h, HOME, runtime, world } from "./harness.js";
import { call, connect, ok, preset } from "./agent-wallet-kit.js";

const SETTINGS = settingsPath(HOME);
const WALLET = defaultWallet(HOME);

const warned: string[] = [];

beforeEach(async () => {
  await world();
  h.files.clear();
  for (const name of Object.keys(h.env)) {
    delete h.env[name];
  }
  warned.length = 0;
  preset(NATIVE_MINT);
  preset(DEVNET_TEST_MINT);
  vi.spyOn(process.stderr, "write").mockImplementation(((text: string) => {
    warned.push(String(text));
    return true;
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a partial settings file", () => {
  it("lets a command with its own url and keypair run when the file holds only url", async () => {
    const owner = await funded();
    h.files.set(SETTINGS, JSON.stringify({ url: "devnet" }));
    const ran = await cli(["balance", "--keypair", "k.json", "--url", "devnet"], { "k.json": owner });
    expect([ran.code, ran.err]).toEqual([EXIT_OK, ""]);
    expect(ran.json()).toMatchObject({ address: owner.address });
    expect(warned).toEqual([]);
  });

  it("takes each missing field from flags, env or the built-in default", async () => {
    const owner = await funded();
    h.files.set(SETTINGS, JSON.stringify({ keypair: "k.json" }));
    const ran = await cli(["balance"], { "k.json": owner });
    expect(ran.json()).toMatchObject({ address: owner.address });
    const env = await withSettings(runtime({}), {});
    expect(env[ENV_URL]).toBeUndefined();
    expect(env[ENV_KEYPAIR]).toBe("k.json");
    h.files.set(SETTINGS, "{}");
    expect(await withSettings(runtime({}), {})).toMatchObject({ [ENV_URL]: undefined, [ENV_KEYPAIR]: undefined });
  });

  it("refuses a command that needs a keypair with a message that names the field and the way to set it", async () => {
    h.files.set(SETTINGS, JSON.stringify({ url: "devnet" }));
    const ran = await cli(["cancel", "--nonce", "1"], {});
    expect(ran.code).toBe(EXIT_USAGE);
    expect(ran.err).toContain("no keypair is set");
    expect(ran.err).toContain("keypair field");
    expect(ran.err).toContain("--keypair <file>");
    expect(ran.err).not.toContain("delete");
  });
});

describe("a broken settings file", () => {
  it("is refused with the file and the field when a command needs that field", async () => {
    h.files.set(SETTINGS, JSON.stringify({ url: "devnet", keypair: 7 }));
    const ran = await cli(["balance"], {});
    expect(ran.code).toBe(EXIT_USAGE);
    expect(ran.err).toContain(SETTINGS);
    expect(ran.err).toContain('"keypair" field that must be text, not number');
    await expect(withSettings(runtime({}), {})).rejects.toThrow('"keypair" field');
    h.files.set(SETTINGS, JSON.stringify({ url: ["x"], keypair: "k" }));
    await expect(withSettings(runtime({}), {})).rejects.toThrow('"url" field that must be text, not a list');
    h.files.set(SETTINGS, JSON.stringify({ url: "devnet", keypair: null }));
    await expect(withSettings(runtime({}), {})).rejects.toThrow("not null");
  });

  it("is refused when it is not JSON or not an object", async () => {
    for (const text of ["not json", "[]", "7"]) {
      h.files.set(SETTINGS, text);
      const ran = await cli(["balance"], {});
      expect(ran.code).toBe(EXIT_USAGE);
      expect(ran.err).toContain(SETTINGS);
    }
  });

  it("never stops a command whose url and keypair come from flags, and only warns on stderr", async () => {
    const owner = await funded();
    for (const text of ["not json", "[]", JSON.stringify({ url: 1, keypair: 2, "confirm-url": 3 })]) {
      warned.length = 0;
      h.files.set(SETTINGS, text);
      const ran = await cli(["balance", "--keypair", "k.json", "--url", "devnet"], { "k.json": owner });
      expect([ran.code, ran.err]).toEqual([EXIT_OK, ""]);
      expect(ran.json()).toMatchObject({ address: owner.address });
      expect(warned.join("")).toContain(SETTINGS);
    }
  });

  it("folds every ignored problem into exactly one stderr line that names the file and each field", async () => {
    const owner = await funded();
    h.files.set(SETTINGS, JSON.stringify({ url: 1, keypair: 2, "confirm-url": 3 }));
    const ran = await cli(["balance", "--keypair", "k.json", "--url", "devnet"], { "k.json": owner });
    expect(ran.code).toBe(EXIT_OK);
    const lines = warned.join("").split("\n").filter((line) => line !== "");
    expect(lines).toHaveLength(1);
    for (const field of ["url", "keypair", "confirm-url"]) {
      expect(lines[0]).toContain(`"${field}" field that must be text`);
    }
    expect(lines[0]).toContain(SETTINGS);
  });

  it("words a file that is not JSON or not an object in one fixed way", async () => {
    h.files.set(SETTINGS, "{ \"url\": \"devnet\", }");
    await expect(withSettings(runtime({}), {})).rejects.toThrow(`${SETTINGS} is not valid JSON; fix the file`);
    h.files.set(SETTINGS, "[]");
    await expect(withSettings(runtime({}), {})).rejects.toThrow(`${SETTINGS} holds a list, not a JSON object; fix the file`);
    h.files.set(SETTINGS, "7");
    await expect(withSettings(runtime({}), {})).rejects.toThrow(`${SETTINGS} holds number, not a JSON object; fix the file`);
  });

  it("reads the saved confirm-url only for the commands that take it", async () => {
    h.files.set(SETTINGS, JSON.stringify({ url: "devnet", keypair: "k.json", "confirm-url": 3 }));
    const need = ["url", "keypair", "confirm-url"] as const;
    await expect(withSettings(runtime({}), {}, { need })).rejects.toThrow('"confirm-url" field');
    expect(await withSettings(runtime({}), {}, { need, supplied: ["confirm-url"] })).toMatchObject({ [ENV_KEYPAIR]: "k.json" });
    expect(await withSettings(runtime({}), {}, { need: ["url", "keypair"] })).toMatchObject({ [ENV_KEYPAIR]: "k.json" });
  });

  it("lets the environment stand in for the flags", async () => {
    const owner = await funded();
    h.files.set(SETTINGS, JSON.stringify({ url: 1, keypair: 2 }));
    h.env[ENV_URL] = "devnet";
    h.env[ENV_KEYPAIR] = "k.json";
    const ran = await cli(["balance"], { "k.json": owner });
    expect(ran.code).toBe(EXIT_OK);
    expect(warned.join("")).toContain(SETTINGS);
  });
});

describe("setup keeps a backup", () => {
  it("copies a different file to a sibling, reads it back, then writes, and names it", async () => {
    const old = JSON.stringify({ url: "devnet", keypair: "owner.json", extra: 1 });
    h.files.set(SETTINGS, old);
    const owner = await funded();
    const made = (await cli(["setup", "--keypair", "owner.json"], { "owner.json": owner })).json();
    const backup = made["settings_backup"] as string;
    expect(backup.startsWith(`${SETTINGS}.`)).toBe(true);
    expect(backup.endsWith(".bak")).toBe(true);
    expect(h.files.get(backup)).toBe(old);
    expect(h.files.get(SETTINGS)).not.toBe(old);
  });

  it("makes no backup when the file is missing or already identical", async () => {
    const first = (await cli(["setup"], {})).json();
    expect(first).not.toHaveProperty("settings_backup");
    const again = (await cli(["setup"], {})).json();
    expect(again).not.toHaveProperty("settings_backup");
    expect([...h.files.keys()].filter((name) => name.endsWith(".bak"))).toEqual([]);
  });

  it("refuses a file it cannot read, with or without a custom keypair on it, unless --keypair is passed", async () => {
    const owner = await funded();
    const trailing = '{ "url": "devnet", "keypair": "owner.json", }';
    for (const text of [trailing, JSON.stringify({ url: "devnet", keypair: 5 }), JSON.stringify({ url: "devnet", keypair: "owner.json", "confirm-url": 9 })]) {
      h.files.set(SETTINGS, text);
      const ran = await cli(["setup"], { "owner.json": owner });
      expect(ran.code).toBe(EXIT_USAGE);
      expect(ran.err).toContain(SETTINGS);
      expect(h.files.get(SETTINGS)).toBe(text);
      expect([...h.files.keys()].filter((name) => name.endsWith(".bak"))).toEqual([]);
    }
  });

  it("proceeds with --keypair, keeps the old text in a backup and names it on stderr", async () => {
    const owner = await funded();
    const trailing = '{ "url": "devnet", "keypair": "owner.json", }';
    h.files.set(SETTINGS, trailing);
    const made = (await cli(["setup", "--keypair", "owner.json"], { "owner.json": owner })).json();
    const backup = made["settings_backup"] as string;
    expect(h.files.get(backup)).toBe(trailing);
    expect(JSON.parse(h.files.get(SETTINGS) ?? "{}")).toMatchObject({ keypair: "owner.json" });
    const lines = warned.join("").split("\n").filter((line) => line.startsWith("warning:"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(backup);
  });

  it("names the backup in the error when setup fails after writing", async () => {
    const owner = await funded();
    const old = JSON.stringify({ url: "devnet", keypair: "owner.json", extra: 1 });
    h.files.set(SETTINGS, old);
    const live = runtime({ "owner.json": owner });
    const real = live.transport("devnet");
    const broken = { ...real, getAccount: async () => { throw new Error("node down"); } } as typeof real;
    const failure = (await setup(broken, live, "devnet", "owner.json").then(() => new Error("no failure"), (error: unknown) => error)) as Error;
    expect(failure.message).toContain("node down");
    const backup = [...h.files.keys()].find((name) => name.endsWith(".bak")) ?? "";
    expect(failure.message).toContain(backup);
    expect(h.files.get(backup)).toBe(old);
  });

  it("leaves the file untouched when the copy cannot be read back", async () => {
    const old = JSON.stringify({ url: "devnet", keypair: "owner.json" });
    h.files.set(SETTINGS, old);
    const owner = await funded();
    const live = runtime({ "owner.json": owner });
    const files = {
      ...live,
      saveText: async (path: string, text: string, secret: boolean) => {
        await live.saveText(path, path.endsWith(".bak") ? `${text} damaged` : text, secret);
      },
    };
    await expect(setup(live.transport("devnet"), files, "devnet", "owner.json")).rejects.toThrow("setup stopped before writing");
    expect(h.files.get(SETTINGS)).toBe(old);
  });

  it("leaves the file untouched when setup fails before writing", async () => {
    const old = JSON.stringify({ url: "devnet", keypair: "owner.json" });
    h.files.set(SETTINGS, old);
    h.files.set("bad.json", "not a key");
    const ran = await cli(["setup", "--keypair", "bad.json"], {});
    expect(ran.code).not.toBe(EXIT_OK);
    expect(h.files.get(SETTINGS)).toBe(old);
  });
});

describe("the wallet server", () => {
  async function served() {
    return connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
  }

  it("works with a url-only settings file and reports the backup on setup", async () => {
    h.files.set(SETTINGS, JSON.stringify({ url: "devnet" }));
    const client = await served();
    const made = await ok(client, "wallet_setup");
    expect(made["keypair"]).toBe(WALLET);
    expect(made).toHaveProperty("settings_backup");
    expect(JSON.parse(h.files.get(SETTINGS) ?? "{}")).toMatchObject({ keypair: WALLET });
    expect((await ok(client, "wallet_balance"))["address"]).toBe(made["address"]);
  });

  it("answers a wallet tool without a keypair with the setup refusal, not a delete instruction", async () => {
    h.files.set(SETTINGS, JSON.stringify({ url: "devnet" }));
    const client = await served();
    const refused = await call(client, "wallet_balance");
    expect(refused.error).toBe(true);
    expect(JSON.stringify(refused.value)).not.toContain("delete");
  });

  it("refuses setup on a file it cannot read, with the file named and the file untouched", async () => {
    const client = await served();
    for (const text of ['{ "url": "devnet", "keypair": "owner.json", }', JSON.stringify({ url: "devnet", keypair: 5 }), JSON.stringify({ url: "devnet", keypair: "owner.json", "confirm-url": 9 })]) {
      h.files.set(SETTINGS, text);
      const refused = await call(client, "wallet_setup");
      expect(refused.error).toBe(true);
      expect(JSON.stringify(refused.value)).toContain(SETTINGS);
      expect(h.files.get(SETTINGS)).toBe(text);
      expect([...h.files.keys()].filter((name) => name.endsWith(".bak"))).toEqual([]);
    }
  });
});
