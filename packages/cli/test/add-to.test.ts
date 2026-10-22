import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PRODUCT_SLUG } from "@intent-engine/core";
import { ADD_TO_NEEDS_APP, CLUSTERS, parse, usageOf } from "../src/args.js";
import { CLAUDE_MISSING, CLAUDE_SCOPE, CLI_PACKAGE, claudeExists, claudeFailed } from "../src/add-to.js";
import { invocation, launch, notFound, WINDOWS_NOT_FOUND, type Launched } from "../src/launch.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, main, nodeRuntime } from "../src/main.js";
import { runtime } from "./harness.js";

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { name: string };
const SERVER = ["npx", "-y", manifest.name, "mcp", "--url", "devnet", "--wallet"];

async function addTo(argv: string[], platform: string, reply: Launched | null) {
  const launched: { program: string; args: readonly string[] }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const rt = {
    ...runtime({}),
    platform,
    launch: async (program: string, args: readonly string[]) => {
      launched.push({ program, args });
      return reply;
    },
  };
  const code = await main(argv, rt, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, launched, out: out.join("\n"), err: err.join("\n") };
}

describe("add-to claude", () => {
  it("names the published package", () => {
    expect(CLI_PACKAGE).toBe(manifest.name);
  });

  it("adds the server through cmd /c on native Windows and says what it added", async () => {
    const run = await addTo(["add-to", "claude"], "win32", { code: 0, output: "Added stdio MCP server" });
    expect(run.code).toBe(EXIT_OK);
    expect(run.launched).toEqual([{ program: "claude", args: ["mcp", "add", "--scope", "user", PRODUCT_SLUG, "--", "cmd", "/c", ...SERVER] }]);
    expect(JSON.parse(run.out)).toEqual({
      added: PRODUCT_SLUG,
      to: "Claude Code",
      ran: `claude mcp add --scope user ${PRODUCT_SLUG} -- cmd /c ${SERVER.join(" ")}`,
      server: `cmd /c ${SERVER.join(" ")}`,
      next: "restart Claude Code, then ask it to set you up and make your first swap",
    });
    expect(run.err).toBe("");
  });

  it("adds the server through npx directly elsewhere", async () => {
    for (const platform of ["linux", "darwin"]) {
      const run = await addTo(["add-to", "claude"], platform, { code: 0, output: "" });
      expect(run.code).toBe(EXIT_OK);
      expect(run.launched).toEqual([{ program: "claude", args: ["mcp", "add", "--scope", "user", PRODUCT_SLUG, "--", ...SERVER] }]);
      expect(JSON.parse(run.out)).toMatchObject({ added: PRODUCT_SLUG, server: SERVER.join(" ") });
    }
  });

  it("adds a server the mcp command accepts", () => {
    expect(parse(SERVER.slice(3), {})).toMatchObject({ name: "mcp", url: CLUSTERS["devnet"], wallet: { perTrade: new Map(), perHour: new Map() } });
  });

  it("refuses plainly when claude is not installed", async () => {
    for (const platform of ["win32", "linux"]) {
      const run = await addTo(["add-to", "claude"], platform, null);
      expect(run.code).toBe(EXIT_FAILED);
      expect(run.err).toBe(CLAUDE_MISSING);
      expect(run.out).toBe("");
    }
  });

  it("reports a failing claude mcp add with what claude printed", async () => {
    const run = await addTo(["add-to", "claude"], "linux", { code: 1, output: "error: unknown option '--scope'\n" });
    expect(run.code).toBe(EXIT_FAILED);
    expect(run.err).toBe("claude mcp add failed with exit code 1, so nothing was added: error: unknown option '--scope'");
    expect(run.out).toBe("");
    const silent = await addTo(["add-to", "claude"], "win32", { code: 5, output: " \n" });
    expect(silent.err).toBe(claudeFailed(5, ""));
    expect(silent.err).toBe("claude mcp add failed with exit code 5, so nothing was added: it printed nothing");
  });

  it("says the server is already added and gives the exact commands that replace it", async () => {
    const run = await addTo(["add-to", "claude"], "linux", { code: 1, output: `MCP server ${PRODUCT_SLUG} already exists in user config\n` });
    expect(run.code).toBe(EXIT_FAILED);
    expect(run.err).toBe(claudeExists([]));
    expect(run.err).toBe(
      `${PRODUCT_SLUG} is already added to Claude Code for your user, so nothing was changed; to replace it, run claude mcp remove --scope user ${PRODUCT_SLUG}, then npx -y ${manifest.name} add-to claude`,
    );
    expect(run.out).toBe("");
    const limited = await addTo(["add-to", "claude", "--wallet-per-trade", "SOL=0.1"], "win32", { code: 1, output: `MCP server ${PRODUCT_SLUG} already exists in user config` });
    expect(limited.err).toBe(
      `${PRODUCT_SLUG} is already added to Claude Code for your user, so nothing was changed; to replace it, run claude mcp remove --scope user ${PRODUCT_SLUG}, then npx -y ${manifest.name} add-to claude --wallet-per-trade SOL=0.1`,
    );
    expect(parse(["add-to", "claude", "--wallet-per-trade", "SOL=0.1"], {})).toEqual({ name: "add-to", app: "claude", limits: ["--wallet-per-trade", "SOL=0.1"] });
  });

  it("registers the server for the user, the scope claude mcp add and remove both take", async () => {
    const run = await addTo(["add-to", "claude"], "linux", { code: 0, output: "" });
    expect(run.launched[0]?.args.slice(0, 4)).toEqual(["mcp", "add", ...CLAUDE_SCOPE]);
    expect(CLAUDE_SCOPE).toEqual(["--scope", "user"]);
    expect(JSON.parse(run.out)).toMatchObject({ ran: `claude mcp add --scope user ${PRODUCT_SLUG} -- ${SERVER.join(" ")}` });
  });

  it("passes wallet limits on to the server once they parse", async () => {
    const run = await addTo(["add-to", "claude", "--wallet-per-trade", "SOL= 0.1", "--wallet-per-hour", "SOL=0.5"], "linux", { code: 0, output: "" });
    expect(run.code).toBe(EXIT_OK);
    const limits = ["--wallet-per-trade", "SOL=0.1", "--wallet-per-hour", "SOL=0.5"];
    expect(run.launched[0]?.args).toEqual(["mcp", "add", "--scope", "user", PRODUCT_SLUG, "--", ...SERVER, ...limits]);
    expect(parse([...SERVER.slice(3), ...limits], {})).toMatchObject({ name: "mcp" });
    const bad = await addTo(["add-to", "claude", "--wallet-per-trade", "SOL"], "linux", { code: 0, output: "" });
    expect(bad.code).toBe(EXIT_USAGE);
    expect(bad.launched).toEqual([]);
  });

  it("needs claude or codex and takes nothing else", async () => {
    for (const argv of [["add-to"], ["add-to", "cursor"]]) {
      const run = await addTo(argv, "linux", { code: 0, output: "" });
      expect(run.code).toBe(EXIT_USAGE);
      expect(run.err).toBe(ADD_TO_NEEDS_APP);
      expect(run.launched).toEqual([]);
    }
    for (const [argv, message] of [
      [["add-to", "claude", "--url", "devnet"], "add-to does not take --url"],
      [["add-to", "claude", "extra"], "unexpected argument extra"],
    ] as const) {
      const run = await addTo([...argv], "linux", { code: 0, output: "" });
      expect(run.code).toBe(EXIT_USAGE);
      expect(run.err).toBe(message);
      expect(run.launched).toEqual([]);
    }
  });

  it("describes itself in help", () => {
    expect(usageOf("add-to")).toEqual({
      usage: "add-to claude|codex [--wallet-per-trade <token=amount,...>] [--wallet-per-hour <token=amount,...>]",
      options: ["--wallet-per-trade", "--wallet-per-hour", "--output", "--help"],
    });
  });
});

