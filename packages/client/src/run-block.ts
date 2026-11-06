import { ambiguous, blockFields, fenceMentions, readBlocks, specText, strayFence } from "./spec-blocks.js";

export const RUN_FENCE = "judge-run";
export const CASES_FENCE = "judge-cases";
export const DOCKER_ASK_SECONDS = 30;
export const MAX_JUDGE_TIMEOUT = 86_400;
export const RUN_OVERHEAD_SECONDS = DOCKER_ASK_SECONDS;
export const MAX_PINNED_TIMEOUT = MAX_JUDGE_TIMEOUT - RUN_OVERHEAD_SECONDS;
export const MIN_PINNED_MEGABYTES = 6;
export const MAX_RUN_BYTES = 16_384;
export const RUN_FIELDS = ["image", "run", "timeout", "check_sha256", "memory", "cpus"] as const;

export type PinnedRun = { image: string; run: string; timeout: number; checkSha256?: string; memory?: string; cpus?: string };

const DIGESTED = /^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$/;
const MEMORY = /^[1-9]\d{0,5}[mg]$/;
const CPUS = /^\d{1,3}(\.\d{1,2})?$/;
const MEGABYTES_PER_GIGABYTE = 1024;
const LONE_SURROGATE = /\p{Cs}/u;
const SHA256 = /^[0-9a-f]{64}$/;
const SHOWN = 80;

export const imageValid = (image: string): boolean => DIGESTED.test(image);
export const memoryValid = (memory: string): boolean => MEMORY.test(memory);
export const cpusValid = (cpus: string): boolean => CPUS.test(cpus) && Number(cpus) > 0;
export const megabytesOf = (memory: string): number => Number(memory.slice(0, -1)) * (memory.endsWith("g") ? MEGABYTES_PER_GIGABYTE : 1);
export const utf8Exact = (value: unknown): boolean => typeof value !== "string" || !LONE_SURROGATE.test(value);

const shown = (value: unknown): string => (JSON.stringify(value) ?? String(value)).slice(0, SHOWN);

class RunBlockProblem {
  constructor(readonly why: string) {}
}

const blockRefused =(why: string): never => {
  throw new RunBlockProblem(`the spec's ${RUN_FENCE} block ${why}`);
};

const specRefused = (why: string): never => {
  throw new RunBlockProblem(`the spec ${why}`);
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
  const fits = typeof value === "string" && value.trim() !== "" && new TextEncoder().encode(value).length <= MAX_RUN_BYTES && !value.includes("\0") && utf8Exact(value);
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

function pinnedRunBlock(spec: Uint8Array): PinnedRun | undefined {
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

export type RunBlockRead = { pinned: PinnedRun | undefined } | { problem: string };

export function readRunBlock(spec: Uint8Array): RunBlockRead {
  try {
    return { pinned: pinnedRunBlock(spec) };
  } catch (error) {
    if (error instanceof RunBlockProblem) {
      return { problem: error.why };
    }
    throw error;
  }
}

export function runBlockProblem(spec: Uint8Array): string | undefined {
  const read = readRunBlock(spec);
  return "problem" in read ? read.problem : undefined;
}

export function runBlockPreflight(spec: Uint8Array): string | undefined {
  return fenceMentions(specText(spec), RUN_FENCE) === 0 ? undefined : runBlockProblem(spec);
}
