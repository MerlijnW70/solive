import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { launch } from "../src/launch.js";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

describe("launching a helper program", () => {
  it("collects its output and exit code, and hides its window", async () => {
    expect(await launch(process.execPath, ["-e", "process.stdout.write('out'); process.exit(3)"], "linux")).toStrictEqual({ code: 3, output: "out" });
    expect(vi.mocked(spawn).mock.calls.at(-1)?.[2]).toStrictEqual({ stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  });
});
