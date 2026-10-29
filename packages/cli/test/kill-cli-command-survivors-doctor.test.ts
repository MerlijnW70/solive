import { beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT_FAILED, EXIT_OK } from "../src/main.js";
import { sandboxDoctor } from "../src/sandbox-doctor.js";
import { cli } from "./harness.js";

vi.mock("../src/sandbox-doctor.js", async (original) => ({ ...(await original<typeof import("../src/sandbox-doctor.js")>()), sandboxDoctor: vi.fn() }));

const doctor = vi.mocked(sandboxDoctor);

describe("the exit code of sandbox doctor", () => {
  beforeEach(() => {
    doctor.mockReset();
  });

  it("exits 0 for a ready sandbox", async () => {
    doctor.mockResolvedValue({ ready: true } as never);
    const run = await cli(["sandbox", "doctor"], {});
    expect([run.code, run.err, run.json()]).toStrictEqual([EXIT_OK, "", { ready: true }]);
  });

  it("exits 1 for a sandbox that is not ready", async () => {
    doctor.mockResolvedValue({ ready: false } as never);
    const run = await cli(["sandbox", "doctor"], {});
    expect([run.code, run.json()]).toStrictEqual([EXIT_FAILED, { ready: false }]);
  });

  it("exits 0 for a result that says nothing about readiness", async () => {
    doctor.mockResolvedValue({ checks: [] } as never);
    expect((await cli(["sandbox", "doctor"], {})).code).toBe(EXIT_OK);
  });
});
