import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, generateKeyPairSigner, getAddressEncoder, getBase58Encoder, type KeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { deliveryMemo, getIntentDecoder, IntentStatus, Kind } from "@intent-engine/core";
import { createClient, type EngineTransaction, type FinalizedBlock, type Transport } from "@intent-engine/client";
import { NOT_SENT } from "../src/flows.js";
import { EXIT_FAILED, EXIT_OK } from "../src/main.js";
import { answerTooLong, DETAIL_BYTES, DRAW_POLL_SECONDS, DRAW_TAG, drawBeacon, drawnArguments, drawSeed, noBlocks, notAnnounced, stoppedWaiting } from "../src/draw.js";
import { casesOf, type Draw, OUTPUT_BYTES, pinnedWasm } from "../src/viper.js";
import { cli, creation, funded, h, NOW, transport, type World, world } from "./harness.js";

const GENERATOR = `export default function generate(seed, count) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    let text = "w";
    for (let j = 0; j < 8; j += 1) {
      const digit = parseInt(seed[(i * 8 + j) % seed.length], 16);
      text += digit % 4 === 0 ? " " : String.fromCharCode(97 + digit);
    }
    out.push([text]);
  }
  return out;
}`;
const CHECKER = "export default (args, answer) => { const words = args[0].match(/\\S+/g); return answer === (words === null ? 0 : words.length); };";
const DRAWN = 12;
const K = 3;
const PUBLISHED = [
  { args: [""], expected: 0 },
  { args: ["one"], expected: 1 },
  { args: ["one\ttwo　three"], expected: 3 },
];
const CORRECT = "export default function count(text) { const words = text.match(/\\S+/g); return words === null ? 0 : words.length; }\n";
const TABLE = 'const table = { "": 0, "one": 1, "one\\ttwo\\u3000three": 3 }; export default (text) => (text in table ? table[text] : -1);\n';
const BLOCKHASH = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const OTHER_BLOCKHASH = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";
const ANNOUNCED = 5n;

const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const specOf = (block: object) => `# Count words\n\n\`\`\`judge-cases\n${JSON.stringify(block)}\n\`\`\`\n`;
const drawSpec = (draw: Partial<Draw> = {}) => specOf({ cases: PUBLISHED, draw: { count: DRAWN, generator: GENERATOR, checker: CHECKER, k: K, ...draw } });

type Job = { w: World; judge: KeyPairSigner; worker: KeyPairSigner; intent: Address; spec: string; artifact: string; sha256: string; asked: bigint[] };

type Chain = { blocks?: (FinalizedBlock | null)[]; announced?: boolean; finalized?: boolean };

async function job(module: string, specText: string, chain: Chain = {}): Promise<Job> {
  const w = await world();
  const judge = await funded();
  const worker = await generateKeyPairSigner();
  const dir = await mkdtemp(join(tmpdir(), "judge-draw-"));
  const spec = join(dir, "spec.md");
  await writeFile(spec, specText);
  const artifact = join(dir, "count.mjs");
  await writeFile(artifact, module);
  const sha256 = sha(module);
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: new Uint8Array(createHash("sha256").update(specText).digest()), judgeFee: 0n } as const;
  const client = createClient({ url: "http://cluster", transport });
  const { intent } = await client.createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  const delivered: EngineTransaction = {
    signature: "first",
    slot: ANNOUNCED,
    blockTime: null,
    failed: false,
    emitted: [],
    memos: [deliveryMemo({ intent, sha256, url: "https://" + "example.org/count.mjs" })],
    feePayer: worker.address,
  };
  h.engineLog = chain.announced === false ? [creation(intent)] : [delivered, creation(intent)];
  const asked: bigint[] = [];
  const blocks = [...(chain.blocks ?? [{ slot: ANNOUNCED + BigInt(K) + 1n, blockhash: BLOCKHASH }])];
  const finalizedBlock = async (from: bigint) => {
    asked.push(from);
    return blocks.length > 1 ? (blocks.shift() ?? null) : (blocks[0] ?? null);
  };
  h.through = chain.finalized === false ? { ...transport } : ({ ...transport, finalizedBlock } as Transport);
  return { w, judge, worker, intent, spec, artifact, sha256, asked };
}

const judging = (j: Job, ...more: string[]) => ["judge", "--keypair", "judge.json", "--owner", j.w.owner.address, "--nonce", "0", "--spec", j.spec, "--artifact", j.artifact, "--sandbox", "viper", ...more];

