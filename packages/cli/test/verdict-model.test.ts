import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT_RETRY, JudgeInfraError, JudgeInterrupted, oomInfra, SIGNAL_EXIT, timedOutInfra } from "../src/judge-errors.js";
import {
  combine,
  type ContainerState,
  containerOutcome,
  decided,
  endedBy,
  engineFaults,
  engineOutcome,
  EXIT_OF,
  exitedWith,
  failedCases,
  inspectFailed,
  NEVER_STARTED,
  NO_RULING,
  nothingJudged,
  notStarted,
  type Ruling,
  shellOutcome,
  startFailed,
  type Tally,
} from "../src/verdict-model.js";
import { ROOT } from "./judge-kit.js";

const LIMITS = { seconds: 30, memory: "512m" };
const ran = (exitCode: number, more: Partial<ContainerState> = {}): ContainerState => ({ started: true, exitCode, oomKilled: false, error: "", ...more });
const docker = (state: ContainerState | null, more: { deadline?: boolean; interrupted?: "SIGINT" | "SIGTERM"; inspect?: string; problem?: string } = {}) =>
  containerOutcome({ deadline: false, state, ...more }, LIMITS);
const shell = (exitCode: number | null, more: { deadline?: boolean; interrupted?: "SIGINT" | "SIGTERM"; signal?: string; problem?: string } = {}) =>
  shellOutcome({ deadline: false, exitCode, ...more }, LIMITS);
const PASS = { outcome: "pass" };
const fail = (reason: string) => ({ outcome: "fail", reason });
const infra = (reason: string) => ({ outcome: "infra", reason });
const ENGINE = "the viper judge";
const stopAt = (cause: "deadline" | "fault", unfinished: number) => ({ cause, reason: `${cause} reason`, unfinished });

const exitOf = (ruling: Ruling): number => (ruling.outcome === "interrupted" ? SIGNAL_EXIT[ruling.signal] : EXIT_OF[ruling.outcome]);

describe("the verdict model, row by row", () => {
  it("lets a started Docker container's own exit code decide, 125 and 137 included", () => {
    for (const code of [1, 2, 125, 126, 127, 137, 139, 255]) {
      expect(docker(ran(code)), String(code)).toEqual(fail(exitedWith(code)));
    }
    expect(docker(ran(0))).toEqual(PASS);
  });

  it("makes Docker's out-of-memory flag infra whatever the exit code, and leaves a 137 without it to the check", () => {
    for (const code of [0, 1, 125, 137]) {
      expect(docker(ran(code, { oomKilled: true })), String(code)).toEqual(infra(oomInfra("512m")));
    }
    expect(docker(ran(137))).toEqual(fail(exitedWith(137)));
  });

  it("makes a container with State.Error, one that never started, and a failed inspect infra", () => {
    for (const code of [0, 1, 125, 137]) {
      expect(docker(ran(code, { error: "OCI runtime create failed" })), String(code)).toEqual(infra(startFailed(code, "OCI runtime create failed")));
      expect(docker(ran(code, { started: false })), String(code)).toEqual(infra(NEVER_STARTED));
    }
    expect(docker(ran(0, { started: false, oomKilled: true, error: "boom" }))).toEqual(infra(startFailed(0, "boom")));
    expect(docker(null, { inspect: "Error: No such container" })).toEqual(infra(inspectFailed("Error: No such container")));
    expect(docker(null)).toEqual(infra(inspectFailed("")));
    expect(docker(null, { problem: "spawn docker ENOENT" })).toEqual(infra(notStarted("docker", "spawn docker ENOENT")));
  });

  it("makes a container the judge killed for its deadline infra, even when it ended with a code of its own", () => {
    for (const state of [null, ran(0), ran(1), ran(137, { oomKilled: true })]) {
      expect(docker(state, { deadline: true })).toEqual(infra(timedOutInfra(30)));
    }
  });

  it("lets an interrupt win over every Docker and shell outcome", () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      for (const ruling of [docker(ran(0), { interrupted: signal }), docker(null, { interrupted: signal, deadline: true }), shell(0, { interrupted: signal }), shell(null, { interrupted: signal, deadline: true })]) {
        expect(ruling).toEqual({ outcome: "interrupted", signal });
        expect(exitOf(ruling)).toBe(SIGNAL_EXIT[signal]);
      }
    }
  });

  it("lets the shell check's exit code decide under --sandbox none, a signal it did not get from the judge included", () => {
    expect(shell(0)).toEqual(PASS);
    for (const code of [1, 75, 125, 137]) {
      expect(shell(code), String(code)).toEqual(fail(exitedWith(code)));
    }
    expect(shell(null, { signal: "SIGKILL" })).toEqual(fail(endedBy("SIGKILL")));
    expect(shell(null, { deadline: true })).toEqual(infra(timedOutInfra(30)));
    expect(shell(0, { deadline: true })).toEqual(infra(timedOutInfra(30)));
    expect(shell(null, { problem: "spawn /bin/sh ENOENT" })).toEqual(infra(notStarted("the shell", "spawn /bin/sh ENOENT")));
  });

  it("makes an engine's overall deadline and an engine fault infra, and a case limit or a wrong answer a fail", () => {
    const tally = (more: Partial<Tally>): Tally => ({ total: 4, passed: 0, ...more });
    expect(engineOutcome(ENGINE, tally({ passed: 4 }))).toEqual(PASS);
    expect(engineOutcome(ENGINE, tally({ passed: 3 }))).toEqual(fail(failedCases(ENGINE, 1, 4)));
    expect(engineOutcome(ENGINE, tally({ stop: stopAt("deadline", 4) }))).toEqual(infra("deadline reason"));
    expect(engineOutcome(ENGINE, tally({ stop: stopAt("fault", 4) }))).toEqual(infra("fault reason"));
    expect(engineOutcome(ENGINE, tally({ passed: 2, stop: stopAt("deadline", 2) }))).toEqual(infra("deadline reason"));
    expect(engineOutcome(ENGINE, tally({ passed: 1, stop: stopAt("deadline", 2) }))).toEqual(fail(failedCases(ENGINE, 1, 4)));
    expect(engineOutcome(ENGINE, tally({ passed: 3, faults: 1 }))).toEqual(infra(engineFaults(ENGINE, 1)));
    expect(engineOutcome(ENGINE, tally({ passed: 2, faults: 1 }))).toEqual(fail(failedCases(ENGINE, 1, 4)));
    expect(engineOutcome(ENGINE, undefined)).toEqual(infra(nothingJudged(ENGINE)));
    expect(engineOutcome(ENGINE, { total: 0, passed: 0 })).toEqual(infra(nothingJudged(ENGINE)));
  });

  it("combines engines so a shown failure wins over infra, infra over a pass, and an interrupt over all", () => {
    const failing = fail("wrong") as Ruling;
    const stalled = infra("late") as Ruling;
    const passing = PASS as Ruling;
    expect(combine([passing, passing])).toEqual(PASS);
    expect(combine([passing, stalled])).toEqual(stalled);
    expect(combine([stalled, failing, passing])).toEqual(failing);
    expect(combine([failing, { outcome: "interrupted", signal: "SIGTERM" }])).toEqual({ outcome: "interrupted", signal: "SIGTERM" });
    expect(combine([])).toEqual(infra(NO_RULING));
  });

  it("turns infra into exit 75 and an interrupt into 130 or 143, and returns only pass or fail", () => {
    expect(EXIT_OF).toEqual({ pass: 0, fail: 1, infra: EXIT_RETRY });
    expect(() => decided(infra("late") as Ruling)).toThrow(new JudgeInfraError("late"));
    expect(new JudgeInfraError("late").exitCode).toBe(EXIT_RETRY);
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      expect(() => decided({ outcome: "interrupted", signal })).toThrow(JudgeInterrupted);
      expect(new JudgeInterrupted(signal).exitCode).toBe(SIGNAL_EXIT[signal]);
    }
    expect(decided(PASS as Ruling)).toEqual(PASS);
    expect(decided(fail("wrong") as Ruling)).toEqual(fail("wrong"));
  });
});

