import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CASE_UNMETERED, judgeNode, NODE_MISS_MS } from "../src/node-judge.js";
import { CPU_STAT, MEMORY_EVENTS } from "../src/check-process.js";
import { SANDBOX_CPUS, SANDBOX_IMAGE, SANDBOX_TMP } from "../src/sandbox.js";
import type { Cases } from "../src/viper.js";
import { DOCKER_TEST } from "./docker-switch.js";

const shared = vi.hoisted(() => ({ dir: "", events: false }));

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  const spawn = (...all: Parameters<typeof actual.spawn>) => {
    const [command, args, options] = all as unknown as [string, string[], object | undefined];
    if (command !== "docker" || !Array.isArray(args) || args[0] !== "run" || !args.some((arg) => String(arg).endsWith("launch.mjs"))) return actual.spawn(...all);
    const child = actual.spawn("docker", ["run", "--mount", `type=bind,source=${shared.dir},target=/flicker`, ...args.slice(1)], options ?? {});
    const stdin = child.stdin;
    if (stdin !== null) {
      const write = stdin.write.bind(stdin) as (chunk: unknown, ...rest: unknown[]) => boolean;
      const moved = (text: string) => (shared.events ? text.split(JSON.stringify(MEMORY_EVENTS)).join(JSON.stringify("/flicker/memory.events")) : text);
      stdin.write = ((chunk: unknown, ...rest: unknown[]) => write(moved(String(chunk).split(JSON.stringify(CPU_STAT)).join(JSON.stringify("/flicker/cpu.stat"))), ...rest)) as typeof stdin.write;
    }
    return child;
  };
  return { ...actual, spawn: vi.fn(spawn) };
});

const BOX = { image: SANDBOX_IMAGE, memory: "512m", cpus: SANDBOX_CPUS, tmp: SANDBOX_TMP, gpu: false };
const CASES: Cases = { steps: 1_000_000, heap: 1 << 24, seed: 1, clock: 0, caseMs: 5_000, cases: [{ args: [2], expected: 4 }] };

const flickering = (gaps: string, spanMs: number, endMissing: boolean) => `
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
const gaps = ${gaps};
export default (n) => {
  const from = performance.now();
  let wrote = 0;
  for (;;) {
    const at = performance.now() - from;
    if (at >= ${spanMs}) break;
    const hidden = gaps.some(([start, length]) => at >= start && at < start + length);
    if (hidden) {
      rmSync("/flicker/cpu.stat", { force: true });
    } else if (at - wrote >= 2) {
      const used = process.cpuUsage();
      writeFileSync("/flicker/next", "usage_usec " + (used.user + used.system) + "\\n");
      renameSync("/flicker/next", "/flicker/cpu.stat");
      wrote = at;
    }
  }
  if (${endMissing}) rmSync("/flicker/cpu.stat", { force: true });
  return n * 2;
};
`;

const judged = async (source: string) => {
  shared.dir = mkdtempSync(join(tmpdir(), "judge-flicker-"));
  chmodSync(shared.dir, 0o777);
  writeFileSync(join(shared.dir, "cpu.stat"), "usage_usec 0\n");
  chmodSync(join(shared.dir, "cpu.stat"), 0o666);
  const { judged: node } = await judgeNode(BOX, new TextEncoder().encode(source), "work.mjs", CASES, 1, 120);
  return node;
};

const EVENTS = "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n";

const restoredAfterEnd = `
import { renameSync, rmSync, writeFileSync } from "node:fs";
export default (n) => {
  const used = process.cpuUsage();
  writeFileSync("/flicker/next", "usage_usec " + (used.user + used.system) + "\\n");
  renameSync("/flicker/next", "/flicker/cpu.stat");
  rmSync("/flicker/cpu.stat", { force: true });
  rmSync("/flicker/memory.events", { force: true });
  writeFileSync("/flicker/ended", "");
  return n * 2;
};
`;

describe("the plain Node launcher's CPU reading under reads that fail for a moment", () => {
  it("reads the CPU time and the out-of-memory counts after a case again until they can be read, rather than giving up at once", DOCKER_TEST, async () => {
    shared.events = true;
    try {
      shared.dir = mkdtempSync(join(tmpdir(), "judge-flicker-"));
      chmodSync(shared.dir, 0o777);
      for (const [name, text] of [["cpu.stat", "usage_usec 0\n"], ["memory.events", EVENTS]] as const) {
        writeFileSync(join(shared.dir, name), text);
        chmodSync(join(shared.dir, name), 0o666);
      }
      const restorer = setInterval(() => {
        if (!existsSync(join(shared.dir, "ended")) || existsSync(join(shared.dir, "restoring"))) return;
        writeFileSync(join(shared.dir, "restoring"), "");
        setTimeout(() => writeFileSync(join(shared.dir, "cpu.stat"), "usage_usec 1000\n"), 150);
        setTimeout(() => writeFileSync(join(shared.dir, "memory.events"), EVENTS), 550);
      }, 5);
      try {
        const { judged: node } = await judgeNode(BOX, new TextEncoder().encode(restoredAfterEnd), "work.mjs", { ...CASES, nodeMemory: "512m" }, 1, 120);
        expect([node.passed, node.failures, node.stop]).toEqual([1, [], undefined]);
      } finally {
        clearInterval(restorer);
      }
    } finally {
      shared.events = false;
    }
  });

  it("keeps metering a case through short read failures, as the kernel gives while a container sits at its memory limit", DOCKER_TEST, async () => {
    const node = await judged(flickering("[[100, 50], [250, 50], [400, 50], [550, 50], [700, 50]]", 900, false));
    expect([node.passed, node.failures, node.stop]).toEqual([1, [], undefined]);
  });

  it("stops metering, as infra, once reads fail for longer than NODE_MISS_MS, or the reading after the case cannot be read", DOCKER_TEST, async () => {
    const long = await judged(flickering(`[[100, ${NODE_MISS_MS + 500}]]`, NODE_MISS_MS + 900, false));
    expect([long.passed, long.failures, long.stop?.reason]).toEqual([0, [], CASE_UNMETERED]);
    const ended = await judged(flickering("[]", 300, true));
    expect([ended.passed, ended.failures, ended.stop?.reason]).toEqual([0, [], CASE_UNMETERED]);
  });
});
