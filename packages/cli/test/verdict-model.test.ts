import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT_RETRY, JudgeInfraError, JudgeInterrupted, oomInfra, SIGNAL_EXIT, timedOutInfra } from "../src/judge-errors.js";
import {
  type CaseEnd,
  caseFilledPinned,
  caseOomInfra,
  caseOomPinned,
  caseOutcome,
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
  KILLED_EXIT,
  killedUnflagged,
  NEVER_STARTED,
  NO_RULING,
  nothingJudged,
  notStarted,
  OOM_UNREAD,
  oomPinned,
  pinnedFill,
  ranPastPin,
  RUN_UNTIMED,
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

const ended = (more: Partial<CaseEnd>): CaseEnd => ({ signal: "SIGKILL", stoppedByJudge: false, oomKills: 0, ...more });

const exitOf = (ruling: Ruling): number => (ruling.outcome === "interrupted" ? SIGNAL_EXIT[ruling.signal] : EXIT_OF[ruling.outcome]);

describe("the verdict model, row by row", () => {
  it("lets a started Docker container's own exit code decide, 125 included, and 137 under memory a judge-run block pins", () => {
    for (const code of [1, 2, 125, 126, 127, 136, 138, 139, 255]) {
      expect(docker(ran(code)), String(code)).toEqual(fail(exitedWith(code)));
    }
    expect(docker(ran(0))).toEqual(PASS);
    expect(KILLED_EXIT).toBe(137);
    const pinnedMemory = { seconds: 90, memory: "1g", pinned: { seconds: 60, memory: "512m" } };
    expect(containerOutcome({ deadline: false, state: ran(137), ranAtMostMs: 10 }, pinnedMemory)).toEqual(fail(exitedWith(137)));
  });

  it("makes Docker's out-of-memory flag infra whatever the exit code under the memory the judge chose, and fail under pinned memory", () => {
    const pinnedMemory = { seconds: 90, memory: "1g", pinned: { seconds: 60, memory: "512m" } };
    for (const code of [0, 1, 125, 137]) {
      expect(docker(ran(code, { oomKilled: true })), String(code)).toEqual(infra(oomInfra("512m")));
      expect(containerOutcome({ deadline: false, state: ran(code, { oomKilled: true }), ranAtMostMs: 10 }, pinnedMemory), String(code)).toEqual(fail(oomPinned("512m")));
    }
  });

  it("makes an exit 137 without Docker's flag infra under the memory the judge chose, a self-kill included, since Docker can miss the flag", () => {
    expect(docker(ran(137))).toEqual(infra(killedUnflagged("512m")));
    const timeOnly = { seconds: 90, memory: "1g", pinned: { seconds: 60 } };
    for (const ranAtMostMs of [10, 60_000, undefined]) {
      const more = ranAtMostMs === undefined ? {} : { ranAtMostMs };
      expect(containerOutcome({ deadline: false, state: ran(137), ...more }, timeOnly), String(ranAtMostMs)).toEqual(infra(killedUnflagged("1g")));
    }
    const pinnedMemory = { seconds: 90, memory: "1g", pinned: { seconds: 60, memory: "512m" } };
    expect(containerOutcome({ deadline: false, state: ran(137), ranAtMostMs: 10 }, pinnedMemory)).toEqual(fail(exitedWith(137)));
    expect(containerOutcome({ deadline: false, state: ran(137), ranAtMostMs: 60_000 }, pinnedMemory)).toEqual(infra(RUN_UNTIMED));
    expect(docker(ran(137), { deadline: true })).toEqual(infra(timedOutInfra(30)));
    expect(docker(ran(137, { error: "OCI runtime create failed" }))).toEqual(infra(startFailed(137, "OCI runtime create failed")));
    expect(docker(ran(137), { interrupted: "SIGINT" })).toEqual({ outcome: "interrupted", signal: "SIGINT" });
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

  it("under a judge-run block, fails a check the judge's own clock saw still running at the pinned timeout, or out of pinned memory", () => {
    const PINNED = { seconds: 90, memory: "1g", pinned: { seconds: 60, memory: "512m" } };
    const LEFT = { seconds: 90, memory: "1g", pinned: { seconds: 60 } };
    type More = { deadline?: boolean; interrupted?: "SIGINT" | "SIGTERM"; inspect?: string; problem?: string; overran?: boolean; ranAtMostMs?: number };
    const pinned = (state: ContainerState | null, more: More = {}, limits: typeof PINNED | typeof LEFT = PINNED) => containerOutcome({ deadline: false, state, ...more }, limits);
    for (const state of [null, ran(0), ran(1), ran(137, { oomKilled: true })]) {
      expect(pinned(state, { overran: true }), JSON.stringify(state)).toEqual(fail(ranPastPin(60)));
      expect(pinned(state, { overran: true, deadline: true }), JSON.stringify(state)).toEqual(fail(ranPastPin(60)));
    }
    expect(pinned(ran(0), { ranAtMostMs: 59_999 })).toEqual(PASS);
    for (const code of [1, 3, 137]) {
      expect(pinned(ran(code), { ranAtMostMs: 100 }), String(code)).toEqual(fail(exitedWith(code)));
    }
    expect(pinned(ran(137), { ranAtMostMs: 100 }, LEFT)).toEqual(infra(killedUnflagged("1g")));
    for (const code of [0, 1]) {
      for (const more of [{ ranAtMostMs: 60_000 }, { ranAtMostMs: 600_000 }, {}]) {
        expect(pinned(ran(code), more), `${code} ${JSON.stringify(more)}`).toEqual(infra(RUN_UNTIMED));
      }
    }
    for (const ranAtMostMs of [100, 60_000, undefined]) {
      const more = ranAtMostMs === undefined ? {} : { ranAtMostMs };
      expect(pinned(ran(1, { oomKilled: true }), more), String(ranAtMostMs)).toEqual(fail(oomPinned("512m")));
      expect(pinned(ran(1, { oomKilled: true }), more, LEFT), String(ranAtMostMs)).toEqual(infra(oomInfra("1g")));
    }
    expect(pinned(null, { deadline: true, ranAtMostMs: 90_000 })).toEqual(infra(timedOutInfra(90)));
    expect(pinned(ran(0), { deadline: true, ranAtMostMs: 10 })).toEqual(infra(timedOutInfra(90)));
    expect(pinned(ran(0, { error: "OCI runtime create failed" }), { ranAtMostMs: 10 })).toEqual(infra(startFailed(0, "OCI runtime create failed")));
    expect(pinned(ran(0, { started: false }), { ranAtMostMs: 10 })).toEqual(infra(NEVER_STARTED));
    expect(pinned(null, { inspect: "gone", ranAtMostMs: 10 })).toEqual(infra(inspectFailed("gone")));
    expect(pinned(null, { problem: "spawn docker ENOENT" })).toEqual(infra(notStarted("docker", "spawn docker ENOENT")));
    expect(pinned(ran(0), { overran: true, interrupted: "SIGINT" })).toEqual({ outcome: "interrupted", signal: "SIGINT" });
    expect(containerOutcome({ deadline: false, state: ran(0), overran: true, ranAtMostMs: 999_999 }, LIMITS)).toEqual(PASS);
    expect(docker(ran(1, { oomKilled: true }))).toEqual(infra(oomInfra("512m")));
  });

  it("makes a plain Node case killed with signal 9 while its container's out-of-memory count rose infra under the memory the judge chose, and fail under pinned memory", () => {
    expect(caseOutcome(ended({ oomKills: 1 }), LIMITS)).toEqual(infra(caseOomInfra("512m")));
    expect(caseOutcome(ended({ oomKills: 3 }), LIMITS)).toEqual(infra(caseOomInfra("512m")));
    const pinnedMemory = { seconds: 90, memory: "1g", pinned: { seconds: 60, memory: "256m" } };
    expect(caseOutcome(ended({ oomKills: 1 }), pinnedMemory)).toEqual(fail(caseOomPinned("256m")));
    expect(caseOutcome(ended({ oomKills: 1 }), { seconds: 90, memory: "1g", pinned: { seconds: 60 } })).toEqual(infra(caseOomInfra("1g")));
    expect(caseOutcome(ended({ oomKills: null }), LIMITS)).toEqual(infra(OOM_UNREAD));
  });

  it("fails a plain Node case under pinned memory whenever the count rose while it ran, and only then", () => {
    const pinnedMemory = { seconds: 90, memory: "1g", pinned: { seconds: 60, memory: "256m" } };
    expect([pinnedFill(1, pinnedMemory), pinnedFill(4, pinnedMemory)]).toEqual([fail(caseFilledPinned("256m")), fail(caseFilledPinned("256m"))]);
    expect([pinnedFill(0, pinnedMemory), pinnedFill(null, pinnedMemory), pinnedFill(1, LIMITS), pinnedFill(1, { seconds: 90, memory: "1g", pinned: { seconds: 60 } })]).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("leaves a plain Node case that kills itself, aborts, exits, or is stopped by the judge to its own verdict, whatever the out-of-memory count", () => {
    expect(caseOutcome(ended({ oomKills: 0 }), LIMITS)).toBeUndefined();
    for (const oomKills of [0, 1, null]) {
      for (const signal of ["SIGABRT", "SIGSEGV", "SIGTERM", null]) {
        expect(caseOutcome(ended({ signal, oomKills }), LIMITS), `${signal} ${oomKills}`).toBeUndefined();
      }
      expect(caseOutcome(ended({ stoppedByJudge: true, oomKills }), LIMITS), String(oomKills)).toBeUndefined();
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
  "`--sandbox docker`: the container started and exited with any other code, 125 included": docker(ran(125)),
  "`--sandbox docker`: the container exited 137, a kill with signal 9, under the memory the judge chose, and Docker did not flag it out of memory": docker(ran(137)),
  "`--sandbox docker`: Docker flags the container out of memory the judge chose, whatever its exit code": docker(ran(1, { oomKilled: true })),
  "`--sandbox docker` under a `judge-run` block: Docker flags the container out of the pinned `memory`, whatever its exit code or how long it ran": containerOutcome(
    { deadline: false, state: ran(0, { oomKilled: true }) },
    { ...LIMITS, pinned: { seconds: 5, memory: "512m" } },
  ),
  "`--sandbox docker` under a `judge-run` block: on the judge's own clock the check was still running at the pinned `timeout` after it started, whatever its exit code": containerOutcome(
    { deadline: true, state: null, overran: true },
    { ...LIMITS, pinned: { seconds: 5 } },
  ),
  "`--sandbox docker` under a `judge-run` block: on the judge's own clock the container ended less than the pinned `timeout` after it could have started, and it exited 0": containerOutcome(
    { deadline: false, state: ran(0), ranAtMostMs: 4_999 },
    { ...LIMITS, pinned: { seconds: 5 } },
  ),
  "`--sandbox docker` under a `judge-run` block: on the judge's own clock the container ended less than the pinned `timeout` after it could have started, and it exited with any other code, 137 only when the block pins `memory`": containerOutcome(
    { deadline: false, state: ran(137), ranAtMostMs: 10 },
    { ...LIMITS, pinned: { seconds: 5, memory: "512m" } },
  ),
  "`--sandbox docker` under a `judge-run` block: the container ended, but the judge's own clock cannot show that it ran less than the pinned `timeout`": containerOutcome(
    { deadline: false, state: ran(0), ranAtMostMs: 5_000 },
    { ...LIMITS, pinned: { seconds: 5 } },
  ),
  "`--sandbox docker`: Docker reports an error for the container, or the container never started": docker(ran(0, { started: false })),
  "`--sandbox docker`: `docker container inspect` fails or gives no answer in time": docker(null, { inspect: "timeout" }),
  "`--sandbox none`: the check exits 0": shell(0),
  "`--sandbox none`: the check exits with any other code, or a signal the judge did not send ends it": shell(null, { signal: "SIGKILL" }),
  "Docker or the shell cannot start the check": shell(null, { problem: "ENOENT" }),
  "the check runs past `--timeout`, so the judge stops it, and the judge never saw it run a pinned `timeout`": containerOutcome({ deadline: true, state: null, ranAtMostMs: 4_000 }, { ...LIMITS, pinned: { seconds: 5 } }),
  "`--plain-node`: a case is killed with signal 9 while the kernel's out-of-memory count for its container rises, under the memory the judge chose": caseOutcome(ended({ oomKills: 1 }), LIMITS) as Ruling,
  "`--plain-node`: a case is killed with signal 9, and the judge cannot read its container's out-of-memory count": caseOutcome(ended({ oomKills: null }), LIMITS) as Ruling,
  "`--plain-node` under a `judge-cases` block that pins `node_memory`: the out-of-memory count rises while a case runs, or the container ends while a case runs and Docker flags it out of memory or its launcher was killed with signal 9": pinnedFill(1, {
    ...LIMITS,
    pinned: { seconds: 5, memory: "512m" },
  }) as Ruling,
  "`--plain-node`: a case kills itself, aborts or exits, or is killed with signal 9 while the out-of-memory count stays the same": caseOutcome(ended({ oomKills: 0 }), LIMITS) ?? engineOutcome(ENGINE, { total: 1, passed: 0 }),
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
