import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { mountBase } from "../src/artifact.js";
import { EXIT_RETRY } from "../src/judge-errors.js";
import { EXIT_FAILED, EXIT_OK } from "../src/main.js";
import { judgeNode } from "../src/node-judge.js";
import { SANDBOX_CPUS, SANDBOX_IMAGE, SANDBOX_MEMORY, SANDBOX_TMP } from "../src/sandbox.js";
import { type Cases } from "../src/viper.js";
import { DOCKER } from "./docker-switch.js";
import { cli } from "./harness.js";
import { boxed, job, STARTUP_SECONDS } from "./judge-kit.js";
import { planted } from "./slot-plant.js";

const SKIP = !DOCKER
  ? "docker is not available, so no sandbox run can be counted"
  : process.platform !== "linux"
    ? "the host's mounts are read from /proc/self/mountinfo, which only Linux has"
    : undefined;
const GUARD = `judge-mount-guard-${process.getuid?.() ?? 0}`;
const BOX = { image: SANDBOX_IMAGE, memory: SANDBOX_MEMORY, cpus: SANDBOX_CPUS, tmp: SANDBOX_TMP, gpu: false };
const INTERRUPTED = 130;
const POLL_MS = 200;

const SERIAL = `\0${GUARD}`;
const SERIAL_WAIT_MS = 600_000;

const sources = async (): Promise<string[]> =>
  (await readFile("/proc/self/mountinfo", "utf8"))
    .split("\n")
    .map((line) => (line.split(" ")[3] ?? "").replace(/\/\/deleted$/, ""))
    .filter((root) => root.includes(`/${GUARD}/`));

function added(before: readonly string[], after: readonly string[]): string[] {
  const left = [...before];
  return after.filter((source) => {
    const at = left.indexOf(source);
    if (at < 0) {
      return true;
    }
    left.splice(at, 1);
    return false;
  });
}

const casesOf = (list: Cases["cases"]): Cases => ({ steps: 1_000_000, heap: 1 << 24, seed: 1, clock: 0, cases: list });
const bytes = (source: string) => new TextEncoder().encode(source);

async function serialized(): Promise<Server> {
  const deadline = Date.now() + SERIAL_WAIT_MS;
  for (;;) {
    const server = await new Promise<Server | undefined>((done) => {
      const listening = createServer();
      listening.once("error", () => done(undefined));
      listening.listen({ path: SERIAL }, () => done(listening));
    });
    if (server !== undefined) {
      return server;
    }
    if (Date.now() > deadline) {
      throw new Error(`another run of this test kept ${GUARD} for ${SERIAL_WAIT_MS} ms`);
    }
    await new Promise((wake) => setTimeout(wake, POLL_MS * 5));
  }
}

