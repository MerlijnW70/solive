import { HOST_CALL_MS, hostTally } from "../src/host-judge.js";
import { nodeUnmetered } from "../src/node-judge.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError } from "@solana/kit";
import { EXIT_REFUSED, EXIT_RETRY, EXIT_SENT, JudgeInfraError, JudgeInterrupted, JudgeRefused, JudgeUnreadable, oomInfra, oomInfraUnpinned, ReleaseUncertain, SIGNAL_EXIT, timedOutInfra } from "../src/judge-errors.js";
import {
  type CaseEnd,
  caseFilledChosen,
  caseFilledPinned,
  caseMemory,
  caseOomInfra,
  caseOomPinned,
  caseOutcome,
  chosenFill,
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
  hostKillPinned,
  inspectFailed,
  KILLED_EXIT,
  killedUnflagged,
  launcherFlaggedPinned,
  launcherKilledPinned,
  killedUnflaggedUnpinned,
  NEVER_STARTED,
  NO_RULING,
  nothingJudged,
  notStarted,
  OOM_UNREAD,
  OOM_UNREAD_PINNED,
  oomPinned,
  pinnedFill,
  pinnedLauncherEnd,
  ranPastPin,
  RUN_UNTIMED,
  type MemoryRise,
  oomExited,
  oomExitedUnpinned,
  type Ruling,
  shellOutcome,
  startFailed,
  stoppedBeforePin,
  type Tally,
} from "../src/verdict-model.js";
import { EXIT_FAILED, EXIT_USAGE, exitOfError } from "../src/main.js";
import { UsageError } from "../src/args.js";
import { memoryUnlocked } from "../src/node-judge.js";
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

