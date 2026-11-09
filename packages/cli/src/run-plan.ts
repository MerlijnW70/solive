import { basename, resolve } from "node:path";
import { type Artifact, type CheckFiles, copyOf, readArtifact, removeCopy } from "./artifact.js";
import { type Check, checkEnv, type HeldSignals, runCheck, runContainer } from "./check-process.js";
import type { Command } from "./command-types.js";
import { JudgeRefused } from "./judge-errors.js";
import { RUN_OPTIONS } from "./job-args.js";
import { checkFilesSha256, type PinnedRun, pinnedRunOf, RUN_FENCE, RUN_OVERHEAD_SECONDS } from "./judge-run.js";
import { containerArgs, containerName, dockerEnv, megabytesOf, NO_SANDBOX, type Sandbox, SANDBOX_CPUS, SANDBOX_MEMORY, SANDBOX_TMP, shareable } from "./sandbox.js";
import { containerOutcome, type Limits, type Ruling, shellOutcome } from "./verdict-model.js";
import { CASES_FENCE, casePinsRead, NODE_CPUS, NODE_MEMORY } from "./viper.js";

type JudgeCommand = Extract<Command, { name: "judge" }>;

export type Plan = { sandbox: Sandbox; run: string | undefined; timeout: number; pinned?: PinnedRun };

const EVERY_OPTION: readonly string[] = RUN_OPTIONS;

const EXECUTABLE = 0o111;

export const optionRefused = (option: string, why: string): never => {
  throw new JudgeRefused(`${option} ${why}; nothing was run or paid`);
};

const pins = (what: string): string => `the spec's ${RUN_FENCE} block pins ${what}`;

export const NOT_DOCKER = `is refused: ${pins("a Docker check")}, so it is judged with --sandbox docker`;

export const differs = (given: string, pinned: string, what: string): string => `${JSON.stringify(given)} is refused: ${pins(`${what} ${JSON.stringify(pinned)}`)}`;

export const unpinned = (given: string, fixed: string, what: string): string =>
  `${JSON.stringify(given)} is refused: ${pins("a check")} that leaves ${what} at the judge's default ${JSON.stringify(fixed)}, so it runs with exactly that`;

export const GPU_REFUSED = `is refused: ${pins("a check")} with no GPU`;

export const timeoutShort = (given: number, pinned: number): string =>
  `${given} is refused: ${pins(`a ${pinned} second timeout`)}, and the judge needs that plus its own ${RUN_OVERHEAD_SECONDS} seconds to start the container, so at least ${pinned + RUN_OVERHEAD_SECONDS}`;

export const checkNeeded = (sha256: string): string => `is needed: ${pins(`hidden check files with check_sha256 ${sha256}`)}`;

export const checkEmpty = (path: string): string => `${path} is a directory that holds no file, so check_sha256 cannot fix what the check sees under /judge/check`;

export const CHECK_UNPINNED = `is refused: ${pins("a check")} with no hidden check files`;

export const checkDiffers = (path: string, sha256: string, pinned: string): string => `${path} has check_sha256 ${sha256}, but ${pins(pinned)}`;

export const nodeMemoryDiffers = (given: string, pinned: string): string =>
  `${JSON.stringify(given)} is refused: the spec's ${CASES_FENCE} block pins ${NODE_MEMORY} ${JSON.stringify(pinned)}, the memory plain Node cases run under`;

export const nodeCpusDiffers = (given: string, pinned: string): string =>
  `${JSON.stringify(given)} is refused: the spec's ${CASES_FENCE} block pins ${NODE_CPUS} ${JSON.stringify(pinned)}, the CPUs plain Node cases run under`;

function nodePlan(spec: Uint8Array, command: JudgeCommand): Plan {
  const { sandbox } = command;
  const unpinned = { sandbox, run: command.run, timeout: command.timeout };
  if (sandbox.kind !== "viper" || sandbox.node === undefined) {
    return unpinned;
  }
  const read = casePinsRead(spec);
  if (read.problem !== undefined) {
    throw new JudgeRefused(`${read.problem}; nothing was run or paid`);
  }
  const { nodeMemory: memory, nodeCpus: cpus } = read.pins;
  const given = new Set<string>(command.given ?? EVERY_OPTION);
  if (memory !== undefined && given.has("sandbox-memory") && megabytesOf(sandbox.node.memory) !== megabytesOf(memory)) {
    return optionRefused("--sandbox-memory", nodeMemoryDiffers(sandbox.node.memory, memory));
  }
  if (cpus !== undefined && given.has("sandbox-cpus") && Number(sandbox.node.cpus) !== Number(cpus)) {
    return optionRefused("--sandbox-cpus", nodeCpusDiffers(sandbox.node.cpus, cpus));
  }
  if (memory === undefined && cpus === undefined) {
    return unpinned;
  }
  return { ...unpinned, sandbox: { kind: "viper", node: { ...sandbox.node, ...(memory === undefined ? {} : { memory }), ...(cpus === undefined ? {} : { cpus }) } } };
}

