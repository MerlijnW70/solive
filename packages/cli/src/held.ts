import { createHash } from "node:crypto";
import type { Address } from "@solana/kit";
import { SealedError, unseal } from "@intent-engine/core";
import { chainTime, CLOCK_SYSVAR, type FinalizedBlock, loadCommittee, PUBLIC_GENESIS_HASHES, SPEC_TIMEOUT_MS, type SpecFetch, type Transport } from "@intent-engine/client";
import { HeldRefused, JudgeRefused } from "./judge-errors.js";
import { body, NOT_PUBLIC } from "./delivery-fetch.js";
import { answerTooLong, checkedAnswers, ENTRY, noBlocks, ranCases, unfinished, wrapped } from "./draw.js";
import { judgeHost } from "./host-judge.js";
import { judgeNode } from "./node-judge.js";
import { type Lookup, publicHost, systemLookup } from "./public-address.js";
import type { Box } from "./sandbox.js";
import { type Case, type Cases, casesOf, CASES_FENCE, type Held, isPrimitive, MAX_ARGUMENTS, type Primitive, type Run } from "./viper.js";

export const HELD_MARGIN_SECONDS = 3_600;
export const SLOT_MS = 400;

export type HeldEntry = { args: Primitive[]; expected?: Primitive };
export type HeldJudged = { count: number; passed: boolean; slot: number };
export type Opened = { block: FinalizedBlock; entries: HeldEntry[] };

const DOMAIN_TAIL = `export default (...args) => ${ENTRY}(...args) === true;`;
const AT_FAULT = "the spec is at fault, not the worker, and nothing was paid";

export const heldOutside = `a held case lies outside the spec's held domain; ${AT_FAULT}`;

export const heldChecker = `the spec's draw checker failed on a held case; ${AT_FAULT}`;

export const heldOnlyViper = `the spec's ${CASES_FENCE} block holds sealed held cases, which only --sandbox viper judges; nothing was run or paid`;

export const heldOnDevice = (path: string): string =>
  `the spec's held cases are sealed to the judge's key, and the Ledger ${path} cannot open them; pass --keypair with a JSON key file. Nothing was run or paid`;

export const heldCommittee = (intent: Address, committee: Address): string =>
  `the spec's held cases are judged only by a single-key judge, and intent ${intent} names committee ${committee} as its judge; nothing was run or paid`;

export const heldHashWrong = (found: string, pinned: string): string => `the held cases have sha256 ${found}, not the ${pinned} the spec pins; ${AT_FAULT}`;

export const heldQueued = (at: number): string =>
  `the published and drawn cases passed, and the held cases are judged once a block at or after slot ${at} is finalized, so nothing was sent. Judge this delivery again then, or keep judge --watch running: it judges the queued deliveries in announcement order`;

export const heldTooSoon = (at: number, eta: bigint, expiresAt: bigint): string =>
  `the spec's held cases are judged after slot ${at}, which the chain clock puts near ${eta} at ${SLOT_MS} ms a slot, and the escrow expires at ${expiresAt}, less than the ${HELD_MARGIN_SECONDS} seconds judging needs after it; expire it later or pin an earlier slot`;

const unopened = (url: string, why: string): never => {
  throw new HeldRefused(`the held cases at ${url} ${why}; nothing was run or paid`);
};

const malformed = (why: string): never => {
  throw new HeldRefused(`the held cases ${why}; ${AT_FAULT}`);
};

export function heldOf(spec: Uint8Array): Held | undefined {
  try {
    return casesOf(spec).held;
  } catch {
    return undefined;
  }
}

export async function heldReached(transport: Transport, held: Held): Promise<FinalizedBlock | null> {
  const { finalizedBlock } = transport;
  if (finalizedBlock === undefined) {
    throw new JudgeRefused(noBlocks);
  }
  return finalizedBlock.call(transport, BigInt(held.at));
}

