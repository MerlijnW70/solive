import { manifestSha256 } from "@intent-engine/core/internal";
import type { CheckFiles } from "./artifact.js";
import { MAX_JUDGE_TIMEOUT } from "./command-builders.js";
import { JudgeRefused } from "./judge-errors.js";
import { cpusValid, DOCKER_ASK_SECONDS, imageValid, megabytesOf, memoryValid } from "./sandbox.js";
import { ambiguous, blockFields, fenceMentions, readBlocks, specText, strayFence } from "./spec-blocks.js";
import { CASES_FENCE, nodeMemoryRead, utf8Exact } from "./viper.js";

export const RUN_FENCE = "judge-run";
export const RUN_OVERHEAD_SECONDS = DOCKER_ASK_SECONDS;
export const MAX_PINNED_TIMEOUT = MAX_JUDGE_TIMEOUT - RUN_OVERHEAD_SECONDS;
export const MIN_PINNED_MEGABYTES = 6;
export const MAX_RUN_BYTES = 16_384;
export const RUN_FIELDS = ["image", "run", "timeout", "check_sha256", "memory", "cpus"] as const;

export type PinnedRun = { image: string; run: string; timeout: number; checkSha256?: string; memory?: string; cpus?: string };

const SHA256 = /^[0-9a-f]{64}$/;
const SHOWN = 80;

const shown = (value: unknown): string => (JSON.stringify(value) ?? String(value)).slice(0, SHOWN);

export class RunBlockRefused extends JudgeRefused {
  constructor(readonly why: string) {
    super(`${why}; nothing was run or paid`);
    this.name = "RunBlockRefused";
  }
}

export const blockRefused = (why: string): never => {
  throw new RunBlockRefused(`the spec's ${RUN_FENCE} block ${why}`);
};

const specRefused = (why: string): never => {
  throw new RunBlockRefused(`the spec ${why}`);
};

export const NOT_UTF8 = `has a ${RUN_FENCE} block but is not valid UTF-8, so readers could see its fields differently`;

export const ODD_LINE_ENDS = `has a ${RUN_FENCE} block and a line that ends in a lone carriage return, U+2028 or U+2029, which Markdown and the judge would split differently`;

const ODD_ENDS = /\r(?!\n)|[\u2028\u2029]/;

export const BOTH_BLOCKS = `has both a ${RUN_FENCE} and a ${CASES_FENCE} block; a spec pins one check`;

export const manyBlocks = (count: number): string => `has ${count} ${RUN_FENCE} blocks; it may have one`;

export const IMAGE_RULE = "an image named by its digest, <name>@sha256:<64 lowercase hex>";

export const TIMEOUT_RULE = `a whole number of seconds from 1 to ${MAX_PINNED_TIMEOUT}`;

export const MEMORY_RULE = `a string of whole megabytes or gigabytes, such as "512m" or "2g", of at least ${MIN_PINNED_MEGABYTES}m, which Docker needs`;

export const CPUS_RULE = 'a string of CPUs above 0 with at most two decimals, such as "1" or "1.5"';

export const RUN_RULE = `a command of 1 to ${MAX_RUN_BYTES} bytes, with no NUL character and no lone surrogate`;

const fieldRefused = (name: string, value: unknown, rule: string): never =>
  blockRefused(value === undefined ? `has no ${name}, which must be ${rule}` : `has ${name} ${shown(value)}, which is not ${rule}`);

function utf8(spec: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(spec);
    return true;
  } catch {
    return false;
  }
}

function runOf(value: unknown): string {
  const fits = typeof value === "string" && value.trim() !== "" && Buffer.byteLength(value) <= MAX_RUN_BYTES && !value.includes("\0") && utf8Exact(value);
  return fits ? value : fieldRefused("run", value, RUN_RULE);
}

function timeoutOf(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_PINNED_TIMEOUT ? value : fieldRefused("timeout", value, TIMEOUT_RULE);
}

