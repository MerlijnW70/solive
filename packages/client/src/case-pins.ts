import { CASES_FENCE, CPUS_RULE, cpusValid, megabytesOf, memoryValid } from "./run-block.js";
import { ambiguous, readBlocks, specText, topKeys } from "./spec-blocks.js";

export const NODE_MEMORY = "node_memory";
export const NODE_MIN_MEGABYTES = 128;
export const NODE_MEMORY_RULE = `a string of whole megabytes or gigabytes, such as "512m" or "2g", of at least ${NODE_MIN_MEGABYTES}m, the least under which the launcher and a case that does nothing both start in Node`;

export const CASE_MS = "case_ms";
export const CASE_MS_MIN = 100;
export const CASE_MS_MAX = 60_000;
export const CASE_MS_RULE = `a whole number of milliseconds from ${CASE_MS_MIN} to ${CASE_MS_MAX}`;

export const NODE_CPUS = "node_cpus";
export const NODE_CPUS_RULE = CPUS_RULE;

export type CasePins = { nodeMemory?: string; caseMs?: number; nodeCpus?: string };

export type CasePinsRead = { pins: CasePins; problem?: undefined } | { pins?: undefined; problem: string };

const SHOWN = 80;

const shown = (value: unknown): string => (JSON.stringify(value) ?? String(value)).slice(0, SHOWN);

export const pinTwice = (name: string): string => `has the field ${JSON.stringify(name)} more than once`;

export const pinRefused = (name: string, value: unknown, rule: string): string => `has ${name} ${shown(value)}, which is not ${rule}`;

const memoryFits = (value: unknown): boolean => typeof value === "string" && memoryValid(value) && megabytesOf(value) >= NODE_MIN_MEGABYTES;

const caseMsFits = (value: unknown): boolean => typeof value === "number" && Number.isSafeInteger(value) && value >= CASE_MS_MIN && value <= CASE_MS_MAX;

const cpusFits = (value: unknown): boolean => typeof value === "string" && cpusValid(value);

const PINS: readonly (readonly [string, (value: unknown) => boolean, string])[] = [
  [NODE_MEMORY, memoryFits, NODE_MEMORY_RULE],
  [CASE_MS, caseMsFits, CASE_MS_RULE],
  [NODE_CPUS, cpusFits, NODE_CPUS_RULE],
];

export function casePinsProblem(body: string, fields: Record<string, unknown>): string | undefined {
  const keys = topKeys(body);
  for (const [name, fits, rule] of PINS) {
    if (!(name in fields)) {
      continue;
    }
    if (keys.filter((key) => key === name).length > 1) {
      return pinTwice(name);
    }
    if (!fits(fields[name])) {
      return pinRefused(name, fields[name], rule);
    }
  }
  return undefined;
}

export const casePinsOf = (fields: Record<string, unknown>): CasePins => ({
  ...(typeof fields[NODE_MEMORY] === "string" ? { nodeMemory: fields[NODE_MEMORY] } : {}),
  ...(typeof fields[CASE_MS] === "number" ? { caseMs: fields[CASE_MS] } : {}),
  ...(typeof fields[NODE_CPUS] === "string" ? { nodeCpus: fields[NODE_CPUS] } : {}),
});

export function casePinsRead(spec: Uint8Array): CasePinsRead {
  const read = readBlocks(specText(spec), CASES_FENCE);
  const body = read.bodies[0] ?? "";
  if (ambiguous(read) || read.bodies.length !== 1) {
    return { pins: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { pins: {} };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { pins: {} };
  }
  const fields = parsed as Record<string, unknown>;
  const problem = casePinsProblem(body, fields);
  return problem === undefined ? { pins: casePinsOf(fields) } : { problem: `the spec's ${CASES_FENCE} block ${problem}` };
}

export const casePinsPreflight = (spec: Uint8Array): string | undefined => casePinsRead(spec).problem;
