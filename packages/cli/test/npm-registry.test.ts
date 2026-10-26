import { beforeEach, describe, expect, it } from "vitest";
import { PRODUCT_SLUG } from "@intent-engine/core/internal";
import { HttpRegistryRefused } from "../src/add-to.js";
import { launch, LaunchTimedOut, type Launched } from "../src/launch.js";
import { EXIT_FAILED, EXIT_OK, main } from "../src/main.js";
import {
  ALLOW_HTTP_REGISTRY,
  httpRefused,
  NPM,
  NPM_MISSING,
  NPM_REGISTRY,
  npmFailed,
  npmRegistry,
  plainRegistry,
  REGISTRY_ARGS,
  REGISTRY_TIMEOUT_MS,
  USE_HTTPS,
} from "../src/npm-registry.js";
import { runtime, world } from "./harness.js";

const PLAIN = "http://" + "registry.npmjs.org/";
const MIRROR = "https://" + "npm.example.org/";
const HTTP_REPLY: Launched = { code: 0, output: `${PLAIN}\n` };
const HTTPS_REPLY: Launched = { code: 0, output: `${NPM_REGISTRY}\n` };
const FAILING: Launched = { code: 1, output: "npm error could not read config\n" };

type Npm = Launched | null | Error;
type Call = { program: string; args: readonly string[]; timeoutMs: number | undefined };

async function command(argv: string[], npm: Npm, reply: Launched | null = { code: 0, output: "" }) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const rt = {
    ...runtime({}),
    launch: async (program: string, args: readonly string[], timeoutMs?: number) => {
      calls.push({ program, args, timeoutMs });
      if (program !== NPM) {
        return reply;
      }
      if (npm instanceof Error) {
        throw npm;
      }
      return npm;
    },
  };
  const code = await main(argv, rt, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, calls, err: err.join("\n"), json: () => JSON.parse(out.join("\n")) as Record<string, unknown> };
}

const asking = (npm: Npm) => async (program: string, args: readonly string[], timeoutMs?: number) => {
  expect([program, args, timeoutMs]).toEqual([NPM, REGISTRY_ARGS, REGISTRY_TIMEOUT_MS]);
  if (npm instanceof Error) {
    throw npm;
  }
  return npm;
};

describe("reading npm's registry", () => {
  it("runs npm config get registry with a timeout and tells http from https", async () => {
    expect(REGISTRY_ARGS).toEqual(["config", "get", "registry"]);
    expect(await npmRegistry(asking(HTTP_REPLY))).toEqual({ read: "http", registry: PLAIN });
    expect(await npmRegistry(asking(HTTPS_REPLY))).toEqual({ read: "https", registry: NPM_REGISTRY });
    expect(await npmRegistry(asking({ code: 0, output: `npm warn config something\r\n${MIRROR}\r\n` }))).toEqual({ read: "https", registry: MIRROR });
    expect(await npmRegistry(asking({ code: 0, output: "HTTP://" + "Registry.Example/\n" }))).toEqual({ read: "http", registry: "HTTP://" + "Registry.Example/" });
  });

  it("reports a missing npm and a failing npm without guessing", async () => {
    expect(await npmRegistry(asking(null))).toEqual({ read: "missing" });
    expect(await npmRegistry(asking(FAILING))).toEqual({ read: "failed", reason: "exit 1: npm error could not read config" });
    expect(await npmRegistry(asking({ code: 2, output: " \n" }))).toEqual({ read: "failed", reason: "exit 2: it printed nothing" });
    expect(await npmRegistry(asking({ code: 0, output: "undefined\n" }))).toEqual({ read: "failed", reason: "it printed no registry url" });
    expect(await npmRegistry(asking(new LaunchTimedOut(NPM, REGISTRY_TIMEOUT_MS)))).toEqual({
      read: "failed",
      reason: "npm did not finish within 15 seconds, so it was stopped",
    });
    const long = await npmRegistry(asking({ code: 1, output: "x".repeat(500) }));
    expect(long.read === "failed" && long.reason.length).toBeLessThan(220);
  });

  it("names the exact command that switches npm to https", () => {
    expect(USE_HTTPS).toBe("npm config set registry " + "https://" + "registry.npmjs.org/");
    expect(plainRegistry(PLAIN)).toContain(`switch npm to https with: ${USE_HTTPS}`);
    expect(httpRefused(PLAIN)).toContain(ALLOW_HTTP_REGISTRY);
  });
});

