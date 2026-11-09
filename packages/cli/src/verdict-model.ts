import { EXIT_REFUSED, EXIT_RETRY, type InterruptSignal, JudgeInfraError, JudgeInterrupted, oomInfra, oomInfraUnpinned, timedOutInfra } from "./judge-errors.js";

export type Outcome = { outcome: "pass" } | { outcome: "fail"; reason: string } | { outcome: "infra"; reason: string };

export type Ruling = Outcome | { outcome: "interrupted"; signal: InterruptSignal };

export const EXIT_OF = { pass: 0, fail: 1, infra: EXIT_RETRY, refused: EXIT_REFUSED } as const;

export const exitOfVerdict = (verdict: unknown): number => (verdict === "pass" ? EXIT_OF.pass : EXIT_OF.fail);

export type ContainerState = { started: boolean; exitCode: number; oomKilled: boolean; error: string };

export type ContainerFacts = { interrupted?: InterruptSignal; deadline: boolean; state: ContainerState | null; problem?: string; inspect?: string; overran?: boolean; ranAtMostMs?: number };

export type ShellFacts = { interrupted?: InterruptSignal; deadline: boolean; exitCode: number | null; signal?: string; problem?: string };

export type Stop = { cause: "deadline" | "fault" | "failed"; reason: string; unfinished: number };

export type Tally = { total: number; passed: number; faults?: number; stop?: Stop };

export type Pins = { seconds: number; memory?: string | undefined };

export type Limits = { seconds: number; memory: string; pinned?: Pins | undefined };

export const ENGINE_FAULT = "engine";

export class EngineStopped extends Error {
  constructor(readonly stop: Stop) {
    super(stop.reason);
    this.name = "EngineStopped";
  }
}

export const faultOf = (reason: string, unfinished: number): Stop => ({ cause: "fault", reason, unfinished });

export const deadlineOf = (reason: string, unfinished: number): Stop => ({ cause: "deadline", reason, unfinished });

export const failedOf = (reason: string, unfinished: number): Stop => ({ cause: "failed", reason, unfinished });

export type CaseClock = { started: boolean; usedMs: number; idleMs: number; ioMs: number; otherShare: number; stoppedBy: "budget" | "backstop" | null };

export const CONTENTION_FACTOR = 2;

export const OTHER_BUSY_LIMIT = 0.25;

export const chargedMs = (clock: CaseClock, budgetMs: number): number => clock.usedMs + clock.idleMs + Math.max(0, clock.ioMs - budgetMs);

export type Timing = "within" | "band" | "over" | "starved";

export const ranPastBudget = (budgetMs: number): string => `the case used its ${budgetMs} ms budget of CPU time and of time it spent waiting by its own choice`;

export const starvedCase = (engine: string, budgetMs: number, backstopMs: number): string =>
  `${engine} stopped a case at its ${backstopMs} ms wall-clock backstop before the case had used its ${budgetMs} ms budget of CPU time and of time it spent waiting by its own choice, so the judge's machine kept it from the CPU, and this is no verdict on the work`;

export const contendedCase = (engine: string, budgetMs: number, otherShare: number): string =>
  `${engine} charged a case that answered rightly past its ${budgetMs} ms budget while other work kept ${Math.round(otherShare * 100)}% of the judge's CPUs busy, which slows the CPU time a case is charged, so this is no verdict on the work`;

export function caseTiming(clock: CaseClock, budgetMs: number): Timing {
  const charged = chargedMs(clock, budgetMs);
  if (clock.started && charged >= budgetMs * CONTENTION_FACTOR) {
    return "over";
  }
  if (clock.started && charged >= budgetMs) {
    return clock.otherShare >= OTHER_BUSY_LIMIT ? "band" : "over";
  }
  return clock.stoppedBy === null ? "within" : "starved";
}

const PASS: Outcome = { outcome: "pass" };

const fail = (reason: string): Outcome => ({ outcome: "fail", reason });

