import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PRODUCT_SLUG } from "@intent-engine/core/internal";
import { CODEX_TOOL_TIMEOUT, codexConfigPath } from "../src/add-to.js";
import { EXIT_OK, main } from "../src/main.js";
import { NPM_REGISTRY } from "../src/npm-registry.js";
import { h, HOME, instant, resetHarness, runtime, transport } from "./harness.js";

const ENTRY = `[mcp_servers.${PRODUCT_SLUG}]\ncommand = "npx"\n`;

let bin = "";

beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), "add-to-setup-bin-"));
  for (const name of ["claude", "codex"]) {
    writeFileSync(join(bin, name), "");
    chmodSync(join(bin, name), 0o755);
  }
});

afterAll(() => {
  rmSync(bin, { recursive: true, force: true });
});

beforeEach(() => {
  resetHarness();
  instant.fetch = undefined;
});

async function addTo(app: "claude" | "codex", tty: boolean, extra: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const rt = {
    ...runtime({}),
    env: { PATH: bin },
    launch: async (program: string, args: readonly string[]) => {
      if (program === "npm") {
        return { code: 0, output: `${NPM_REGISTRY}\n` };
      }
      if (program === "codex" && !h.files.has(codexConfigPath({ env: {}, home: HOME }))) {
        h.files.set(codexConfigPath({ env: {}, home: HOME }), ENTRY);
      }
      return { code: 0, output: "" };
    },
  };
  const code = await main(["add-to", app, ...extra], rt, { out: (t) => out.push(t), err: (t) => err.push(t), tty });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("add-to sets up the wallet", () => {
  it("prints exactly three lines on a terminal, for both apps, with a funded wallet", async () => {
    for (const app of ["claude", "codex"] as const) {
      resetHarness();
      const run = await addTo(app, true);
      expect(run.code).toBe(EXIT_OK);
      expect(run.err).toBe("");
      const lines = run.out.split("\n");
      expect(lines).toHaveLength(3);
      const name = app === "claude" ? "Claude Code" : "Codex";
      expect(lines[0]).toBe(`${PRODUCT_SLUG} was added to ${name}.`);
      expect(lines[1]).toBe("Your wallet holds 1 SOL.");
      expect(lines[2]).toBe(
        `Restart ${name}, then type "set me up and make my first swap"${app === "claude" ? ` or /${PRODUCT_SLUG}:start` : ""}.`,
      );
    }
  });

  it("prints exactly three lines on a terminal with an empty wallet, the middle one being what setup says", async () => {
    h.airdropRefused = true;
    for (const app of ["claude", "codex"] as const) {
      resetHarness();
      h.airdropRefused = true;
      const run = await addTo(app, true);
      expect(run.code).toBe(EXIT_OK);
      const lines = run.out.split("\n");
      expect(lines).toHaveLength(3);
      expect(lines[1]).toMatch(/^your wallet holds no SOL yet and devnet refused the airdrop; paste \S+ at https:\/\/faucet\.solana\.com/);
      expect(lines[2]).toContain("Restart");
    }
  });

  it("prints JSON with the setup result under one new key when piped", async () => {
    for (const app of ["claude", "codex"] as const) {
      resetHarness();
      const run = await addTo(app, false);
      expect(run.code).toBe(EXIT_OK);
      const json = JSON.parse(run.out) as Record<string, unknown>;
      expect(json).toMatchObject({ added: PRODUCT_SLUG, setup: { created: true, sol: "1" } });
      expect(Object.keys(json).filter((key) => key === "setup")).toEqual(["setup"]);
    }
  });

  it("sets up an already added server too", async () => {
    await addTo("codex", false);
    const again = await addTo("codex", true);
    expect(again.code).toBe(EXIT_OK);
    expect(again.out.split("\n")).toHaveLength(3);
    expect(again.out.split("\n")[0]).toBe(`${PRODUCT_SLUG} was already added to Codex.`);
  });

  it("skips setup with --no-setup", async () => {
    const run = await addTo("claude", false, ["--no-setup"]);
    expect(run.code).toBe(EXIT_OK);
    expect(JSON.parse(run.out)).not.toHaveProperty("setup");
    expect(h.airdrops).toEqual([]);
    expect([...h.files.keys()]).toEqual([]);
    const lines = (await addTo("claude", true, ["--no-setup"])).out.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^Wallet setup was skipped/);
  });

  it("keeps a wallet that already exists and only shows its balance", async () => {
    const first = JSON.parse((await addTo("claude", false)).out) as { setup: { address: string; created: boolean } };
    expect(first.setup.created).toBe(true);
    const airdrops = h.airdrops.length;
    const second = JSON.parse((await addTo("claude", false)).out) as { setup: { address: string; created: boolean; sol: string } };
    expect(second.setup).toMatchObject({ created: false, address: first.setup.address, sol: "1" });
    expect(h.airdrops).toHaveLength(airdrops);
  });

  it("still exits 0 when the faucets refuse", async () => {
    h.airdropRefused = true;
    instant.fetch = async () => ({ status: 403, json: async () => null });
    const run = await addTo("claude", false);
    expect(run.code).toBe(EXIT_OK);
    expect(JSON.parse(run.out)).toMatchObject({ added: PRODUCT_SLUG, setup: { sol: "0", faucet: { refused: expect.any(String) } } });
  });

  it("still exits 0 when the network fails during setup", async () => {
    h.through = {
      ...transport,
      getAccount: async () => {
        throw new TypeError("fetch failed");
      },
    };
    const piped = await addTo("claude", false);
    expect(piped.code).toBe(EXIT_OK);
    expect(JSON.parse(piped.out)).toMatchObject({ added: PRODUCT_SLUG, setup: { failed: "fetch failed" } });
    const terminal = await addTo("codex", true);
    expect(terminal.code).toBe(EXIT_OK);
    expect(terminal.out.split("\n")).toHaveLength(3);
    expect(terminal.out.split("\n")[1]).toBe("Wallet setup did not finish (fetch failed); run intent-engine setup again.");
  });

  it("sets the codex tool timeout above the slowest call measured", async () => {
    await addTo("codex", false);
    expect(h.files.get(codexConfigPath({ env: {}, home: HOME }))).toContain(`tool_timeout_sec = ${CODEX_TOOL_TIMEOUT}`);
    expect(CODEX_TOOL_TIMEOUT).toBeGreaterThan(60);
  });
});