describe("launching with a timeout", () => {
  it("stops a program that runs past it", async () => {
    await expect(launch(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], "linux", 200)).rejects.toThrow(LaunchTimedOut);
    expect(await launch(process.execPath, ["-e", "process.stdout.write('quick')"], "linux", 20_000)).toEqual({ code: 0, output: "quick" });
  });
});

describe("add-to and npm's registry", () => {
  it("refuses to add the server while npm's registry is plain http, and adds nothing", async () => {
    const run = await command(["add-to", "claude"], HTTP_REPLY);
    expect(run.code).toBe(EXIT_FAILED);
    expect(run.err).toBe(httpRefused(PLAIN));
    expect(run.err).toContain(USE_HTTPS);
    expect(run.calls.map((c) => c.program)).toEqual([NPM]);
    expect(run.calls[0]).toEqual({ program: NPM, args: REGISTRY_ARGS, timeoutMs: REGISTRY_TIMEOUT_MS });
    const codex = await command(["add-to", "codex"], HTTP_REPLY);
    expect([codex.code, codex.err]).toEqual([EXIT_FAILED, httpRefused(PLAIN)]);
    expect(codex.calls.map((c) => c.program)).toEqual([NPM]);
    expect(new HttpRegistryRefused("x")).toBeInstanceOf(Error);
  });

  it("adds it over http only with the explicit flag, and still warns", async () => {
    const run = await command(["add-to", "claude", ALLOW_HTTP_REGISTRY], HTTP_REPLY);
    expect(run.code).toBe(EXIT_OK);
    expect(run.calls.map((c) => c.program)).toEqual([NPM, "claude"]);
    expect(run.json()).toMatchObject({ added: PRODUCT_SLUG, warnings: [plainRegistry(PLAIN)] });
  });

  it("adds it without a warning over https", async () => {
    const run = await command(["add-to", "claude"], HTTPS_REPLY);
    expect(run.code).toBe(EXIT_OK);
    expect(run.json()).toMatchObject({ added: PRODUCT_SLUG });
    expect(run.json()["warnings"]).toBeUndefined();
  });

  it("adds it and says the registry was not checked when npm is missing or fails", async () => {
    const missing = await command(["add-to", "claude"], null);
    expect(missing.code).toBe(EXIT_OK);
    expect(missing.json()).toMatchObject({ added: PRODUCT_SLUG, warnings: [NPM_MISSING] });
    const failing = await command(["add-to", "claude"], FAILING);
    expect(failing.code).toBe(EXIT_OK);
    expect(failing.json()).toMatchObject({ added: PRODUCT_SLUG, warnings: [npmFailed("exit 1: npm error could not read config")] });
    const stuck = await command(["add-to", "claude"], new LaunchTimedOut(NPM, REGISTRY_TIMEOUT_MS));
    expect(stuck.code).toBe(EXIT_OK);
    expect(stuck.json()["warnings"]).toEqual([npmFailed("npm did not finish within 15 seconds, so it was stopped")]);
  });
});

describe("setup and npm's registry", () => {
  beforeEach(async () => {
    await world();
  });

  it("warns with the command that switches npm to https when the registry is plain http", async () => {
    const run = await command(["setup"], HTTP_REPLY);
    expect(run.code).toBe(EXIT_OK);
    expect(run.json()["warnings"]).toEqual([plainRegistry(PLAIN)]);
    expect(run.calls).toEqual([{ program: NPM, args: REGISTRY_ARGS, timeoutMs: REGISTRY_TIMEOUT_MS }]);
  });

  it("says nothing about the registry over https, without npm or when npm fails", async () => {
    for (const npm of [HTTPS_REPLY, null, FAILING, new LaunchTimedOut(NPM, REGISTRY_TIMEOUT_MS)]) {
      const run = await command(["setup"], npm);
      expect(run.code).toBe(EXIT_OK);
      expect(run.json()["warnings"]).toBeUndefined();
      expect(run.json()["address"]).toEqual(expect.any(String));
    }
  });
});
