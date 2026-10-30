import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PRODUCT_SLUG } from "@intent-engine/core/internal";
import { ADD_TO_NEEDS_APP, parse, usageOf } from "../src/args.js";
import {
  CODEX_HOME_ENV,
  CODEX_MISSING,
  CODEX_STARTUP_TIMEOUT,
  CODEX_TOOL_TIMEOUT,
  alreadyAdded,
  codexConfigPath,
  codexFailed,
  codexNoEntry,
  withStartupTimeout,
} from "../src/add-to.js";
import type { Launched } from "../src/launch.js";
import { EXIT_FAILED, EXIT_OK, main, nodeRuntime } from "../src/main.js";
import { resetHarness, runtime as harnessRuntime } from "./harness.js";

const SERVER = ["npx", "-y", "@intent-engine/cli", "mcp", "--url", "devnet", "--wallet"];
const WIN_SERVER = ["npx.cmd", ...SERVER.slice(1)];
const ENTRY = `[mcp_servers.${PRODUCT_SLUG}]\ncommand = "npx"\nargs = ["-y", "@intent-engine/cli", "mcp", "--url", "devnet", "--wallet"]\n`;
const OTHERS = `model = "gpt-5"\n\n[mcp_servers.docs]\ncommand = "docs-server"\nstartup_timeout_sec = 20\n`;

let home = "";
let bin = "";