const infra = (reason: string): Outcome => ({ outcome: "infra", reason });

export const notStarted = (what: string, problem: string): string => `${what} could not start the check (${problem})`;

export const inspectFailed = (problem: string): string => `docker could not report how the check's container ended (${problem || "no answer"}), so its exit code cannot be trusted`;

export const NEVER_STARTED = "docker created the check's container but never started it";

export const startFailed = (code: number, error: string): string =>
  `docker could not start the check's container (exit ${code}${error === "" ? "" : `: ${error.slice(0, 300)}`})`;

export const exitedWith = (code: number): string => `the check exited with code ${code}`;

export const endedBy = (signal: string): string => `the check was ended by ${signal}, not by the judge`;

export const engineFaults = (engine: string, count: number): string =>
  `${engine} reported a fault of its own in ${count} case${count === 1 ? "" : "s"}, which a delivery cannot cause`;

export const failedCases = (engine: string, failed: number, total: number): string => `the work failed ${failed} of ${total} cases in ${engine}`;

export const nothingJudged = (engine: string): string => `${engine} judged no case`;

export const NO_RULING = "no engine or check ran";

export const stoppedBeforePin = (seconds: number, pinned: number): string =>
  `the check was stopped at the judge's ${seconds} second deadline before it had run the ${pinned} second timeout the spec's judge-run block pins, so it was removed`;

export const ranPastPin = (seconds: number): string => `the check was still running at the ${seconds} second timeout the spec's judge-run block pins`;

export const oomPinned = (memory: string): string => `the check's container was killed for using all of the ${memory} memory the spec's judge-run block pins`;

export const KILLED_EXIT = 137;

export const killedUnflagged = (memory: string): string =>
  `the check's container ended with exit code ${KILLED_EXIT}, a kill with signal 9, under the ${memory} memory the judge chose, and Docker did not flag it out of memory; Docker can miss that flag when the kernel kills for memory, so this is no verdict on the work; raise --sandbox-memory, or pin memory in a judge-run block, to judge it`;

export const killedUnflaggedUnpinned = (memory: string): string =>
  `the check's container ended with exit code ${KILLED_EXIT}, a kill with signal 9, under ${memory} of memory, and Docker did not flag it out of memory; Docker can miss that flag when the kernel kills for memory, so this is no verdict on the work; the spec's judge-run block pins no memory, so ${memory} is the judge's default and a different --sandbox-memory is refused: it can be judged with more only after the spec's author pins memory in that block`;

export const launcherKilledPinned = (memory: string): string =>
  `the plain Node launcher was killed with signal 9 under the ${memory} memory the spec pins, and Docker did not flag its container out of memory; no case can signal the launcher or the container's init, so the kill came from outside the judgement, such as a user-space out-of-memory killer, docker kill or an operator, or Docker missed the flag, and this is no verdict on the work`;

export const oomExited = (code: number, memory: string): string =>
  `Docker flagged the check's container out of the ${memory} memory the judge chose, so the kernel killed a process of it for memory, and the check then exited with code ${code}; this is no verdict on the work; raise --sandbox-memory if the check needs more`;

export const oomExitedUnpinned = (code: number, memory: string): string =>
  `Docker flagged the check's container out of ${memory} of memory, so the kernel killed a process of it for memory, and the check then exited with code ${code}; this is no verdict on the work; the spec's judge-run block pins no memory, so ${memory} is the judge's default and a different --sandbox-memory is refused: the check gets more only if the spec's author pins memory in that block`;

function chosenMemoryEnd(state: ContainerState, memory: string, inBlock: boolean): string {
  if (!state.oomKilled) {
    return (inBlock ? killedUnflaggedUnpinned : killedUnflagged)(memory);
  }
  if (state.exitCode === KILLED_EXIT) {
    return (inBlock ? oomInfraUnpinned : oomInfra)(memory);
  }
  return (inBlock ? oomExitedUnpinned : oomExited)(state.exitCode, memory);
}