export function runPlan(spec: Uint8Array, command: JudgeCommand): Plan {
  const pinned = pinnedRunOf(spec);
  const { sandbox } = command;
  if (pinned === undefined) {
    return nodePlan(spec, command);
  }
  const given = new Set<string>(command.given ?? EVERY_OPTION);
  if (sandbox.kind !== "docker") {
    return optionRefused(`--sandbox ${sandbox.kind}`, NOT_DOCKER);
  }
  if (command.run !== pinned.run) {
    return optionRefused("--run", differs(command.run ?? "", pinned.run, "the run"));
  }
  const memory = pinned.memory ?? SANDBOX_MEMORY;
  const cpus = pinned.cpus ?? SANDBOX_CPUS;
  if (given.has("sandbox-image") && sandbox.image !== pinned.image) {
    return optionRefused("--sandbox-image", differs(sandbox.image, pinned.image, "the image"));
  }
  if (given.has("sandbox-memory") && megabytesOf(sandbox.memory) !== megabytesOf(memory)) {
    return optionRefused("--sandbox-memory", pinned.memory === undefined ? unpinned(sandbox.memory, memory, "memory") : differs(sandbox.memory, memory, "the memory"));
  }
  if (given.has("sandbox-cpus") && Number(sandbox.cpus) !== Number(cpus)) {
    return optionRefused("--sandbox-cpus", pinned.cpus === undefined ? unpinned(sandbox.cpus, cpus, "the CPUs") : differs(sandbox.cpus, cpus, "the CPUs"));
  }
  if (given.has("sandbox-tmp") && megabytesOf(sandbox.tmp) !== megabytesOf(SANDBOX_TMP)) {
    return optionRefused("--sandbox-tmp", unpinned(sandbox.tmp, SANDBOX_TMP, "/tmp"));
  }
  if (sandbox.gpu) {
    return optionRefused("--sandbox-gpu", GPU_REFUSED);
  }
  const least = pinned.timeout + RUN_OVERHEAD_SECONDS;
  if (given.has("timeout") && command.timeout < least) {
    return optionRefused("--timeout", timeoutShort(command.timeout, pinned.timeout));
  }
  return {
    sandbox: { kind: "docker", image: pinned.image, memory, cpus, tmp: SANDBOX_TMP, gpu: false },
    run: pinned.run,
    timeout: given.has("timeout") ? command.timeout : least,
    pinned,
  };
}

export async function checkFilesOf(check: string | undefined, plan: Plan): Promise<CheckFiles | undefined> {
  const pinned = plan.pinned?.checkSha256;
  if (check === undefined) {
    return pinned === undefined ? undefined : optionRefused("--check", checkNeeded(pinned));
  }
  if (plan.pinned !== undefined && pinned === undefined) {
    return optionRefused("--check", CHECK_UNPINNED);
  }
  const files = { name: basename(resolve(check)), read: await readArtifact(resolve(check)) };
  if (pinned === undefined) {
    return files;
  }
  if (files.read.entries.length === 0) {
    return optionRefused("--check", checkEmpty(check));
  }
  const sha256 = await checkFilesSha256(files);
  if (sha256 !== pinned) {
    return optionRefused("--check", checkDiffers(check, sha256, `check_sha256 ${pinned}`));
  }
  return { name: files.name, read: { ...files.read, entries: files.read.entries.map((entry) => ({ ...entry, executable: EXECUTABLE })) } };
}

export const limitsOf = (plan: Plan): Limits => ({
  seconds: plan.timeout,
  memory: plan.sandbox.kind === "docker" ? plan.sandbox.memory : "allowed",
  ...(plan.pinned === undefined ? {} : { pinned: { seconds: plan.pinned.timeout, memory: plan.pinned.memory } }),
});

export type Ran = { check: Check; ruled: Ruling | undefined; cleanup: string | undefined };

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function runPlanned(plan: Plan, read: Artifact, specBytes: Uint8Array, checkFiles: CheckFiles | undefined, sha256: string, signals: HeldSignals): Promise<Ran> {
  const { sandbox } = plan;
  const limits = limitsOf(plan);
  const copy = await copyOf(read, specBytes, checkFiles, sandbox.kind === "docker");
  const run = plan.run ?? "";
  const unstarted = (error: unknown) => ({ exitCode: null, timedOut: false, deadline: false, state: null, problem: reasonOf(error) });
  let check: Check = { exitCode: null, timedOut: false };
  let ruled: Ruling | undefined;
  let cleanup: string | undefined;
  try {
    if (signals.caught() === undefined) {
      if (sandbox.kind === "docker") {
        await shareable(copy.root);
        const ran = await runContainer(containerArgs(sandbox, copy, sha256, run), containerName(), dockerEnv(process.env), plan.timeout, undefined, plan.pinned?.timeout).catch(unstarted);
        check = ran;
        ruled = containerOutcome(ran, limits);
      } else {
        const ran = await runCheck(run, checkEnv(process.env, copy.spec, copy.path, sha256), plan.timeout, { cwd: copy.root }).catch(unstarted);
        process.stderr.write(`${NO_SANDBOX}\n`);
        check = ran;
        ruled = shellOutcome({ ...ran, deadline: ran.timedOut }, limits);
      }
    }
  } finally {
    cleanup = await removeCopy(copy.root);
  }
  return { check, ruled, cleanup };
}