describe("launching a program", () => {
  it("starts it through cmd on Windows so command scripts run, and directly elsewhere", () => {
    expect(invocation("claude", ["mcp", "add"], "win32")).toEqual(["cmd.exe", ["/d", "/c", "claude", "mcp", "add"]]);
    expect(invocation("claude", ["mcp", "add"], "linux")).toEqual(["claude", ["mcp", "add"]]);
  });

  it("counts only the Windows not-found exit as a missing program", () => {
    expect(notFound(WINDOWS_NOT_FOUND, "win32")).toBe(true);
    expect(notFound(WINDOWS_NOT_FOUND, "linux")).toBe(false);
    expect(notFound(1, "win32")).toBe(false);
  });

  it("returns the exit code and everything the program printed", async () => {
    const script = "process.stdout.write('out ');process.stderr.write('err');process.exit(3)";
    expect(await launch(process.execPath, ["-e", script], "linux")).toEqual({ code: 3, output: "out err" });
    expect(await launch(process.execPath, ["-e", "0"])).toEqual({ code: 0, output: "" });
  });

  it("returns null when the program does not exist", async () => {
    expect(await launch("intent-engine-no-such-program", [], "linux")).toBeNull();
  });

  it("is what the node runtime launches with, on this machine's platform", async () => {
    const rt = nodeRuntime();
    expect(rt.platform).toBe(process.platform);
    expect(await rt.launch(process.execPath, ["-e", "process.exit(4)"])).toEqual({ code: 4, output: "" });
  });
});