function ownContainer(): string | undefined {
  for (const pid of readdirSync("/proc").filter((entry) => /^\d+$/.test(entry))) {
    try {
      const parent = Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.split(" ")[1]);
      const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      if (parent === process.pid && args[1] === "run" && args.includes("--name")) {
        return args[args.indexOf("--name") + 1];
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function running(): boolean {
  const name = ownContainer();
  return name !== undefined && spawnSync("docker", ["inspect", "--format", "{{.State.Running}}", name], { encoding: "utf8" }).stdout.trim() === "true";
}

async function interrupting<T>(run: () => Promise<T>): Promise<T> {
  const others = process.listeners("SIGINT");
  process.removeAllListeners("SIGINT");
  const exits = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  let seen = false;
  const poll = setInterval(() => {
    if (!seen && running()) {
      seen = true;
      process.emit("SIGINT", "SIGINT");
    }
  }, POLL_MS);
  try {
    const ended = await run();
    expect(seen, "the run ended before its container was seen").toBe(true);
    return ended;
  } finally {
    clearInterval(poll);
    exits.mockRestore();
    for (const listener of others) {
      process.on("SIGINT", listener as NodeJS.SignalsListener);
    }
  }
}

describe("the judge sandbox mounts", () => {
  it("a batch of sandbox runs that pass, fail, crash, time out or are interrupted leaves the host no more mounts than before", { timeout: 1_500_000 }, async (context) => {
    if (SKIP !== undefined) {
      context.skip(SKIP);
    }
    const j = await job();
    const keys = { "judge.json": j.judge };
    const saved = { TMPDIR: process.env["TMPDIR"], XDG_RUNTIME_DIR: process.env["XDG_RUNTIME_DIR"] };
    const guard = join(tmpdir(), GUARD);
    const serial = await serialized();
    process.env["TMPDIR"] = guard;
    process.env["XDG_RUNTIME_DIR"] = guard;
    try {
      await mkdir(guard, { recursive: true, mode: 0o700 });
      await chmod(guard, 0o700);
      const base = await mountBase();
      expect(base, "the judge's private slot base under the guard directory").toBeDefined();
      const slot = join(base ?? guard, "slot-0");
      const outside = await planted(slot, join(j.dir, "outside"));
      const clean = ['test "$(ls -A /judge | tr "\\n" " ")" = "spec work "', 'test "$(ls -A /judge/work | tr "\\n" " ")" = "answer.txt src "', 'test "$(ls -A /judge/spec)" = SPEC.md'].join(" && ");
      expect((await cli(boxed(j, clean), keys)).json()).toMatchObject({ verdict: "pass", sandbox: "docker" });
      await planted(slot, outside);
      const listing = "import { readdirSync } from 'node:fs';\nexport default () => readdirSync('/judge').length;\n";
      expect((await judgeNode(BOX, bytes(listing), "one.mjs", casesOf([{ args: [], expected: 2 }]), 1, 60)).judged).toMatchObject({ total: 1, passed: 1 });
      expect(await readFile(join(outside, "kept"), "utf8")).toBe("outside");
      const before = await sources();
      const mounted = new Set(before.map((source) => source.split("/").at(-1)));
      if (!["work", "spec", "judge"].every((dir) => mounted.has(dir))) {
        context.skip("this Docker host keeps no host mount for each bind source, so there is no mount to count");
      }

      for (const [run, code, more] of [
        ["true", EXIT_OK, []],
        ["exit 4", EXIT_FAILED, []],
        ["sh -c 'kill -SEGV $$'; exit $?", EXIT_FAILED, []],
        ["sh -c 'kill -KILL $$'; exit $?", EXIT_RETRY, []],
        ["sleep 600", EXIT_RETRY, ["--timeout", String(STARTUP_SECONDS)]],
      ] as const) {
        expect((await cli(boxed(j, run, ...more), keys)).code, run).toBe(code);
      }
      const token = randomBytes(8).toString("hex");
      const stopped = await interrupting(() => cli(boxed(j, `sleep 600; echo ${token}`, "--timeout", "120"), keys));
      expect([stopped.code, stopped.out]).toEqual([INTERRUPTED, ""]);

      const one = casesOf([{ args: [], expected: 1 }]);
      expect((await judgeNode(BOX, bytes("export default () => 1;"), "one.mjs", one, 1, 60)).judged).toMatchObject({ total: 1, passed: 1 });
      expect((await judgeNode(BOX, bytes("export default () => 2;"), "one.mjs", one, 1, 60)).judged.failures).toMatchObject([{ verdict: "wrong" }]);
      expect((await judgeNode(BOX, bytes("process.abort();"), "one.mjs", one, 1, 60)).judged.passed).toBe(0);
      expect((await judgeNode(BOX, bytes("export default () => { for (;;) {} };"), "one.mjs", one, 1, STARTUP_SECONDS)).judged.failures).toMatchObject([{ verdict: "stopped" }]);
      const many = casesOf(Array.from({ length: 10 }, () => ({ args: [], expected: 1 })));
      const halted = await interrupting(() => judgeNode(BOX, bytes("export default () => { for (;;) {} };"), "one.mjs", many, 1, 120));
      expect(halted.judged.passed).toBe(0);
      expect(halted.judged.failures.at(-1)).toMatchObject({ verdict: "stopped", detail: "SIGINT stopped the judge" });

      const grown = added(before, await sources());
      expect(grown, `mount sources this batch added on the host:\n${grown.join("\n")}`).toEqual([]);
    } finally {
      spawnSync("chmod", ["-R", "u+rwX", guard]);
      await rm(guard, { recursive: true, force: true });
      serial.close();
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });
});