const kills = (count: number): MemoryRise => ({ oom: count, oomKill: count });
const ended = (more: Partial<CaseEnd>): CaseEnd => ({ signal: "SIGKILL", stoppedByJudge: false, rise: kills(0), ...more });
const HOST_KILL: MemoryRise = { oom: 0, oomKill: 1 };

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

  it("makes Docker's out-of-memory flag infra under the memory the judge chose unless the check exited 0, and fail under pinned memory whatever the exit code", () => {
    const pinnedMemory = { seconds: 90, memory: "1g", pinned: { seconds: 60, memory: "512m" } };
    expect(docker(ran(0, { oomKilled: true }))).toEqual(PASS);
    for (const code of [1, 3, 125]) {
      expect(docker(ran(code, { oomKilled: true })), String(code)).toEqual(infra(oomExited(code, "512m")));
    }
    expect(docker(ran(137, { oomKilled: true }))).toEqual(infra(oomInfra("512m")));
    for (const code of [0, 1, 125, 137]) {
      expect(containerOutcome({ deadline: false, state: ran(code, { oomKilled: true }), ranAtMostMs: 10 }, pinnedMemory), String(code)).toEqual(fail(oomPinned("512m")));
    }
  });

  it("gives a check that forks a memory hog the kernel kills and exits 1 the same infra as the plain Node case that does under the memory the judge chose, and the same fail under pinned memory", () => {
    const hogged = docker(ran(1, { oomKilled: true }));
    const caseEnd = caseMemory({ signal: null, stoppedByJudge: false, rise: kills(1) }, false, LIMITS);
    expect([hogged, caseEnd]).toEqual([infra(oomExited(1, "512m")), infra(caseFilledChosen("512m"))]);
    expect(caseMemory({ signal: "SIGKILL", stoppedByJudge: false, rise: kills(1) }, false, LIMITS)?.outcome).toBe(docker(ran(137, { oomKilled: true })).outcome);
    const pinnedMemory = { seconds: 90, memory: "1g", pinned: { seconds: 60, memory: "512m" } };
    const pinnedHog = containerOutcome({ deadline: false, state: ran(1, { oomKilled: true }), ranAtMostMs: 10 }, pinnedMemory);
    expect([pinnedHog, caseMemory({ signal: null, stoppedByJudge: false, rise: kills(1) }, false, pinnedMemory)]).toEqual([fail(oomPinned("512m")), fail(caseFilledPinned("512m"))]);
  });

  it("does not say the case's own process used the memory when the kernel killed its whole group, since a process it started may have filled it", () => {
    const pinnedMemory = { seconds: 90, memory: "1g", pinned: { seconds: 60, memory: "512m" } };
    const grouped = { oom: 1, oomKill: 2, groupKill: 1 };
    expect(caseMemory({ signal: "SIGKILL", stoppedByJudge: false, rise: grouped }, false, pinnedMemory)).toEqual(fail(caseFilledPinned("512m")));
    expect(caseMemory({ signal: "SIGKILL", stoppedByJudge: false, rise: grouped }, false, LIMITS)).toEqual(infra(caseFilledChosen("512m")));
    expect(caseMemory({ signal: "SIGKILL", stoppedByJudge: false, rise: { oom: 1, oomKill: 1, groupKill: 0 } }, false, pinnedMemory)).toEqual(fail(caseOomPinned("512m")));
    expect(caseMemory({ signal: "SIGKILL", stoppedByJudge: false, rise: { oom: 0, oomKill: 2, groupKill: 1 } }, false, pinnedMemory)).toEqual(infra(hostKillPinned("512m")));
  });

  it("lets a check whose hog the kernel killed pass when it exits 0 or answers rightly, on both routes, under the memory the judge chose", () => {
    expect(docker(ran(0, { oomKilled: true }))).toEqual(PASS);
    expect(caseMemory({ signal: null, stoppedByJudge: false, rise: kills(1) }, true, LIMITS)).toBeUndefined();
    expect(chosenFill(kills(1), LIMITS)).toEqual(infra(caseFilledChosen("512m")));
  });

  it("makes every unpinned memory kill infra only when the result would otherwise be a fail, whatever else ended the case", () => {
    const timeOnly = { seconds: 90, memory: "1g", pinned: { seconds: 60 } };
    for (const limits of [LIMITS, timeOnly]) {
      for (const end of [ended({ signal: null, rise: kills(1) }), ended({ signal: "SIGABRT", rise: kills(2) }), ended({ stoppedByJudge: true, rise: kills(1) }), ended({ signal: null, rise: HOST_KILL })]) {
        expect(caseMemory(end, false, limits)?.outcome, JSON.stringify(end)).toBe("infra");
        expect(caseMemory(end, true, limits), JSON.stringify(end)).toBeUndefined();
      }
      for (const rise of [kills(0), { oom: 3, oomKill: 0 }, null]) {
        expect(caseMemory(ended({ signal: null, rise }), false, limits), JSON.stringify(rise)).toBeUndefined();
      }
    }
    for (const code of [1, 2, 125, 255]) {
      expect(containerOutcome({ deadline: false, state: ran(code, { oomKilled: true }), ranAtMostMs: 10 }, timeOnly), String(code)).toEqual(infra(oomExitedUnpinned(code, "1g")));
    }
  });

  it("makes an exit 137 without Docker's flag infra under the memory the judge chose, a self-kill included, since Docker can miss the flag", () => {
    expect(docker(ran(137))).toEqual(infra(killedUnflagged("512m")));
    const timeOnly = { seconds: 90, memory: "1g", pinned: { seconds: 60 } };
    for (const ranAtMostMs of [10, 60_000, undefined]) {
      const more = ranAtMostMs === undefined ? {} : { ranAtMostMs };
      expect(containerOutcome({ deadline: false, state: ran(137), ...more }, timeOnly), String(ranAtMostMs)).toEqual(infra(killedUnflaggedUnpinned("1g")));
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
    expect(pinned(ran(137), { ranAtMostMs: 100 }, LEFT)).toEqual(infra(killedUnflaggedUnpinned("1g")));
    for (const code of [0, 1]) {
      for (const more of [{ ranAtMostMs: 60_000 }, { ranAtMostMs: 600_000 }, {}]) {
        expect(pinned(ran(code), more), `${code} ${JSON.stringify(more)}`).toEqual(infra(RUN_UNTIMED));
      }
    }
    for (const ranAtMostMs of [100, 60_000, undefined]) {
      const more = ranAtMostMs === undefined ? {} : { ranAtMostMs };
      expect(pinned(ran(1, { oomKilled: true }), more), String(ranAtMostMs)).toEqual(fail(oomPinned("512m")));
      expect(pinned(ran(137, { oomKilled: true }), more, LEFT), String(ranAtMostMs)).toEqual(infra(oomInfraUnpinned("1g")));
      expect(pinned(ran(1, { oomKilled: true }), more, LEFT), String(ranAtMostMs)).toEqual(infra(oomExitedUnpinned(1, "1g")));
    }
    expect(pinned(null, { deadline: true, ranAtMostMs: 90_000 })).toEqual(infra(stoppedBeforePin(90, 60)));
    expect(pinned(ran(0), { deadline: true, ranAtMostMs: 10 })).toEqual(infra(stoppedBeforePin(90, 60)));
    expect(pinned(ran(0, { error: "OCI runtime create failed" }), { ranAtMostMs: 10 })).toEqual(infra(startFailed(0, "OCI runtime create failed")));
    expect(pinned(ran(0, { started: false }), { ranAtMostMs: 10 })).toEqual(infra(NEVER_STARTED));
    expect(pinned(null, { inspect: "gone", ranAtMostMs: 10 })).toEqual(infra(inspectFailed("gone")));
    expect(pinned(null, { problem: "spawn docker ENOENT" })).toEqual(infra(notStarted("docker", "spawn docker ENOENT")));
    expect(pinned(ran(0), { overran: true, interrupted: "SIGINT" })).toEqual({ outcome: "interrupted", signal: "SIGINT" });
    expect(containerOutcome({ deadline: false, state: ran(0), overran: true, ranAtMostMs: 999_999 }, LIMITS)).toEqual(PASS);
    expect(docker(ran(1, { oomKilled: true }))).toEqual(infra(oomExited(1, "512m")));
  });

  it("advises --sandbox-memory only where it is accepted: never under a judge-run block, whether or not it pins memory", () => {
    const loose = { seconds: 90, memory: "1g", pinned: { seconds: 60 } };
    const tight = { seconds: 90, memory: "1g", pinned: { seconds: 60, memory: "512m" } };
    const reasons = [
      docker(ran(137, { oomKilled: true })),
      docker(ran(137)),
      containerOutcome({ deadline: false, state: ran(137, { oomKilled: true }), ranAtMostMs: 10 }, loose),
      containerOutcome({ deadline: false, state: ran(137), ranAtMostMs: 10 }, loose),
      containerOutcome({ deadline: false, state: ran(1, { oomKilled: true }), ranAtMostMs: 10 }, tight),
      docker(ran(1, { oomKilled: true })),
      containerOutcome({ deadline: false, state: ran(1, { oomKilled: true }), ranAtMostMs: 10 }, loose),
    ].map((ruling) => (ruling as { reason: string }).reason);
    expect(reasons.map((reason) => reason.includes("different --sandbox-memory is refused"))).toEqual([false, false, true, true, false, false, true]);
    expect(reasons.map((reason) => reason.includes("raise --sandbox-memory"))).toEqual([true, true, false, false, false, true, false]);
    expect(reasons[4]).toBe(oomPinned("512m"));
  });

  it("makes a plain Node case killed with signal 9 while its container's out-of-memory count rose infra under the memory the judge chose, and fail under pinned memory", () => {
    expect(caseOutcome(ended({ rise: kills(1) }), LIMITS)).toEqual(infra(caseOomInfra("512m")));
    expect(caseOutcome(ended({ rise: kills(3) }), LIMITS)).toEqual(infra(caseOomInfra("512m")));
    expect(caseOutcome(ended({ rise: HOST_KILL }), LIMITS)).toEqual(infra(caseOomInfra("512m")));
    const pinnedMemory = { seconds: 90, memory: "1g", pinned: { seconds: 60, memory: "256m" } };
    expect(caseOutcome(ended({ rise: kills(1) }), pinnedMemory)).toEqual(fail(caseOomPinned("256m")));
    expect(caseOutcome(ended({ rise: kills(1) }), { seconds: 90, memory: "1g", pinned: { seconds: 60 } })).toEqual(infra(caseOomInfra("1g")));
    expect(caseOutcome(ended({ rise: null }), LIMITS)).toEqual(infra(OOM_UNREAD));
  });

  it("fails a plain Node case under pinned memory whenever both counts rose while it ran, and only then", () => {
    const pinnedMemory = { seconds: 90, memory: "1g", pinned: { seconds: 60, memory: "256m" } };
    expect([pinnedFill(kills(1), pinnedMemory), pinnedFill({ oom: 2, oomKill: 4 }, pinnedMemory)]).toEqual([fail(caseFilledPinned("256m")), fail(caseFilledPinned("256m"))]);
    expect([pinnedFill(kills(0), pinnedMemory), pinnedFill({ oom: 5, oomKill: 0 }, pinnedMemory), pinnedFill(null, LIMITS), pinnedFill(kills(1), LIMITS), pinnedFill(kills(1), { seconds: 90, memory: "1g", pinned: { seconds: 60 } })]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("makes an out-of-memory kill under pinned memory infra that names the host when the container's own limit count did not rise, on every plain Node path", () => {
    const pinnedMemory = { seconds: 90, memory: "1g", pinned: { seconds: 60, memory: "256m" } };
    const host = infra(hostKillPinned("256m"));
    expect(pinnedFill(HOST_KILL, pinnedMemory)).toEqual(host);
    expect(caseOutcome(ended({ rise: HOST_KILL }), pinnedMemory)).toEqual(host);
    expect(caseMemory(ended({ rise: HOST_KILL }), false, pinnedMemory)).toEqual(host);
    expect(caseMemory(ended({ signal: null, rise: HOST_KILL }), true, pinnedMemory)).toEqual(host);
    expect(caseMemory(ended({ signal: null, rise: HOST_KILL }), false, pinnedMemory)).toEqual(host);
    expect(hostKillPinned("256m")).toContain("host's out-of-memory killer");
    expect(caseMemory(ended({ rise: kills(1) }), false, pinnedMemory)).toEqual(fail(caseOomPinned("256m")));
    expect(caseMemory(ended({ signal: null, rise: kills(1) }), true, pinnedMemory)).toEqual(fail(caseFilledPinned("256m")));
  });

  it("makes a plain Node case under pinned memory infra when its out-of-memory count cannot be read, whatever it answered", () => {
    expect(pinnedFill(null, { seconds: 90, memory: "1g", pinned: { seconds: 60, memory: "256m" } })).toEqual(infra(OOM_UNREAD_PINNED));
    expect(caseMemory(ended({ signal: null, rise: null }), true, { seconds: 90, memory: "1g", pinned: { seconds: 60, memory: "256m" } })).toEqual(infra(OOM_UNREAD_PINNED));
  });

  it("makes a plain Node launcher's end under pinned memory infra for Docker's flag, which names no process and counts host kills, and for signal 9 without it", () => {
    const launcher = (exitCode: number, oomKilled: boolean) => ({ started: true, exitCode, oomKilled, error: "" });
    for (const code of [137, 1, 0]) {
      expect(pinnedLauncherEnd(launcher(code, true), "256m"), String(code)).toEqual(infra(launcherFlaggedPinned("256m")));
    }
    expect(pinnedLauncherEnd(launcher(137, false), "256m")).toEqual(infra(launcherKilledPinned("256m")));
    expect(pinnedLauncherEnd(launcher(1, false), "256m")).toBeUndefined();
  });

  it("leaves a plain Node case that kills itself, aborts, exits, or is stopped by the judge to its own verdict, whatever the out-of-memory count", () => {
    expect(caseOutcome(ended({ rise: kills(0) }), LIMITS)).toBeUndefined();
    for (const rise of [kills(0), kills(1), null]) {
      for (const signal of ["SIGABRT", "SIGSEGV", "SIGTERM", null]) {
        expect(caseOutcome(ended({ signal, rise }), LIMITS), `${signal} ${JSON.stringify(rise)}`).toBeUndefined();
      }
      expect(caseOutcome(ended({ stoppedByJudge: true, rise }), LIMITS), JSON.stringify(rise)).toBeUndefined();
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
    expect(EXIT_OF).toEqual({ pass: 0, fail: 1, infra: EXIT_RETRY, refused: EXIT_REFUSED });
    expect(() => decided(infra("late") as Ruling)).toThrow(new JudgeInfraError("late"));
    expect(new JudgeInfraError("late").exitCode).toBe(EXIT_RETRY);
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      expect(() => decided({ outcome: "interrupted", signal })).toThrow(JudgeInterrupted);
      expect(new JudgeInterrupted(signal).exitCode).toBe(SIGNAL_EXIT[signal]);
    }
    expect(decided(PASS as Ruling)).toEqual(PASS);
    expect(decided(fail("wrong") as Ruling)).toEqual(fail("wrong"));
  });

  it("gives each ending of a judge run its own exit code, a refusal and an unforeseen error 78, never the 1 of a fail", () => {
    expect(new Set([EXIT_OF.pass, EXIT_OF.fail, EXIT_OF.infra, EXIT_OF.refused]).size).toBe(4);
    expect(exitOfError(new JudgeRefused("no"), true)).toBe(EXIT_REFUSED);
    expect(exitOfError(new JudgeRefused("no"), false)).toBe(EXIT_FAILED);
    expect(exitOfError(new JudgeInfraError("late"), false)).toBe(EXIT_RETRY);
    expect(exitOfError(new JudgeUnreadable("the spec url answered 503"), true)).toBe(EXIT_RETRY);
    expect(exitOfError(new ReleaseUncertain("may have landed"), true)).toBe(EXIT_SENT);
    const limited = new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers(), message: "Too Many Requests", statusCode: 429 });
    expect(exitOfError(new Error("the request failed", { cause: limited }), true)).toBe(EXIT_RETRY);
    expect(exitOfError(new Error("the request failed", { cause: limited }), false)).toBe(EXIT_FAILED);
    const missing = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT", path: "/tmp/judge-spec.md" });
    expect(exitOfError(missing, true, ["judge", "--spec", "/tmp/judge-spec.md"])).toBe(EXIT_USAGE);
    expect(exitOfError(missing, true, ["judge", "--spec=/tmp/judge-spec.md"])).toBe(EXIT_USAGE);
    expect(exitOfError(missing, true, ["judge", "--spec", "/tmp/other.md"])).toBe(EXIT_REFUSED);
    for (const code of ["EACCES", "EPERM", "EROFS", "EISDIR", "ENOTDIR"]) {
      const unwritable = Object.assign(new Error(`${code}: open`), { code, path: "/tmp/judge-verdict.json" });
      expect(exitOfError(unwritable, true, ["judge", "--verdict", "/tmp/judge-verdict.json"]), code).toBe(EXIT_USAGE);
      expect(exitOfError(unwritable, true, ["judge", "--verdict", "/tmp/other.json"]), code).toBe(EXIT_REFUSED);
    }
    expect(exitOfError(new JudgeInfraError("late"), true)).toBe(EXIT_RETRY);
    expect(exitOfError(new JudgeInterrupted("SIGTERM"), true)).toBe(SIGNAL_EXIT.SIGTERM);
    expect(exitOfError(new UsageError("bad"), true)).toBe(EXIT_USAGE);
    expect(exitOfError(new Error("odd"), true)).toBe(EXIT_REFUSED);
    expect(exitOfError(new Error("odd"), false)).toBe(EXIT_FAILED);
  });
});