export const RUN_UNTIMED =
  "the check's container ended, but on the judge's own clock it may have run for the spec's pinned timeout, so whether it kept to it is unknown";

export type MemoryRise = { oom: number; oomKill: number; groupKill?: number };

export type CaseEnd = { signal: string | null; stoppedByJudge: boolean; rise: MemoryRise | null };

export const caseOomInfra = (memory: string): string =>
  `a plain Node case was killed with signal 9 while the kernel counted an out-of-memory kill in its container, under the ${memory} memory the judge chose; raise --sandbox-memory if the work needs more`;

export const caseOomPinned = (memory: string): string => `a plain Node case was killed for using all of the ${memory} memory the spec pins`;

export const OOM_UNREAD = "a plain Node case was killed with signal 9, and the judge could not read its container's out-of-memory count, so whether memory killed it is unknown";

export const caseFilledChosen = (memory: string): string =>
  `a plain Node case did not pass after the kernel killed a process of it for memory, under the ${memory} memory the judge chose, so this is no verdict on the work; raise --sandbox-memory if the work needs more`;

export const hostKillPinned = (memory: string): string =>
  `the kernel killed a process of a plain Node case for memory under the ${memory} memory the spec pins, but the container's own limit was not reached while the case ran, so the kill may have come from the host's out-of-memory killer, and this is no verdict on the work`;

export function caseOutcome(end: CaseEnd, limits: Limits): Outcome | undefined {
  if (end.signal !== "SIGKILL" || end.stoppedByJudge) {
    return undefined;
  }
  if (end.rise === null) {
    return infra(OOM_UNREAD);
  }
  if (end.rise.oomKill <= 0) {
    return undefined;
  }
  const memory = limits.pinned?.memory;
  if (memory === undefined) {
    return infra(caseOomInfra(limits.memory));
  }
  return end.rise.oom > 0 ? fail(caseOomPinned(memory)) : infra(hostKillPinned(memory));
}

export const OOM_UNREAD_PINNED = "the judge could not read the out-of-memory count around a plain Node case under the memory the spec pins, so whether memory killed a process of it is unknown";

export const caseFilledPinned = (memory: string): string => `a plain Node case filled the ${memory} memory the spec pins, and the kernel killed a process of it for memory`;

export function pinnedFill(rise: MemoryRise | null, limits: Limits): Outcome | undefined {
  const memory = limits.pinned?.memory;
  if (memory === undefined) {
    return undefined;
  }
  if (rise === null) {
    return infra(OOM_UNREAD_PINNED);
  }
  if (rise.oomKill <= 0) {
    return undefined;
  }
  return rise.oom > 0 ? fail(caseFilledPinned(memory)) : infra(hostKillPinned(memory));
}

export function chosenFill(rise: MemoryRise | null, limits: Limits): Outcome | undefined {
  if (limits.pinned?.memory !== undefined || rise === null || rise.oomKill <= 0) {
    return undefined;
  }
  return infra(caseFilledChosen(limits.memory));
}

export function caseMemory(end: CaseEnd, passed: boolean, limits: Limits): Outcome | undefined {
  if (!passed && end.signal === "SIGKILL" && !end.stoppedByJudge && (end.rise?.groupKill ?? 0) <= 0) {
    return caseOutcome(end, limits);
  }
  return pinnedFill(end.rise, limits) ?? (passed ? undefined : chosenFill(end.rise, limits));
}

export const caseUnsettled = (memory: string): string =>
  `a plain Node case started before every process of the case before it had ended, so a memory kill while it ran under the ${memory} memory the spec pins may belong to that earlier case, and it is no verdict on the work`;

export const launcherFlaggedPinned = (memory: string): string =>
  `the plain Node launcher ended under the ${memory} memory the spec pins, and Docker flagged its container out of memory; the flag names no process and rises for the host's out-of-memory killer too, and the kernel picks a case's process before the launcher, so this is no verdict on the work`;