const INTERNALS = readFileSync(join(ROOT, "docs/maintainers/judge-internals.md"), "utf8");

const OUTCOME_ROWS: Record<string, Ruling> = {
  "`--sandbox docker`: the container started and exited 0": docker(ran(0)),
  "`--sandbox docker`: the container started and exited with any other code, 125 and 137 included": docker(ran(137)),
  "`--sandbox docker`: Docker flags the container out of memory, whatever its exit code": docker(ran(1, { oomKilled: true })),
  "`--sandbox docker`: Docker reports an error for the container, or the container never started": docker(ran(0, { started: false })),
  "`--sandbox docker`: `docker container inspect` fails or gives no answer in time": docker(null, { inspect: "timeout" }),
  "`--sandbox none`: the check exits 0": shell(0),
  "`--sandbox none`: the check exits with any other code, or a signal the judge did not send ends it": shell(null, { signal: "SIGKILL" }),
  "Docker or the shell cannot start the check": shell(null, { problem: "ENOENT" }),
  "the check runs past `--timeout`, so the judge stops it": docker(ran(0), { deadline: true }),
  "an engine runs past `--timeout`, or past the MCP tool's own time budget": engineOutcome(ENGINE, { total: 1, passed: 0, stop: stopAt("deadline", 1) }),
  "a case reaches a limit of its own: the host engine's per-call limit, the plain Node per-case limit, or the spec's `steps` or `heap`": engineOutcome(ENGINE, { total: 1, passed: 0 }),
  "a case answers wrongly, throws, answers no primitive, or the module does not load": engineOutcome(ENGINE, { total: 2, passed: 1 }),
  "an engine ends non-zero, writes no readable verdict, answers the wrong number of cases, or reports a fault of its own (`engine`)": engineOutcome(ENGINE, { total: 2, passed: 1, faults: 1 }),
  "every engine that ran answered every case": engineOutcome(ENGINE, { total: 2, passed: 2 }),
  "one engine fails a case while another is infra": combine([infra("late") as Ruling, engineOutcome(ENGINE, { total: 2, passed: 1 })]),
  "SIGINT or SIGTERM before the release is sent": docker(ran(0), { interrupted: "SIGTERM" }),
};

describe("the outcome table in docs/maintainers/judge-internals.md", () => {
  const section = INTERNALS.slice(INTERNALS.indexOf("## Outcomes"), INTERNALS.indexOf("\n## ", INTERNALS.indexOf("## Outcomes") + 1));
  const rows = section
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| What happened") && !line.startsWith("| ---"))
    .map((line) => line.slice(2, -2).split(" | "));

  it("lists exactly the rows the classifier is checked against", () => {
    expect(rows.map(([what]) => what)).toEqual(Object.keys(OUTCOME_ROWS));
  });

  it("states for each row the outcome, exit code and signature the classifier gives", () => {
    for (const [what = "", outcome, exit, signs] of rows) {
      const ruling = OUTCOME_ROWS[what] as Ruling;
      const expected = ruling.outcome === "interrupted" ? ["none", "130 or 143", "no"] : [ruling.outcome, String(EXIT_OF[ruling.outcome]), ruling.outcome === "pass" ? "yes" : "no"];
      expect([outcome, exit, signs], what).toEqual(expected);
      expect(exitOf(ruling) === Number(exit) || ruling.outcome === "interrupted", what).toBe(true);
    }
  });
});