beforeEach(() => {
  resetHarness();
  home = mkdtempSync(join(tmpdir(), "add-to-codex-")).replaceAll("\\", "/");
  bin = `${home}-bin`;
  mkdirSync(bin);
  for (const name of ["codex", "codex.cmd"]) {
    writeFileSync(join(bin, name), "");
    chmodSync(join(bin, name), 0o755);
  }
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

const configFile = () => `${home}/.codex/config.toml`;

const writeConfig = (text: string) => {
  mkdirSync(`${home}/.codex`, { recursive: true });
  writeFileSync(configFile(), text);
};

async function addTo(argv: string[], platform: string, reply: Launched | null, codexWrites?: string, env: Record<string, string> = {}) {
  const launched: { program: string; args: readonly string[] }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const rt = {
    ...nodeRuntime(),
    transport: harnessRuntime({}).transport,
    faucetFetch: async () => {
      throw new TypeError("fetch failed");
    },
    home,
    env: { PATH: bin, PATHEXT: ".cmd", ...env },
    platform,
    launch: async (program: string, args: readonly string[]) => {
      if (program === "npm") {
        return { code: 0, output: "https://registry.npmjs.org/\n" };
      }
      launched.push({ program, args });
      if (codexWrites !== undefined) {
        writeConfig(codexWrites);
      }
      return reply;
    },
  };
  const code = await main(argv, rt, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, launched, out: out.join("\n"), err: err.join("\n") };
}

describe("add-to codex", () => {
  it("adds the server through cmd /c on native Windows, sets its startup timeout and says what changed", async () => {
    const run = await addTo(["add-to", "codex"], "win32", { code: 0, output: "Added global MCP server" }, `${OTHERS}\n${ENTRY.replace('command = "npx"', 'command = "cmd"')}`);
    expect(run.code).toBe(EXIT_OK);
    expect(run.launched).toEqual([{ program: "codex", args: ["mcp", "add", PRODUCT_SLUG, "--", "cmd", "/c", ...WIN_SERVER] }]);
    expect(JSON.parse(run.out)).toEqual({
      added: PRODUCT_SLUG,
      to: "Codex",
      ran: `codex mcp add ${PRODUCT_SLUG} -- cmd /c ${WIN_SERVER.join(" ")}`,
      server: `cmd /c ${WIN_SERVER.join(" ")}`,
      config: configFile(),
      startup_timeout_sec: CODEX_STARTUP_TIMEOUT,
      tool_timeout_sec: CODEX_TOOL_TIMEOUT,
      was: null,
      next: "restart Codex, then ask it to set you up and make your first swap",
      setup: expect.objectContaining({ created: true, sol: "1" }),
    });
    expect(run.err).toBe("");
    expect(readFileSync(configFile(), "utf8")).toBe(
      `${OTHERS}\n${ENTRY.replace('command = "npx"', 'command = "cmd"')}startup_timeout_sec = ${CODEX_STARTUP_TIMEOUT}\ntool_timeout_sec = ${CODEX_TOOL_TIMEOUT}\n`,
    );
  });

  it("adds the server through npx directly elsewhere", async () => {
    for (const platform of ["linux", "darwin"]) {
      rmSync(`${home}/.codex`, { recursive: true, force: true });
      const run = await addTo(["add-to", "codex"], platform, { code: 0, output: "" }, ENTRY);
      expect(run.code).toBe(EXIT_OK);
      expect(run.launched).toEqual([{ program: "codex", args: ["mcp", "add", PRODUCT_SLUG, "--", ...SERVER] }]);
      expect(JSON.parse(run.out)).toMatchObject({ added: PRODUCT_SLUG, to: "Codex", server: SERVER.join(" "), was: null });
      expect(readFileSync(configFile(), "utf8")).toBe(`${ENTRY}startup_timeout_sec = ${CODEX_STARTUP_TIMEOUT}\ntool_timeout_sec = ${CODEX_TOOL_TIMEOUT}\n`);
    }
  });

  it("replaces a timeout the solive entry already has and leaves every other line as it was", async () => {
    const before = `${OTHERS}\n${ENTRY}startup_timeout_sec = 10 # too short\n\n[mcp_servers.${PRODUCT_SLUG}.env]\nA = "1"\n\n[mcp_servers.after]\ncommand = "x"\n`;
    const run = await addTo(["add-to", "codex"], "linux", { code: 0, output: "" }, before);
    expect(run.code).toBe(EXIT_OK);
    expect(JSON.parse(run.out)).toMatchObject({ startup_timeout_sec: CODEX_STARTUP_TIMEOUT, was: "10" });
    expect(readFileSync(configFile(), "utf8")).toBe(
      before.replace("startup_timeout_sec = 10 # too short", `startup_timeout_sec = ${CODEX_STARTUP_TIMEOUT}\ntool_timeout_sec = ${CODEX_TOOL_TIMEOUT}`),
    );
  });

  it("adds the timeout inside the entry, before a following table, keeping blank lines and other entries", async () => {
    const before = `${ENTRY}\n\n[mcp_servers.${PRODUCT_SLUG}.env]\nB = "2"\n${OTHERS}`;
    const run = await addTo(["add-to", "codex"], "linux", { code: 0, output: "" }, before);
    expect(run.code).toBe(EXIT_OK);
    expect(readFileSync(configFile(), "utf8")).toBe(before.replace(`${ENTRY}\n\n`, `${ENTRY}startup_timeout_sec = ${CODEX_STARTUP_TIMEOUT}\ntool_timeout_sec = ${CODEX_TOOL_TIMEOUT}\n\n\n`));
    expect(readFileSync(configFile(), "utf8")).toContain("[mcp_servers.docs]\ncommand = \"docs-server\"\nstartup_timeout_sec = 20\n");
  });

  it("adds only the tool timeout to a config that already has the startup timeout", async () => {
    const before = `${ENTRY}startup_timeout_sec = ${CODEX_STARTUP_TIMEOUT}\n`;
    const run = await addTo(["add-to", "codex"], "linux", { code: 0, output: "" }, before);
    expect(run.code).toBe(EXIT_OK);
    expect(JSON.parse(run.out)).toMatchObject({ was: String(CODEX_STARTUP_TIMEOUT) });
    expect(readFileSync(configFile(), "utf8")).toBe(`${before}tool_timeout_sec = ${CODEX_TOOL_TIMEOUT}\n`);
  });

  it("keeps both timeouts on a second run", async () => {
    const first = await addTo(["add-to", "codex"], "linux", { code: 0, output: "" }, ENTRY);
    expect(first.code).toBe(EXIT_OK);
    const after = readFileSync(configFile(), "utf8");
    expect(after).toContain(`startup_timeout_sec = ${CODEX_STARTUP_TIMEOUT}\n`);
    expect(after).toContain(`tool_timeout_sec = ${CODEX_TOOL_TIMEOUT}\n`);
    const second = await addTo(["add-to", "codex"], "linux", { code: 0, output: "" });
    expect(second.code).toBe(EXIT_OK);
    expect(second.launched).toEqual([]);
    expect(JSON.parse(second.out)).toMatchObject({ already: PRODUCT_SLUG, setup: { created: false, sol: "1" } });
    expect(readFileSync(configFile(), "utf8")).toBe(after);
  });

  it("refuses plainly when codex is not installed, and touches no config", async () => {
    for (const platform of ["win32", "linux"]) {
      writeConfig(OTHERS);
      const run = await addTo(["add-to", "codex"], platform, { code: 1, output: "'codex' is not recognized as an internal or external command" }, undefined, { PATH: `${home}/nowhere` });
      expect(run.code).toBe(EXIT_FAILED);
      expect(run.err).toBe(CODEX_MISSING);
      expect(run.err).toBe("codex is not installed or not on PATH; install Codex with npm install -g @openai/codex, then run this again");
      expect(run.out).toBe("");
      expect(run.launched).toEqual([]);
      expect(readFileSync(configFile(), "utf8")).toBe(OTHERS);
    }
  });

  it("succeeds and says it is already set up on a second run, without calling codex or touching the config", async () => {
    for (const platform of ["linux", "win32"]) {
      const before = `${OTHERS}
${ENTRY}startup_timeout_sec = 10
`;
      writeConfig(before);
      const run = await addTo(["add-to", "codex"], platform, { code: 0, output: "" });
      expect(run.code).toBe(EXIT_OK);
      expect(run.err).toBe("");
      expect(run.launched).toEqual([]);
      expect(JSON.parse(run.out)).toMatchObject({ already: PRODUCT_SLUG, to: "Codex", note: alreadyAdded("codex", [], platform) });
      expect(readFileSync(configFile(), "utf8")).toBe(before);
    }
    expect(alreadyAdded("codex", [], "win32")).toBe(
      `${PRODUCT_SLUG} is already set up in Codex, so nothing was changed; to replace it, run codex mcp remove ${PRODUCT_SLUG}, then npx.cmd -y @intent-engine/cli add-to codex`,
    );
  });

  it("reports a failing codex mcp add with what codex printed, and touches no config", async () => {
    writeConfig(OTHERS);
    const run = await addTo(["add-to", "codex"], "linux", { code: 2, output: "error: unexpected argument\n" });
    expect(run.code).toBe(EXIT_FAILED);
    expect(run.err).toBe("codex mcp add failed with exit code 2, so nothing was added: error: unexpected argument");
    expect(run.out).toBe("");
    expect(readFileSync(configFile(), "utf8")).toBe(OTHERS);
    const silent = await addTo(["add-to", "codex"], "win32", { code: 1, output: "" });
    expect(silent.err).toBe(codexFailed(1, ""));
    expect(silent.err).toBe("codex mcp add failed with exit code 1, so nothing was added: it printed nothing");
  });

  it("says how to finish by hand when the config has no solive entry after the add", async () => {
    writeConfig(OTHERS);
    const run = await addTo(["add-to", "codex"], "linux", { code: 0, output: "" });
    expect(run.code).toBe(EXIT_FAILED);
    expect(run.err).toBe(codexNoEntry(configFile()));
    expect(run.err).toBe(
      `codex mcp add ran, but ${configFile()} has no [mcp_servers.${PRODUCT_SLUG}] table, so startup_timeout_sec was not set: add startup_timeout_sec = ${CODEX_STARTUP_TIMEOUT} under that table`,
    );
    expect(readFileSync(configFile(), "utf8")).toBe(OTHERS);
    rmSync(`${home}/.codex`, { recursive: true });
    const absent = await addTo(["add-to", "codex"], "linux", { code: 0, output: "" });
    expect(absent.err).toBe(codexNoEntry(configFile()));
    expect(existsSync(configFile())).toBe(false);
  });

  it("uses the config under CODEX_HOME when it is set", async () => {
    const elsewhere = `${home}/elsewhere`;
    mkdirSync(elsewhere);
    const env = { [CODEX_HOME_ENV]: `${elsewhere}/` };
    const unset = await addTo(["add-to", "codex"], "linux", { code: 0, output: "" }, ENTRY, env);
    expect(unset.err).toBe(codexNoEntry(`${elsewhere}/config.toml`));
    writeFileSync(`${elsewhere}/config.toml`, ENTRY);
    const run = await addTo(["add-to", "codex"], "linux", { code: 0, output: "" }, undefined, env);
    expect(run.code).toBe(EXIT_OK);
    expect(run.launched).toEqual([]);
    expect(JSON.parse(run.out)).toMatchObject({ already: PRODUCT_SLUG });
    expect(readFileSync(`${elsewhere}/config.toml`, "utf8")).toBe(ENTRY);
    expect(codexConfigPath({ home: "/h", env: {} })).toBe("/h/.codex/config.toml");
    expect(codexConfigPath({ home: "/h", env: { [CODEX_HOME_ENV]: "C:\\Users\\me\\.codex\\" } })).toBe("C:/Users/me/.codex/config.toml");
  });

  it("passes wallet limits on to the server", async () => {
    const run = await addTo(["add-to", "codex", "--wallet-per-trade", "SOL=0.1"], "linux", { code: 0, output: "" }, ENTRY);
    expect(run.code).toBe(EXIT_OK);
    expect(run.launched[0]?.args).toEqual(["mcp", "add", PRODUCT_SLUG, "--", ...SERVER, "--wallet-per-trade", "SOL=0.1"]);
  });

  it("is named in help and in the refusal for an unknown app", () => {
    expect(parse(["add-to", "codex"], {})).toEqual({ name: "add-to", app: "codex", limits: [], allowHttpRegistry: false, setup: true });
    expect(parse(["add-to", "codex", "--no-setup"], {})).toEqual({ name: "add-to", app: "codex", limits: [], allowHttpRegistry: false, setup: false });
    expect(usageOf("add-to").usage.startsWith("add-to claude|codex ")).toBe(true);
    expect(ADD_TO_NEEDS_APP).toBe("add-to needs the app to add the server to: add-to claude or add-to codex");
  });
});

describe("setting the codex startup timeout", () => {
  const set = `startup_timeout_sec = ${CODEX_STARTUP_TIMEOUT}`;

  it("finds the entry however its name is written, and ignores look-alikes", () => {
    for (const header of [`[mcp_servers.${PRODUCT_SLUG}]`, `[mcp_servers."${PRODUCT_SLUG}"]`, ` [ mcp_servers . '${PRODUCT_SLUG}' ] # mine`]) {
      expect(withStartupTimeout(`${header}\ncommand = "npx"`)).toEqual({ text: `${header}\ncommand = "npx"\n${set}`, was: null });
    }
    expect(withStartupTimeout(`[mcp_servers.${PRODUCT_SLUG}x]\ncommand = "npx"\n`)).toBeNull();
    expect(withStartupTimeout(`[mcp_servers.${PRODUCT_SLUG}.env]\nA = "1"\n`)).toBeNull();
    expect(withStartupTimeout("")).toBeNull();
  });

  it("keeps Windows line endings", () => {
    const text = `a = 1\r\n[mcp_servers.${PRODUCT_SLUG}]\r\ncommand = "cmd"\r\n\r\n[other]\r\nstartup_timeout_sec = 5\r\n`;
    expect(withStartupTimeout(text)).toEqual({ text: `a = 1\r\n[mcp_servers.${PRODUCT_SLUG}]\r\ncommand = "cmd"\r\n${set}\r\n\r\n[other]\r\nstartup_timeout_sec = 5\r\n`, was: null });
    expect(withStartupTimeout(`[mcp_servers.${PRODUCT_SLUG}]\r\nstartup_timeout_sec=30\r\n`)).toEqual({ text: `[mcp_servers.${PRODUCT_SLUG}]\r\n${set}\r\n`, was: "30" });
  });

  it("puts the timeout right under a header with an empty table", () => {
    expect(withStartupTimeout(`[mcp_servers.${PRODUCT_SLUG}]\n\n[next]\n`)).toEqual({ text: `[mcp_servers.${PRODUCT_SLUG}]\n${set}\n\n[next]\n`, was: null });
  });

  it("reads and changes only the lines of its own table", () => {
    const header = `[mcp_servers.${PRODUCT_SLUG}]`;
    expect(withStartupTimeout(`${header}\n[other]\nstartup_timeout_sec = 5\n`)).toEqual({ text: `${header}\n${set}\n[other]\nstartup_timeout_sec = 5\n`, was: null });
    expect(withStartupTimeout(`[other]\nstartup_timeout_sec = 5\n${header}\ncommand = "npx"\n`)).toEqual({
      text: `[other]\nstartup_timeout_sec = 5\n${header}\ncommand = "npx"\n${set}\n`,
      was: null,
    });
    expect(withStartupTimeout(`${header}\ncommand = "npx"\n\n[next]\nk = 1\n`)).toEqual({ text: `${header}\ncommand = "npx"\n${set}\n\n[next]\nk = 1\n`, was: null });
    expect(withStartupTimeout(`a = 1\n\n${header}\n\n\n`)).toEqual({ text: `a = 1\n\n${header}\n${set}\n\n\n`, was: null });
  });
});
