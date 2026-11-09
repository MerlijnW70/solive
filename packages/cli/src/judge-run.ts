import { manifestSha256 } from "@intent-engine/core/internal";
import { type PinnedRun, readRunBlock, runBlockProblem } from "@intent-engine/client/internal";
import type { CheckFiles } from "./artifact.js";
import { JudgeRefused } from "./judge-errors.js";
import { casePinsRead } from "./viper.js";

export {
  BOTH_BLOCKS,
  CPUS_RULE,
  IMAGE_RULE,
  manyBlocks,
  MAX_PINNED_TIMEOUT,
  MAX_RUN_BYTES,
  MEMORY_RULE,
  MIN_PINNED_MEGABYTES,
  NOT_UTF8,
  ODD_LINE_ENDS,
  type PinnedRun,
  RUN_FENCE,
  RUN_FIELDS,
  RUN_OVERHEAD_SECONDS,
  RUN_RULE,
  TIMEOUT_RULE,
} from "@intent-engine/client/internal";

export class RunBlockRefused extends JudgeRefused {
  constructor(readonly why: string) {
    super(`${why}; nothing was run or paid`);
    this.name = "RunBlockRefused";
  }
}

export function pinnedRunOf(spec: Uint8Array): PinnedRun | undefined {
  const read = readRunBlock(spec);
  if ("problem" in read) {
    throw new RunBlockRefused(read.problem);
  }
  return read.pinned;
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

export const runProblem = (spec: Uint8Array): string | undefined => runBlockProblem(spec) ?? casePinsRead(spec).problem;

export type RunRead = { judge_run?: ShownRun; judge_run_refused?: string; node_memory?: string; node_cpus?: string; case_ms?: number };

export function runRead(spec: Uint8Array): RunRead {
  const problem = runProblem(spec);
  if (problem !== undefined) {
    return { judge_run_refused: problem };
  }
  const pinned = pinnedRunOf(spec);
  const pins = casePinsRead(spec).pins ?? {};
  return {
    ...(pinned === undefined ? {} : { judge_run: shownRun(pinned) }),
    ...(pins.nodeMemory === undefined ? {} : { node_memory: pins.nodeMemory }),
    ...(pins.nodeCpus === undefined ? {} : { node_cpus: pins.nodeCpus }),
    ...(pins.caseMs === undefined ? {} : { case_ms: pins.caseMs }),
  };
}
