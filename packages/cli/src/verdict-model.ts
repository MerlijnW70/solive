import { EXIT_RETRY, type InterruptSignal, JudgeInfraError, JudgeInterrupted, oomInfra, timedOutInfra } from "./judge-errors.js";

export type Outcome = { outcome: "pass" } | { outcome: "fail"; reason: string } | { outcome: "infra"; reason: string };

export type Ruling = Outcome | { outcome: "interrupted"; signal: InterruptSignal };

export const EXIT_OF = { pass: 0, fail: 1, infra: EXIT_RETRY } as const;

export const exitOfVerdict = (verdict: unknown): number => (verdict === "pass" ? EXIT_OF.pass : EXIT_OF.fail);

export type ContainerState = { started: boolean; exitCode: number; oomKilled: boolean; error: string };

export type ContainerFacts = { interrupted?: InterruptSignal; deadline: boolean; state: ContainerState | null; problem?: string; inspect?: string; overran?: boolean; ranAtMostMs?: number };

export type ShellFacts = { interrupted?: InterruptSignal; deadline: boolean; exitCode: number | null; signal?: string; problem?: string };

export type Stop = { cause: "deadline" | "fault"; reason: string; unfinished: number };

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

export const ranPastPin = (seconds: number): string => `the check was still running at the ${seconds} second timeout the spec's judge-run block pins`;

export const oomPinned = (memory: string): string => `the check's container was killed for using all of the ${memory} memory the spec's judge-run block pins`;

export const KILLED_EXIT = 137;

export const killedUnflagged = (memory: string): string =>
  `the check's container ended with exit code ${KILLED_EXIT}, a kill with signal 9, under the ${memory} memory the judge chose, and Docker did not flag it out of memory; Docker can miss that flag when the kernel kills for memory, so this is no verdict on the work; raise --sandbox-memory, or pin memory in a judge-run block, to judge it`;

export const RUN_UNTIMED =
  "the check's container ended, but on the judge's own clock it may have run for the spec's pinned timeout, so whether it kept to it is unknown";

export type CaseEnd = { signal: string | null; stoppedByJudge: boolean; oomKills: number | null };

export const caseOomInfra = (memory: string): string =>
  `a plain Node case was killed with signal 9 while the kernel counted an out-of-memory kill in its container, under the ${memory} memory the judge chose; raise --sandbox-memory if the work needs more`;

export const caseOomPinned = (memory: string): string => `a plain Node case was killed for using all of the ${memory} memory the spec pins`;

export const OOM_UNREAD = "a plain Node case was killed with signal 9, and the judge could not read its container's out-of-memory count, so whether memory killed it is unknown";

const killedForMemory = (limits: Limits, chosen: (memory: string) => string, pins: (memory: string) => string): Outcome => {
  const memory = limits.pinned?.memory;
  return memory === undefined ? infra(chosen(limits.memory)) : fail(pins(memory));
};

export function caseOutcome(end: CaseEnd, limits: Limits): Outcome | undefined {
  if (end.signal !== "SIGKILL" || end.stoppedByJudge) {
    return undefined;
  }
  if (end.oomKills === null) {
    return infra(OOM_UNREAD);
  }
  return end.oomKills > 0 ? killedForMemory(limits, caseOomInfra, caseOomPinned) : undefined;
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
    return infra(timedOutInfra(limits.seconds));
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
  if (state.oomKilled) {
    return killedForMemory(limits, oomInfra, oomPinned);
  }
  if (state.exitCode === KILLED_EXIT && pinned?.memory === undefined) {
    return infra(killedUnflagged(limits.memory));
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
