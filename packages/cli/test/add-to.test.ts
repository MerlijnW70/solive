import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRODUCT_SLUG } from "@intent-engine/core/internal";
import { ADD_TO_NEEDS_APP, CLUSTERS, parse, usageOf } from "../src/args.js";
import { CLAUDE_MISSING, CLAUDE_SCOPE, CLI_PACKAGE, alreadyAdded, claudeFailed, npxFor } from "../src/add-to.js";
import { invocation, launch, notFound, onPath, WINDOWS_NOT_FOUND, type Launched } from "../src/launch.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, main, nodeRuntime } from "../src/main.js";
import { NPM_REGISTRY } from "../src/npm-registry.js";
import { runtime } from "./harness.js";

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { name: string };
const SERVER = ["npx", "-y", manifest.name, "mcp", "--url", "devnet", "--wallet"];
const WIN_SERVER = ["npx.cmd", ...SERVER.slice(1)];

let bin = "";
let emptyBin = "";

beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), "add-to-bin-"));
  emptyBin = mkdtempSync(join(tmpdir(), "add-to-empty-"));
  for (const name of ["claude", "claude.cmd", "codex", "codex.cmd"]) {
    writeFileSync(join(bin, name), "");
    chmodSync(join(bin, name), 0o755);
  }
});

afterAll(() => {
  rmSync(bin, { recursive: true, force: true });
  rmSync(emptyBin, { recursive: true, force: true });
});

const pathEnv = (dir: string) => ({ PATH: dir, PATHEXT: ".cmd" });

async function addTo(argv: string[], platform: string, reply: Launched | null, dir: string = bin) {
  const launched: { program: string; args: readonly string[] }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const rt = {
    ...runtime({}),
    env: pathEnv(dir),
    platform,
    launch: async (program: string, args: readonly string[]) => {
      if (program === "npm") {
        return { code: 0, output: `${NPM_REGISTRY}\n` };
      }
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
    expect(run.launched).toEqual([{ program: "claude", args: ["mcp", "add", "--scope", "user", PRODUCT_SLUG, "--", "cmd", "/c", ...WIN_SERVER] }]);
    expect(JSON.parse(run.out)).toEqual({
      added: PRODUCT_SLUG,
      to: "Claude Code",
      ran: `claude mcp add --scope user ${PRODUCT_SLUG} -- cmd /c ${WIN_SERVER.join(" ")}`,
      server: `cmd /c ${WIN_SERVER.join(" ")}`,
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
      const run = await addTo(["add-to", "claude"], platform, { code: 1, output: "'claude' is not recognized as an internal or external command" }, emptyBin);
      expect(run.code).toBe(EXIT_FAILED);
      expect(run.err).toBe(CLAUDE_MISSING);
      expect(run.err).toBe(`claude is not installed or not on PATH; install Claude Code with npm install -g @anthropic-ai/claude-code, then run this again`);
      expect(run.out).toBe("");
      expect(run.launched).toEqual([]);
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

  it("succeeds and says it is already set up when the server is registered, with the replace commands", async () => {
    const exists = { code: 1, output: `MCP server ${PRODUCT_SLUG} already exists in user config
` };
    const run = await addTo(["add-to", "claude"], "linux", exists);
    expect(run.code).toBe(EXIT_OK);
    expect(run.err).toBe("");
    expect(JSON.parse(run.out)).toMatchObject({ already: PRODUCT_SLUG, to: "Claude Code", note: alreadyAdded("claude", [], "linux") });
    expect(alreadyAdded("claude", [], "linux")).toBe(
      `${PRODUCT_SLUG} is already set up in Claude Code, so nothing was changed; to replace it, run claude mcp remove --scope user ${PRODUCT_SLUG}, then npx -y ${manifest.name} add-to claude`,
    );
    const limited = await addTo(["add-to", "claude", "--wallet-per-trade", "SOL=0.1"], "win32", exists);
    expect(limited.code).toBe(EXIT_OK);
    expect(JSON.parse(limited.out).note).toBe(
      `${PRODUCT_SLUG} is already set up in Claude Code, so nothing was changed; to replace it, run claude mcp remove --scope user ${PRODUCT_SLUG}, then npx.cmd -y ${manifest.name} add-to claude --wallet-per-trade SOL=0.1`,
    );
    expect(parse(["add-to", "claude", "--wallet-per-trade", "SOL=0.1"], {})).toEqual({ name: "add-to", app: "claude", limits: ["--wallet-per-trade", "SOL=0.1"], allowHttpRegistry: false });
  });

  it("prints npx.cmd and never a .ps1 shim for Windows, and npx elsewhere", () => {
    expect(npxFor("win32")).toBe("npx.cmd");
    expect(npxFor("linux")).toBe("npx");
    for (const app of ["claude", "codex"] as const) {
      expect(alreadyAdded(app, [], "win32")).toContain("npx.cmd -y");
      expect(alreadyAdded(app, [], "win32")).not.toMatch(/\.ps1|npx -y/);
    }
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
      usage: "add-to claude|codex [--wallet-per-trade <token=amount,...>] [--wallet-per-hour <token=amount,...>] [--allow-http-registry]",
      options: ["--wallet-per-trade", "--wallet-per-hour", "--allow-http-registry", "--output", "--help", "--debug"],
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

describe("finding a program on PATH", () => {
  it("finds an executable on the path and not a missing one", () => {
    expect(onPath("claude", { PATH: bin }, "linux")).toBe(true);
    expect(onPath("claude", { PATH: emptyBin }, "linux")).toBe(false);
    expect(onPath("claude", {}, "linux")).toBe(false);
  });

  it("tries each PATHEXT extension on Windows, whatever the case of the variable names", () => {
    expect(onPath("claude", { Path: bin, PathExt: ".exe;.cmd" }, "win32")).toBe(true);
    expect(onPath("claude", { PATH: bin, PATHEXT: ".exe" }, "win32")).toBe(false);
    expect(onPath("claude", { PATH: emptyBin, PATHEXT: ".cmd" }, "win32")).toBe(false);
  });

  it("skips a file that is not executable on Linux", () => {
    const plain = mkdtempSync(join(tmpdir(), "add-to-plain-"));
    writeFileSync(join(plain, "claude"), "");
    chmodSync(join(plain, "claude"), 0o644);
    expect(onPath("claude", { PATH: plain }, "linux")).toBe(false);
    rmSync(plain, { recursive: true, force: true });
  });
});