const status = (intent: Address) => {
  const account = h.svm.getAccount(intent);
  return account.exists ? getIntentDecoder().decode(account.data).status : undefined;
};

describe("judge --sandbox viper with cases drawn after the announcement", () => {
  it("fails a delivery that answers only the published cases from a table on the drawn ones, and pays nothing", async () => {
    const j = await job(TABLE, drawSpec());
    const judged = await cli(judging(j, "--yes"), { "judge.json": j.judge });
    expect(judged.code).toBe(EXIT_FAILED);
    expect(judged.json()).toMatchObject({
      verdict: "fail",
      signature: null,
      cases: { total: 3, passed: 3, failures: [] },
      host: { total: 3, passed: 3 },
      drawn: { slot: Number(ANNOUNCED) + K + 1, blockhash: BLOCKHASH, seed: drawSeed(BLOCKHASH, j.intent, j.sha256), total: DRAWN, passed: 0 },
    });
    const failures = (judged.json()["drawn"] as { failures: { case: number; verdict: string; detail: unknown }[] }).failures;
    expect(failures).toHaveLength(DRAWN);
    expect(failures.every((failure, index) => failure.case === index && failure.verdict === "wrong" && failure.detail === -1)).toBe(true);
    expect(status(j.intent)).toBe(IntentStatus.Open);
  });

  it("passes a correct delivery on the published and drawn cases, records the slot, blockhash and seed, and pays", async () => {
    const j = await job(CORRECT, drawSpec());
    const preview = await cli(judging(j), { "judge.json": j.judge });
    expect([preview.code, preview.err]).toEqual([EXIT_OK, ""]);
    const drawn = { slot: Number(ANNOUNCED) + K + 1, blockhash: BLOCKHASH, seed: drawSeed(BLOCKHASH, j.intent, j.sha256), total: DRAWN, passed: DRAWN, failures: [] };
    expect(preview.json()).toMatchObject({ verdict: "pass", cases: { total: 3, passed: 3 }, drawn, next: NOT_SENT });
    expect(j.asked).toEqual([ANNOUNCED + BigInt(K)]);
    const sent = await cli(judging(j, "--yes"), { "judge.json": j.judge });
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    expect(sent.json()).toMatchObject({ verdict: "pass", drawn, signature: expect.any(String) });
    expect(status(j.intent)).toBe(IntentStatus.Filled);
  });

  it("two judges derive identical cases from the same announcement, and a different blockhash gives different cases", async () => {
    const wasm = await pinnedWasm();
    const j = await job(CORRECT, drawSpec());
    const cases = casesOf(new TextEncoder().encode(drawSpec()));
    const draw = cases.draw as Draw;
    const first = { intent: j.intent, worker: j.worker.address, sha256: j.sha256, url: "", signature: "first" as never, slot: ANNOUNCED, blockTime: null };
    const node = (blockhash: string) => ({ ...transport, finalizedBlock: async () => ({ slot: ANNOUNCED + BigInt(K), blockhash }) }) as Transport;
    const never = async () => false;
    const one = await drawBeacon(node(BLOCKHASH), never, first, draw, j.intent, j.sha256);
    const two = await drawBeacon(node(BLOCKHASH), never, first, draw, j.intent, j.sha256);
    const other = await drawBeacon(node(OTHER_BLOCKHASH), never, first, draw, j.intent, j.sha256);
    expect(two.seed).toBe(one.seed);
    const pinned = createHash("sha256").update(DRAW_TAG).update(Uint8Array.from(getBase58Encoder().encode(BLOCKHASH))).update(Uint8Array.from(getAddressEncoder().encode(j.intent))).update(Buffer.from(j.sha256, "hex")).digest("hex");
    expect(one.seed).toBe(pinned);
    expect(other.seed).not.toBe(one.seed);
    const drawnOne = await drawnArguments(wasm, cases, draw, one.seed, 30);
    const drawnTwo = await drawnArguments(wasm, cases, draw, two.seed, 30);
    const drawnOther = await drawnArguments(wasm, cases, draw, other.seed, 30);
    expect(drawnOne).toHaveLength(DRAWN);
    expect(drawnTwo).toEqual(drawnOne);
    expect(drawnOther).not.toEqual(drawnOne);
    const k = await job("export default (text) => text.length;\n", drawSpec());
    const verdicts = [];
    for (let round = 0; round < 2; round += 1) {
      const judged = await cli(judging(k), { "judge.json": k.judge });
      verdicts.push(judged.json()["drawn"]);
    }
    expect(verdicts[0]).toMatchObject({ total: DRAWN, passed: 0 });
    expect(verdicts[1]).toEqual(verdicts[0]);
  }, 60_000);

  it("draws the generator's own randomness from the seed, so its cases repeat", async () => {
    const wasm = await pinnedWasm();
    const random = "export default (seed, count) => Array.from({ length: count }, () => [Math.random(), Date.now()]);";
    const cases = casesOf(new TextEncoder().encode(drawSpec({ generator: random })));
    const draw = cases.draw as Draw;
    const seed = drawSeed(BLOCKHASH, "11111111111111111111111111111111" as Address, sha(CORRECT));
    expect(await drawnArguments(wasm, cases, draw, seed, 30)).toEqual(await drawnArguments(wasm, cases, draw, seed, 30));
  }, 60_000);

  it("reads a generator's lists whole, however long and whatever characters they hold", async () => {
    const wasm = await pinnedWasm();
    const wide = String.raw`export default (seed, count) => Array.from({ length: count }, (_, i) => [seed + "é　😀" + i, i / 4, i % 2 === 0, null]);`;
    const cases = casesOf(new TextEncoder().encode(drawSpec({ generator: wide })));
    const seed = drawSeed(BLOCKHASH, "11111111111111111111111111111111" as Address, sha(CORRECT));
    const expected = Array.from({ length: DRAWN }, (_, i) => [`${seed}é　😀${i}`, i / 4, i % 2 === 0, null]);
    expect(JSON.stringify(expected).length).toBeGreaterThan(3 * DETAIL_BYTES);
    expect(await drawnArguments(wasm, cases, cases.draw as Draw, seed, 30)).toEqual(expected);
  }, 60_000);

  it("checks a long answer whole, and refuses one longer than the engine reports", async () => {
    const answering = (length: number) => String.raw`export default (text) => (text[0] === "w" ? "x".repeat(${length}) : (text.match(/\S+/g) || []).length);` + "\n";
    const j = await job(answering(DETAIL_BYTES - 1), drawSpec());
    const judged = await cli(judging(j), { "judge.json": j.judge });
    expect(judged.code).toBe(EXIT_FAILED);
    expect(judged.json()).toMatchObject({ verdict: "fail", cases: { passed: 3 }, drawn: { total: DRAWN, passed: 0 } });
    expect((judged.json()["drawn"] as { failures: unknown[] }).failures[0]).toEqual({ case: 0, verdict: "wrong", detail: "x".repeat(DETAIL_BYTES - 1) });
    const over = await job(answering(DETAIL_BYTES + 1), drawSpec());
    const refused = await cli(judging(over, "--yes"), { "judge.json": over.judge });
    expect([refused.code, refused.err]).toEqual([EXIT_FAILED, expect.stringContaining(answerTooLong)]);
    expect(status(over.intent)).toBe(IntentStatus.Open);
  }, 60_000);

  it("refuses a spec whose generator or checker is broken, as the spec's fault, and pays nothing", async () => {
    for (const [draw, said] of [
      [{ generator: "export default () => { throw new Error('broken'); };" }, "the spec's judge-cases draw generator gave the verdict threw"],
      [{ generator: "export default (seed, count) => [[seed]];" }, `draw generator did not return ${DRAWN} lists`],
      [{ generator: "export default (seed, count) => Array.from({ length: count }, () => [{}]);" }, "draw generator did not return"],
      [{ generator: "export default (seed, count) => 'not lists';" }, "draw generator did not return"],
      [{ generator: "export default () => { for (;;) {} };" }, "draw generator gave the verdict stopped"],
      [{ generator: "JSON.stringify = () => ({ replace: () => ({ length: -1 }) }); export default () => [];" }, "draw generator did not return"],
      [{ generator: `JSON.stringify = () => ({ replace: () => ({ length: ${OUTPUT_BYTES + 1} }) }); export default () => [];` }, "draw generator did not return"],
      [{ generator: "JSON.stringify = () => ({ replace: () => ({ length: 3, slice: () => 7 }) }); export default () => [];" }, "draw generator did not return"],
      [{ generator: "const generate = () => [];" }, "draw generator has 0 default exports, not one"],
      [{ checker: "export default () => { throw new Error('broken'); };" }, "draw checker gave the verdict threw"],
      [{ checker: "export default () => 'yes';" }, "draw checker returned something other than true or false"],
    ] as const) {
      const j = await job(CORRECT, drawSpec(draw));
      const refused = await cli(judging(j, "--yes"), { "judge.json": j.judge });
      expect(refused.code, said).toBe(EXIT_FAILED);
      expect(refused.err, said).toContain(said);
      expect(refused.err, said).toContain("the spec is at fault, not the worker, and nothing was paid");
      expect(refused.out, said).toBe("");
      expect(status(j.intent), said).toBe(IntentStatus.Open);
    }
  }, 120_000);

  it("waits until a block at or after the announcement's slot plus k is finalized", async () => {
    const j = await job(CORRECT, drawSpec(), { blocks: [null, null, { slot: ANNOUNCED + BigInt(K), blockhash: BLOCKHASH }] });
    h.rounds = 10;
    const judged = await cli(judging(j), { "judge.json": j.judge });
    expect([judged.code, judged.err]).toEqual([EXIT_OK, ""]);
    expect(h.sleeps).toEqual([DRAW_POLL_SECONDS, DRAW_POLL_SECONDS]);
    expect(j.asked).toEqual([ANNOUNCED + BigInt(K), ANNOUNCED + BigInt(K), ANNOUNCED + BigInt(K)]);
    expect(judged.json()).toMatchObject({ drawn: { slot: Number(ANNOUNCED) + K, blockhash: BLOCKHASH } });
  });

  it("refuses when it stops waiting, when nobody announced the work, or when the node cannot read finalized blocks", async () => {
    const waiting = await job(CORRECT, drawSpec(), { blocks: [null] });
    const stopped = await cli(judging(waiting, "--yes"), { "judge.json": waiting.judge });
    expect([stopped.code, stopped.err]).toEqual([EXIT_FAILED, expect.stringContaining(stoppedWaiting(ANNOUNCED + BigInt(K)))]);
    expect(h.sleeps).toEqual([DRAW_POLL_SECONDS]);
    expect(status(waiting.intent)).toBe(IntentStatus.Open);
    const silent = await job(CORRECT, drawSpec(), { announced: false });
    const unannounced = await cli(judging(silent, "--yes", "--pay-to", silent.worker.address), { "judge.json": silent.judge });
    expect([unannounced.code, unannounced.err]).toEqual([EXIT_FAILED, expect.stringContaining(notAnnounced(silent.sha256, silent.intent))]);
    expect(status(silent.intent)).toBe(IntentStatus.Open);
    const blind = await job(CORRECT, drawSpec(), { finalized: false });
    const refused = await cli(judging(blind, "--yes"), { "judge.json": blind.judge });
    expect([refused.code, refused.err]).toEqual([EXIT_FAILED, expect.stringContaining(noBlocks)]);
    expect(status(blind.intent)).toBe(IntentStatus.Open);
  });

  it("judges a spec without draw exactly as before, without reading a block", async () => {
    const j = await job(CORRECT, specOf({ cases: PUBLISHED }));
    expect("draw" in casesOf(new TextEncoder().encode(specOf({ cases: PUBLISHED })))).toBe(false);
    const judged = await cli(judging(j), { "judge.json": j.judge });
    expect([judged.code, judged.err]).toEqual([EXIT_OK, ""]);
    expect(judged.json()).toMatchObject({ verdict: "pass", cases: { total: 3, passed: 3 } });
    expect("drawn" in judged.json()).toBe(false);
    expect(j.asked).toEqual([]);
  });

  it("refuses a draw it cannot trust before reading anything", () => {
    for (const [draw, said] of [
      [{ count: 0 }, "has a draw count 0, which is not a whole number from 1 to 10000"],
      [{ count: 10_001 }, "has a draw count 10001"],
      [{ k: 0 }, "has a draw k 0, which is not a whole number from 1 to 100000"],
      [{ k: 1.5 }, "has a draw k 1.5"],
      [{ generator: " " }, "has a draw generator that is not the source of a module"],
      [{ checker: 7 }, "has a draw checker that is not the source of a module"],
      [{ seeds: 1 }, 'has a draw field "seeds" it does not know'],
    ] as const) {
      expect(() => casesOf(new TextEncoder().encode(drawSpec(draw as Partial<Draw>))), said).toThrow(said);
    }
    expect(() => casesOf(new TextEncoder().encode(specOf({ cases: PUBLISHED, draw: [] })))).toThrow("has a draw that is not a JSON object");
    expect(casesOf(new TextEncoder().encode(drawSpec())).draw).toEqual({ count: DRAWN, generator: GENERATOR, checker: CHECKER, k: K });
  });
});