function entryOf(item: unknown, index: number, checker: boolean): HeldEntry {
  const entry = typeof item === "object" && item !== null && !Array.isArray(item) ? (item as Record<string, unknown>) : undefined;
  if (entry === undefined || Object.keys(entry).some((key) => key !== "args" && key !== "expected")) {
    return malformed(`hold entry ${index}, which is not an object of args and an optional expected`);
  }
  const args = entry["args"];
  if (!Array.isArray(args) || args.length > MAX_ARGUMENTS || !args.every(isPrimitive)) {
    return malformed(`hold entry ${index}, whose args are not a list of at most ${MAX_ARGUMENTS} JSON strings, numbers, booleans or nulls`);
  }
  if (!("expected" in entry)) {
    return checker ? { args } : malformed(`hold entry ${index} without expected, and the spec has no draw checker`);
  }
  const expected = entry["expected"];
  if (!isPrimitive(expected) || Object.is(expected, -0)) {
    return malformed(`hold entry ${index}, whose expected answer is not a JSON string, number, boolean or null other than negative zero`);
  }
  return { args, expected };
}

export async function openHeld(get: SpecFetch, transport: Transport, cases: Cases, keypair: Uint8Array, lookup: Lookup = systemLookup): Promise<HeldEntry[]> {
  const held = cases.held as Held;
  const { url } = held;
  if (PUBLIC_GENESIS_HASHES.has(await transport.genesisHash()) && !(await publicHost(new URL(url).hostname, lookup))) {
    return unopened(url, NOT_PUBLIC);
  }
  let sealed: Uint8Array;
  try {
    sealed = await body(await get(url, { redirect: "error", signal: AbortSignal.timeout(SPEC_TIMEOUT_MS) }), url);
  } catch (error) {
    return unopened(url, `could not be fetched: ${error instanceof Error ? error.message : String(error)}`);
  }
  let plain: Uint8Array;
  try {
    plain = await unseal(sealed, keypair);
  } catch (error) {
    if (error instanceof SealedError) {
      return malformed(`at ${url} could not be opened with this judge's key: ${error.message}`);
    }
    throw error;
  }
  const sha256 = createHash("sha256").update(plain).digest("hex");
  if (sha256 !== held.sha256) {
    throw new HeldRefused(heldHashWrong(sha256, held.sha256));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain));
  } catch {
    return malformed("are not UTF-8 JSON");
  }
  if (!Array.isArray(parsed) || parsed.length !== held.count) {
    return malformed(`are not a JSON array of the ${held.count} entries the spec counts`);
  }
  return parsed.map((item: unknown, index) => entryOf(item, index, cases.draw !== undefined));
}

export async function heldDomain(wasm: Buffer, cases: Cases, entries: readonly HeldEntry[], run: Run, timeoutSeconds: number): Promise<void> {
  let source: string;
  try {
    source = wrapped((cases.held as Held).domain, "domain", DOMAIN_TAIL);
  } catch (error) {
    throw error instanceof JudgeRefused ? new HeldRefused(error.message) : error;
  }
  const ran = await ranCases(wasm, source, cases, entries.map(({ args }) => ({ args, expected: true })), run, timeoutSeconds);
  if (unfinished(ran)) {
    throw new HeldRefused(`the spec's ${CASES_FENCE} held domain did not finish: ${ran.detail}; ${AT_FAULT}`);
  }
  if (ran.some((result) => result.verdict !== "pass")) {
    throw new HeldRefused(heldOutside);
  }
}

export type HeldRun = { wasm: Buffer; module: Uint8Array; text: string; path: string; cases: Cases; run: Run; left: () => number; node: Box | undefined };