const INTERNALS = readFileSync(join(ROOT, "docs/maintainers/judge-internals.md"), "utf8");

type Refusal = { outcome: "refused" | "infra"; exit: number };

const refusedBy = (error: unknown): Refusal => {
  const exit = exitOfError(error, true);
  return { outcome: exit === EXIT_RETRY ? "infra" : "refused", exit };
};

const OUTCOME_ROWS: Record<string, Ruling | Refusal> = {
  "`--sandbox docker`: the container started and exited 0, also when Docker flags it out of memory the judge chose": docker(ran(0, { oomKilled: true })),
  "`--sandbox docker`: the container started and exited with any code but 0 and 137, 125 included, and Docker did not flag it out of memory": docker(ran(125)),
  "`--sandbox docker`: the container exited 137, a kill with signal 9, under the memory the judge chose, and Docker did not flag it out of memory": docker(ran(137)),
  "`--sandbox docker`: the container exited with any code but 0 and Docker flags it out of memory the judge chose, so the kernel killed a process of it for memory": docker(ran(1, { oomKilled: true })),
  "`--sandbox docker` under a `judge-run` block: Docker flags the container out of the pinned `memory`, whatever its exit code or how long it ran, a kill by the host's own out-of-memory killer included, which the flag cannot tell apart": containerOutcome(
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
  "`--sandbox docker` under a `judge-run` block: on the judge's own clock the container ended less than the pinned `timeout` after it could have started, and it exited with any other code, 137 or with Docker's out-of-memory flag only when the block pins `memory`": containerOutcome(
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
  "`--plain-node`: a case does not pass while the kernel's out-of-memory kill count for its container rises, under the memory the judge chose": caseMemory(ended({ signal: null, rise: kills(1) }), false, LIMITS) as Ruling,
  "`--plain-node`: a case is killed with signal 9, and the judge cannot read its container's out-of-memory count": caseOutcome(ended({ rise: null }), LIMITS) as Ruling,
  "`--plain-node` under a `judge-cases` block that pins `node_memory`: both the out-of-memory count and the out-of-memory kill count rise while a case runs": pinnedFill(kills(1), {
    ...LIMITS,
    pinned: { seconds: 5, memory: "512m" },
  }) as Ruling,
  "`--plain-node` under a `judge-cases` block that pins `node_memory`: the out-of-memory kill count rises while the out-of-memory count does not, as a kill by the host's own out-of-memory killer gives, or the launcher ends with signal 9 or with Docker's out-of-memory flag, or the counts cannot be read around a case, or a case starts before every process of the case before it ended and the counts rise":
    pinnedFill(HOST_KILL, { ...LIMITS, pinned: { seconds: 5, memory: "512m" } }) as Ruling,
  "`--plain-node`: a case kills itself, aborts, exits or is killed with signal 9 while the out-of-memory kill count stays the same during that case":
    caseMemory(ended({ signal: null, rise: kills(0) }), false, LIMITS) ?? caseMemory(ended({ rise: kills(0) }), false, LIMITS) ?? engineOutcome(ENGINE, { total: 1, passed: 0 }),
  "an engine runs past `--timeout`, or past the MCP tool's own time budget": engineOutcome(ENGINE, { total: 1, passed: 0, stop: stopAt("deadline", 1) }),
  "a case uses twice its budget of CPU time plus the time it waited by its own choice, `HOST_CALL_MS` per host engine call or `NODE_CASE_MS` per plain Node case, or the `case_ms` the spec pins, or uses its budget while other work kept less than `OTHER_BUSY_LIMIT` of the judge's CPUs busy, or it reaches the spec's `steps` or `heap`": engineOutcome(ENGINE, hostTally([{ verdict: "stopped", usedMs: HOST_CALL_MS, otherShare: 0 }], 1, HOST_CALL_MS)),
  "a case answers rightly after using its budget but less than twice it while other work kept at least `OTHER_BUSY_LIMIT` of the judge's CPUs busy": engineOutcome(ENGINE, hostTally([{ verdict: "pass", usedMs: HOST_CALL_MS, otherShare: 1 }], 1, HOST_CALL_MS)),
  "a host engine call or plain Node case is stopped by the engine's wall-clock backstop, `hostBackstopMs` or `nodeBackstopMs`, before it used its budget, or plain Node cannot read a case's CPU time": engineOutcome(ENGINE, hostTally([{ verdict: "stopped", usedMs: HOST_CALL_MS - 1, otherShare: 0 }], 1, HOST_CALL_MS)),
  "`--plain-node` on a host whose containers do not show a cgroup v2 `cpu.stat` or their processes in `/proc`, so a budget could be read only on the wall clock": refusedBy(new JudgeRefused(nodeUnmetered)),
  "a case answers wrongly, throws, answers no primitive, or the module does not load": engineOutcome(ENGINE, { total: 2, passed: 1 }),
  "an engine ends non-zero, writes no readable verdict, answers the wrong number of cases, or reports a fault of its own (`engine`)": engineOutcome(ENGINE, { total: 2, passed: 1, faults: 1 }),
  "every engine that ran answered every case": engineOutcome(ENGINE, { total: 2, passed: 2 }),
  "one engine fails a case while another is infra": combine([infra("late") as Ruling, engineOutcome(ENGINE, { total: 2, passed: 1 })]),
  "the spec, the escrow, a key, the announcement or an option leaves the judge nothing it may judge, so no check runs": refusedBy(new JudgeRefused("the spec has no judge-cases block")),
  "`--plain-node` under a `judge-cases` block that pins `node_memory`, on a host whose containers do not show both out-of-memory counts, or let a case lower its out-of-memory score": refusedBy(new JudgeRefused(memoryUnlocked("512m"))),
  "the check passed, but a check of the release refuses it before it is sent: the second RPC node disagrees, or the Ledger rejects it": refusedBy(new Error("the two RPC nodes report a different genesis hash")),
  "the RPC node rate-limits, answers a server error other than 501 or 505, drops the connection or does not answer in time during a `judge` run, or the spec url cannot be read for now": refusedBy(new Error("the request failed", { cause: new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers(), message: "Service Unavailable", statusCode: 503 }) })),
  "an error the judge did not foresee stops a `judge` run before any release was sent": refusedBy(new Error("the node answered something the judge cannot read")),
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
      const ruling = OUTCOME_ROWS[what] as Ruling | Refusal;
      const expected = ruling.outcome === "interrupted" ? ["none", "130 or 143", "no"] : [ruling.outcome, String(EXIT_OF[ruling.outcome]), ruling.outcome === "pass" ? "yes" : "no"];
      expect([outcome, exit, signs], what).toEqual(expected);
      expect(("exit" in ruling ? ruling.exit : exitOf(ruling)) === Number(exit) || ruling.outcome === "interrupted", what).toBe(true);
    }
  });
});
