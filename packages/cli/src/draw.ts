import { createHash } from "node:crypto";
import { type Address, getAddressEncoder, getBase58Encoder } from "@solana/kit";
import type { Delivery, FinalizedBlock, Transport } from "@intent-engine/client";
import { JudgeRefused } from "./judge-errors.js";
import {
  type Case,
  type CaseResult,
  type Cases,
  CASES_FENCE,
  CLOCK_FROM,
  CLOCK_TO,
  deadlineMissed,
  decodeOutput,
  type Draw,
  encodeInput,
  type Failure,
  isPrimitive,
  MAX_ARGUMENTS,
  moduleText,
  OUTPUT_BYTES,
  type Primitive,
  REPORTED_FAILURES,
  type Run,
  runViper,
  SEED_LIMIT,
  stoppedAll,
} from "./viper.js";

export const DRAW_TAG = "judge-draw";
export const DRAW_POLL_SECONDS = 2;
export const DETAIL_BYTES = 256;

export type Beacon = FinalizedBlock & { seed: string; draw: Draw };
export type DrawJudged = { slot: number; blockhash: string; seed: string; total: number; passed: number; failures: Failure[] };

const ENTRY = "judgeDrawEntry";
const DEFAULT_EXPORT = /\bexport\s+default\b/g;
const FITS = `const fits = (value) => value === null || typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));`;
const ASCII = String.raw`.replace(/[\u0080-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"))`;
const GENERATOR_TAIL = `export default (seed, count, at) => { ${FITS} const lists = ${ENTRY}(seed, count); if (!(Array.isArray(lists) && lists.every((args) => Array.isArray(args) && args.every(fits)))) return false; const text = JSON.stringify(lists)${ASCII}; return at < 0 ? text.length : text.slice(at, at + ${DETAIL_BYTES}); };`;
const CHECKER_TAIL = `export default (answer, ...args) => { const held = ${ENTRY}(args, answer); return held === true || held === false ? held : null; };`;

const refuseDraw = (part: "generator" | "checker", why: string): never => {
  throw new JudgeRefused(`the spec's ${CASES_FENCE} draw ${part} ${why}; the spec is at fault, not the worker, and nothing was paid`);
};

export const notAnnounced = (sha256: string, intent: Address): string =>
  `the spec draws its cases from the first finalized block after the earliest announcement of the artifact with sha256 ${sha256} for intent ${intent}, and nobody announced it; nothing was run or paid`;

export const answerTooLong = `a drawn case's answer is longer than the ${DETAIL_BYTES} bytes the viper judge reports, so the checker cannot see it; nothing was paid`;

export const noBlocks = "the spec draws its cases from a finalized block, and the RPC node cannot list or read finalized blocks; nothing was run or paid";

export const stoppedWaiting = (slot: bigint): string =>
  `the judge stopped waiting for the first block at or after slot ${slot} to be finalized; nothing was run or paid`;

export function drawSeed(blockhash: string, intent: Address, artifactSha256: string): string {
  return createHash("sha256")
    .update(DRAW_TAG)
    .update(Uint8Array.from(getBase58Encoder().encode(blockhash)))
    .update(Uint8Array.from(getAddressEncoder().encode(intent)))
    .update(Buffer.from(artifactSha256, "hex"))
    .digest("hex");
}

export function engineRun(seed: string): Run {
  return {
    seed: 1 + (parseInt(seed.slice(0, 12), 16) % (SEED_LIMIT - 1)),
    clock: CLOCK_FROM + (parseInt(seed.slice(12, 24), 16) % (CLOCK_TO - CLOCK_FROM)),
  };
}

export async function drawBeacon(
  transport: Transport,
  sleep: (seconds: number) => Promise<boolean>,
  first: Delivery | null,
  draw: Draw,
  intent: Address,
  sha256: string,
): Promise<Beacon> {
  if (first === null) {
    throw new JudgeRefused(notAnnounced(sha256, intent));
  }
  const { finalizedBlock } = transport;
  if (finalizedBlock === undefined) {
    throw new JudgeRefused(noBlocks);
  }
  const from = first.slot + BigInt(draw.k);
  for (;;) {
    const block = await finalizedBlock.call(transport, from);
    if (block !== null) {
      return { ...block, seed: drawSeed(block.blockhash, intent, sha256), draw };
    }
    if (!(await sleep(DRAW_POLL_SECONDS))) {
      throw new JudgeRefused(stoppedWaiting(from));
    }
  }
}

function wrapped(source: string, part: "generator" | "checker", tail: string): string {
  const found = source.match(DEFAULT_EXPORT)?.length ?? 0;
  if (found !== 1) {
    return refuseDraw(part, `has ${found} default exports, not one`);
  }
  return `${source.replace(DEFAULT_EXPORT, `const ${ENTRY} =`)}\n;${tail}\n`;
}

type Unfinished = { verdict: "stopped" | "crashed"; detail: string };

async function ranCases(wasm: Buffer, source: string, budget: Cases, cases: Case[], run: Run, timeoutSeconds: number): Promise<CaseResult[] | Unfinished> {
  if (timeoutSeconds <= 0) {
    return { verdict: "stopped", detail: deadlineMissed("the viper judge", timeoutSeconds) };
  }
  const ran = await runViper(wasm, encodeInput(source, { steps: budget.steps, heap: budget.heap, seed: undefined, clock: undefined, cases }, run), timeoutSeconds);
  if (ran.timedOut) {
    return { verdict: "stopped", detail: deadlineMissed("the viper judge", timeoutSeconds) };
  }
  if (ran.exitCode !== 0) {
    return { verdict: "crashed", detail: `the judge process ended with exit code ${ran.exitCode}: ${ran.diagnostic.trim().slice(0, 256)}` };
  }
  return decodeOutput(ran.output, cases.length);
}