export function pinnedLauncherEnd(state: ContainerState, memory: string): Outcome | undefined {
  if (state.oomKilled) {
    return infra(launcherFlaggedPinned(memory));
  }
  return state.exitCode === KILLED_EXIT ? infra(launcherKilledPinned(memory)) : undefined;
}

export function containerOutcome(facts: ContainerFacts, limits: Limits): Ruling {
  if (facts.interrupted !== undefined) {
    return { outcome: "interrupted", signal: facts.interrupted };
  }
  const pinned = limits.pinned;
  if (pinned !== undefined && facts.overran === true) {
    return fail(ranPastPin(pinned.seconds));
  }
  if (facts.deadline) {
    return infra(pinned === undefined ? timedOutInfra(limits.seconds) : stoppedBeforePin(limits.seconds, pinned.seconds));
  }
  if (facts.problem !== undefined) {
    return infra(notStarted("docker", facts.problem));
  }
  const { state } = facts;
  if (state === null) {
    return infra(inspectFailed(facts.inspect ?? ""));
  }
  if (state.error !== "") {
    return infra(startFailed(state.exitCode, state.error));
  }
  if (!state.started) {
    return infra(NEVER_STARTED);
  }
  const memory = pinned?.memory;
  if (state.oomKilled && memory !== undefined) {
    return fail(oomPinned(memory));
  }
  if (memory === undefined && state.exitCode !== 0 && (state.oomKilled || state.exitCode === KILLED_EXIT)) {
    return infra(chosenMemoryEnd(state, limits.memory, pinned !== undefined));
  }
  if (pinned !== undefined && !(facts.ranAtMostMs !== undefined && facts.ranAtMostMs < pinned.seconds * 1000)) {
    return infra(RUN_UNTIMED);
  }
  return state.exitCode === 0 ? PASS : fail(exitedWith(state.exitCode));
}

export function shellOutcome(facts: ShellFacts, limits: Limits): Ruling {
  if (facts.interrupted !== undefined) {
    return { outcome: "interrupted", signal: facts.interrupted };
  }
  if (facts.deadline) {
    return infra(timedOutInfra(limits.seconds));
  }
  if (facts.problem !== undefined) {
    return infra(notStarted("the shell", facts.problem));
  }
  if (facts.exitCode === 0) {
    return PASS;
  }
  return fail(facts.exitCode === null ? endedBy(facts.signal ?? "a signal") : exitedWith(facts.exitCode));
}

export function engineOutcome(engine: string, tally: Tally | undefined): Outcome {
  if (tally === undefined || tally.total <= 0) {
    return infra(nothingJudged(engine));
  }
  const faults = tally.faults ?? 0;
  const unfinished = tally.stop?.unfinished ?? 0;
  const failed = tally.total - tally.passed - faults - unfinished;
  if (failed > 0) {
    return fail(failedCases(engine, failed, tally.total));
  }
  if (tally.stop !== undefined) {
    return infra(tally.stop.reason);
  }
  if (faults > 0) {
    return infra(engineFaults(engine, faults));
  }
  return tally.passed === tally.total ? PASS : infra(nothingJudged(engine));
}

export function combine(rulings: readonly Ruling[]): Ruling {
  const interrupted = rulings.find((ruling) => ruling.outcome === "interrupted");
  if (interrupted !== undefined) {
    return interrupted;
  }
  const failed = rulings.find((ruling) => ruling.outcome === "fail");
  if (failed !== undefined) {
    return failed;
  }
  const stalled = rulings.find((ruling) => ruling.outcome === "infra");
  if (stalled !== undefined) {
    return stalled;
  }
  return rulings.length === 0 ? infra(NO_RULING) : PASS;
}

export function decided(ruling: Ruling): Exclude<Outcome, { outcome: "infra" }> {
  if (ruling.outcome === "interrupted") {
    throw new JudgeInterrupted(ruling.signal);
  }
  if (ruling.outcome === "infra") {
    throw new JudgeInfraError(ruling.reason);
  }
  return ruling;
}