function optionalOf(fields: Record<string, unknown>, name: string, fits: (value: string) => boolean, rule: string): string | undefined {
  const value = fields[name];
  if (!(name in fields)) {
    return undefined;
  }
  return typeof value === "string" && fits(value) ? value : fieldRefused(name, value, rule);
}

export function pinnedRunOf(spec: Uint8Array): PinnedRun | undefined {
  const text = specText(spec);
  const read = readBlocks(text, RUN_FENCE);
  if (read.mentions === 0) {
    const cases = readBlocks(text, CASES_FENCE);
    return cases.mentions > 0 && ambiguous(cases) ? specRefused(strayFence(CASES_FENCE, cases.mentions, cases.plain)) : undefined;
  }
  if (!utf8(spec)) {
    return specRefused(NOT_UTF8);
  }
  if (ODD_ENDS.test(text)) {
    return specRefused(ODD_LINE_ENDS);
  }
  const blocks = read.bodies;
  if (ambiguous(read)) {
    return specRefused(strayFence(RUN_FENCE, read.mentions, read.plain));
  }
  if (blocks.length > 1) {
    return specRefused(manyBlocks(blocks.length));
  }
  if (fenceMentions(text, CASES_FENCE) > 0) {
    return specRefused(BOTH_BLOCKS);
  }
  const fields = blockFields(blocks[0] ?? "", RUN_FIELDS, blockRefused, true);
  const image = typeof fields["image"] === "string" && imageValid(fields["image"]) ? fields["image"] : fieldRefused("image", fields["image"], IMAGE_RULE);
  const run = runOf(fields["run"]);
  const timeout = timeoutOf(fields["timeout"]);
  const checkSha256 = optionalOf(fields, "check_sha256", (value) => SHA256.test(value), "a sha256 of 64 lowercase hex");
  const memory = optionalOf(fields, "memory", (value) => memoryValid(value) && megabytesOf(value) >= MIN_PINNED_MEGABYTES, MEMORY_RULE);
  const cpus = optionalOf(fields, "cpus", cpusValid, CPUS_RULE);
  return {
    image,
    run,
    timeout,
    ...(checkSha256 === undefined ? {} : { checkSha256 }),
    ...(memory === undefined ? {} : { memory }),
    ...(cpus === undefined ? {} : { cpus }),
  };
}

export const checkFilesSha256 = (files: CheckFiles): Promise<string> =>
  manifestSha256(files.read.entries.map((entry) => ({ path: files.read.single ? files.name : `${files.name}/${entry.path}`, bytes: entry.bytes })));

export type ShownRun = { image: string; run: string; timeout: number; memory: string | null; cpus: string | null; check_files_pinned: boolean; check_sha256: string | null };

export const shownRun = (pinned: PinnedRun): ShownRun => ({
  image: pinned.image,
  run: pinned.run,
  timeout: pinned.timeout,
  memory: pinned.memory ?? null,
  cpus: pinned.cpus ?? null,
  check_files_pinned: pinned.checkSha256 !== undefined,
  check_sha256: pinned.checkSha256 ?? null,
});

export function runProblem(spec: Uint8Array): string | undefined {
  try {
    pinnedRunOf(spec);
  } catch (error) {
    if (error instanceof RunBlockRefused) {
      return error.why;
    }
    throw error;
  }
  return nodeMemoryRead(spec).problem;
}

export type RunRead = { judge_run?: ShownRun; judge_run_refused?: string; node_memory?: string };

export function runRead(spec: Uint8Array): RunRead {
  const problem = runProblem(spec);
  if (problem !== undefined) {
    return { judge_run_refused: problem };
  }
  const pinned = pinnedRunOf(spec);
  const { memory } = nodeMemoryRead(spec);
  return { ...(pinned === undefined ? {} : { judge_run: shownRun(pinned) }), ...(memory === undefined ? {} : { node_memory: memory }) };
}
