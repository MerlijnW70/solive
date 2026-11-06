import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROBE_LIMITS } from "../src/sandbox-doctor.js";
import { cli } from "./harness.js";
import { scriptedDocker } from "./scripted-docker.js";

const seen = vi.hoisted(() => ({ timeouts: [] as number[] }));

vi.mock("../src/check-process.js", async (original) => {
  const real = await original<typeof import("../src/check-process.js")>();
  return {
    ...real,
    runContainer: (...args: Parameters<typeof real.runContainer>) => {
      seen.timeouts.push(args[3]);
      return real.runContainer(...args);
    },
  };
});

describe.skipIf(process.platform !== "linux")("the sandbox doctor command", () => {
  let dir = "";
  let path: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "doctor-default-limits-"));
    path = process.env["PATH"];
    seen.timeouts.length = 0;
  });

  afterEach(async () => {
    if (path === undefined) {
      delete process.env["PATH"];
    } else {
      process.env["PATH"] = path;
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps the real probe limits", async () => {
    expect(PROBE_LIMITS).toStrictEqual({ probeSeconds: 60, timeoutProbeSeconds: 3 });
    const bin = join(dir, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "docker"), scriptedDocker(join(dir, "calls.log"), dir, {}));
    await chmod(join(bin, "docker"), 0o755);
    process.env["PATH"] = bin;
    const run = await cli(["sandbox", "doctor", "--keypair", join(dir, "judge.json")], {});
    const checks = run.json()["checks"] as unknown[];
    expect(seen.timeouts.length).toBe(checks.length - 1);
    expect(seen.timeouts.slice(0, -1).every((seconds) => seconds === PROBE_LIMITS.probeSeconds)).toBe(true);
    expect(seen.timeouts.at(-1)).toBe(PROBE_LIMITS.timeoutProbeSeconds);
  });
});