async function answeredOnly(given: HeldRun, inputs: Primitive[][]): Promise<boolean> {
  if (inputs.length === 0) {
    return true;
  }
  const { wasm, text, cases, run, left } = given;
  const answered = await ranCases(wasm, text, cases, inputs.map((args) => ({ args, expected: null })), run, left());
  if (unfinished(answered)) {
    return false;
  }
  try {
    const failures = await checkedAnswers(wasm, text, cases, cases.draw?.checker ?? "", inputs, answered, run, run, left);
    return !unfinished(failures) && failures.length === 0;
  } catch (error) {
    if (error instanceof JudgeRefused && error.message === answerTooLong) {
      return false;
    }
    throw error instanceof JudgeRefused ? new HeldRefused(heldChecker) : error;
  }
}

async function expectedOnly(given: HeldRun, known: Case[]): Promise<{ passed: boolean; cleanup: string | undefined }> {
  if (known.length === 0) {
    return { passed: true, cleanup: undefined };
  }
  const { wasm, module, text, path, cases, run, left, node } = given;
  const ran = await ranCases(wasm, text, cases, known, run, left());
  if (unfinished(ran) || ran.some((result) => result.verdict !== "pass")) {
    return { passed: false, cleanup: undefined };
  }
  const budget: Cases = { ...cases, cases: known };
  const host = await judgeHost(module, budget, left(), run.seed);
  if (host.passed !== host.total) {
    return { passed: false, cleanup: undefined };
  }
  if (node === undefined) {
    return { passed: true, cleanup: undefined };
  }
  const plain = await judgeNode(node, module, path, budget, run.seed, left());
  return { passed: plain.judged.passed === plain.judged.total, cleanup: plain.cleanup };
}

export async function judgeHeld(given: HeldRun, opened: Opened): Promise<{ held: HeldJudged; cleanup: string | undefined }> {
  const { entries, block } = opened;
  const known = entries.flatMap((entry): Case[] => (entry.expected === undefined ? [] : [{ args: entry.args, expected: entry.expected }]));
  const unknown = entries.flatMap((entry) => (entry.expected === undefined ? [entry.args] : []));
  const checked = await answeredOnly(given, unknown);
  const expected = checked ? await expectedOnly(given, known) : { passed: false, cleanup: undefined };
  return { held: { count: entries.length, passed: checked && expected.passed, slot: Number(block.slot) }, cleanup: expected.cleanup };
}

async function specText(get: SpecFetch, url: string): Promise<Uint8Array | undefined> {
  try {
    return await body(await get(url, { redirect: "error", signal: AbortSignal.timeout(SPEC_TIMEOUT_MS) }), url);
  } catch {
    return undefined;
  }
}

export type Creating = { specUrl: unknown; specHash: unknown; attestor: unknown; expiresAt: unknown; expiresIn: unknown };

export async function heldDeadline(transport: Transport, get: SpecFetch, creating: Creating): Promise<string | undefined> {
  const { specUrl, specHash } = creating;
  if (typeof specUrl !== "string" || typeof specHash !== "string") {
    return undefined;
  }
  const spec = await specText(get, specUrl);
  if (spec === undefined || createHash("sha256").update(spec).digest("hex") !== specHash.toLowerCase()) {
    return undefined;
  }
  const held = heldOf(spec);
  if (held === undefined) {
    return undefined;
  }
  if (typeof creating.attestor === "string" && (await loadCommittee(transport, creating.attestor as Address)) !== null) {
    return `the spec's held cases are judged only by a single-key judge, and --attestor ${creating.attestor} is a committee`;
  }
  const clock = await transport.getAccount(CLOCK_SYSVAR);
  const now = await chainTime(transport);
  const slot = clock === null ? 0n : new DataView(clock.data.buffer, clock.data.byteOffset).getBigUint64(0, true);
  const expiresAt = creating.expiresAt === undefined ? now + BigInt(String(creating.expiresIn)) : BigInt(String(creating.expiresAt));
  const ahead = BigInt(held.at) > slot ? BigInt(held.at) - slot : 0n;
  const eta = now + (ahead * BigInt(SLOT_MS)) / 1000n;
  return expiresAt < eta + BigInt(HELD_MARGIN_SECONDS) ? heldTooSoon(held.at, eta, expiresAt) : undefined;
}