const unfinished = (ran: CaseResult[] | Unfinished): ran is Unfinished => !Array.isArray(ran);

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const told = (result: CaseResult | undefined): string =>
  result === undefined ? "gave no verdict" : `gave the verdict ${result.verdict}${result.detail === undefined ? "" : ` with ${JSON.stringify(result.detail)}`}`;

export async function drawnArguments(wasm: Buffer, budget: Cases, draw: Draw, seed: string, timeoutSeconds: number): Promise<Primitive[][]> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const left = () => Math.max(0, deadline - Date.now()) / 1000;
  const source = wrapped(draw.generator, "generator", GENERATOR_TAIL);
  const run = engineRun(seed);
  const invalid = `did not return ${draw.count} lists of at most ${MAX_ARGUMENTS} JSON strings, numbers, booleans or nulls, in at most ${OUTPUT_BYTES} bytes of JSON`;
  const read = async (at: number[]): Promise<Primitive[]> => {
    const results = await ranCases(wasm, source, budget, at.map((from) => ({ args: [seed, draw.count, from], expected: null })), run, left());
    if (unfinished(results)) {
      return refuseDraw("generator", `did not finish: ${results.detail}`);
    }
    return results.map((result) => (result.verdict === "wrong" ? (result.detail ?? null) : refuseDraw("generator", told(result))));
  };
  const [length] = await read([-1]);
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > OUTPUT_BYTES) {
    return refuseDraw("generator", invalid);
  }
  const chunks = await read(Array.from({ length: Math.ceil(length / DETAIL_BYTES) }, (_, index) => index * DETAIL_BYTES));
  const text = chunks.every((chunk) => typeof chunk === "string") ? chunks.join("") : "";
  const lists = text.length === length ? parsed(text) : undefined;
  if (!Array.isArray(lists) || lists.length !== draw.count || !lists.every((args: unknown) => Array.isArray(args) && args.length <= MAX_ARGUMENTS && args.every(isPrimitive))) {
    return refuseDraw("generator", invalid);
  }
  return lists as Primitive[][];
}

export async function judgeDraw(
  wasm: Buffer,
  source: Uint8Array,
  cases: Cases,
  beacon: Beacon,
  left: () => number,
  run: Run,
): Promise<DrawJudged> {
  const text = moduleText(source);
  const { draw } = beacon;
  const drawn = await drawnArguments(wasm, cases, draw, beacon.seed, left());
  const recorded = { slot: Number(beacon.slot), blockhash: beacon.blockhash, seed: beacon.seed };
  const answered = await ranCases(wasm, text, cases, drawn.map((args) => ({ args, expected: null })), run, left());
  const unanswered = (ran: Unfinished): DrawJudged => ({
    ...recorded,
    ...(ran.verdict === "stopped" ? stoppedAll(drawn.length, ran.detail) : { total: drawn.length, passed: 0, failures: [{ case: 0, ...ran }] }),
  });
  if (unfinished(answered)) {
    return unanswered(answered);
  }
  const failures: Failure[] = [];
  const answers: { case: number; answer: Primitive }[] = [];
  answered.forEach((result, index) => {
    if (result.verdict === "pass") {
      answers.push({ case: index, answer: null });
    } else if (result.verdict === "wrong") {
      answers.push({ case: index, answer: result.detail ?? null });
    } else {
      failures.push({ case: index, ...result });
    }
  });
  const long = answers.filter(({ answer }) => typeof answer === "string" && Buffer.byteLength(answer) > DETAIL_BYTES - 4);
  if (long.length > 0) {
    const confirmed = await ranCases(wasm, text, cases, long.map(({ case: index, answer }) => ({ args: drawn[index] ?? [], expected: answer })), run, left());
    if (unfinished(confirmed)) {
      return unanswered(confirmed);
    }
    if (confirmed.some((result) => result.verdict !== "pass")) {
      throw new JudgeRefused(answerTooLong);
    }
  }
  if (answers.length > 0) {
    const checked = await ranCases(
      wasm,
      wrapped(draw.checker, "checker", CHECKER_TAIL),
      cases,
      answers.map(({ case: index, answer }) => ({ args: [answer, ...(drawn[index] ?? [])], expected: true })),
      engineRun(beacon.seed),
      left(),
    );
    if (unfinished(checked)) {
      return refuseDraw("checker", `did not finish: ${checked.detail}`);
    }
    checked.forEach((result, at) => {
      const { case: index, answer } = answers[at] as { case: number; answer: Primitive };
      if (result.verdict === "wrong" && result.detail === false) {
        failures.push({ case: index, verdict: "wrong", detail: answer });
      } else if (result.verdict !== "pass") {
        refuseDraw("checker", result.verdict === "wrong" ? "returned something other than true or false" : told(result));
      }
    });
  }
  failures.sort((a, b) => a.case - b.case);
  return { ...recorded, total: drawn.length, passed: drawn.length - failures.length, failures: failures.slice(0, REPORTED_FAILURES) };
}
