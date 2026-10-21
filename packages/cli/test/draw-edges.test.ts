import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Beacon, DETAIL_BYTES, drawnArguments, engineRun, judgeDraw } from "../src/draw.js";
import { type CaseResult, type Cases, CASES_FENCE, CLOCK_FROM, deadlineMissed, type Draw, MAX_ARGUMENTS, OUTPUT_BYTES, type Primitive, type Ran, runViper } from "../src/viper.js";

vi.mock("../src/viper.js", async (original) => {
  const actual = await original<typeof import("../src/viper.js")>();
  return { ...actual, runViper: vi.fn(actual.runViper) };
});

const VERDICTS = ["pass", "wrong", "not-primitive", "threw", "stopped", "no-module", "engine"];

type Role = "generator" | "answer" | "confirm" | "checker";
type Asked = { role: Role; cases: { args: Primitive[]; expected: Primitive }[] };

function decoded(input: Buffer): Asked {
  let at = 4 + 8 * 4;
  const u32 = () => ((at += 4), input.readUInt32LE(at - 4));
  const string = () => {
    const length = u32();
    at += length;
    return input.toString("utf8", at - length, at);
  };
  const value = (): Primitive => {
    const tag = input.readUInt8(at++);
    if (tag === 4) {
      at += 8;
      return input.readDoubleLE(at - 8);
    }
    return tag === 5 ? string() : [null, null, false, true][tag] ?? null;
  };
  const source = string();
  const cases = Array.from({ length: u32() }, () => ({ args: Array.from({ length: u32() }, value), expected: value() }));
  const role: Role = source.includes("const lists = judgeDrawEntry(") ? "generator" : source.includes("const held = judgeDrawEntry(") ? "checker" : cases.every(({ expected }) => expected === null) ? "answer" : "confirm";
  return { role, cases };
}

function encoded(results: CaseResult[]): Buffer {
  const parts: Buffer[] = [];
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    parts.push(b);
  };
  const string = (text: string) => {
    u32(Buffer.byteLength(text));
    parts.push(Buffer.from(text, "utf8"));
  };
  u32(1);
  parts.push(Buffer.from([0]));
  u32(results.length);
  for (const { verdict, detail } of results) {
    parts.push(Buffer.from([VERDICTS.indexOf(verdict)]));
    if (verdict === "wrong") {
      if (typeof detail === "number") {
        const b = Buffer.alloc(9);
        b.writeUInt8(4);
        b.writeDoubleLE(detail, 1);
        parts.push(b);
      } else if (typeof detail === "string") {
        parts.push(Buffer.from([5]));
        string(detail);
      } else {
        parts.push(Buffer.from([detail === null ? 1 : detail === false ? 2 : 3]));
      }
    } else if (verdict === "threw" || verdict === "no-module") {
      string(String(detail));
    }
  }
  return Buffer.concat(parts);
}

let roles: Role[] = [];

const engine = (reply: (asked: Asked) => CaseResult[] | Ran) => {
  vi.mocked(runViper).mockImplementation(async (_wasm, input) => {
    const asked = decoded(input);
    roles.push(asked.role);
    const answered = reply(asked);
    return Array.isArray(answered) ? { output: encoded(answered), exitCode: 0, timedOut: false, diagnostic: "" } : answered;
  });
};

const generating = (lists: unknown, { cases }: Asked): CaseResult[] => {
  const text = JSON.stringify(lists);
  return cases.map(({ args: [, , from] }) => ({ verdict: "wrong", detail: Number(from) < 0 ? text.length : text.slice(Number(from), Number(from) + DETAIL_BYTES) }));
};

type Judging = { lists: Primitive[][]; answer: (args: Primitive[]) => CaseResult; holds?: (answer: Primitive) => boolean; answerRun?: Ran };

const judging = ({ lists, answer, holds = () => true, answerRun }: Judging) =>
  engine((asked) => {
    if (asked.role === "generator") {
      return generating(lists, asked);
    }
    if (asked.role === "answer") {
      return answerRun ?? asked.cases.map(({ args }) => answer(args));
    }
    if (asked.role === "confirm") {
      return asked.cases.map(() => ({ verdict: "pass" }));
    }
    return asked.cases.map(({ args: [said] }) => (holds(said ?? null) ? { verdict: "pass" } : { verdict: "wrong", detail: false }));
  });

const WASM = Buffer.alloc(0);
const SEED = "ab".repeat(32);
const DRAW: Draw = { count: 2, generator: "export default () => [];", checker: "export default () => true;", k: 1 };
const budget = (draw: Draw = DRAW): Cases => ({ steps: 1_000, heap: 1_000, seed: undefined, clock: undefined, cases: [], draw });
const beacon = (draw: Draw = DRAW) => ({ slot: 7n, blockhash: "hash", seed: SEED, draw }) as Beacon;
const MODULE = new TextEncoder().encode("export default (x) => x;");
const LEFT = 30;
const recorded = { slot: 7, blockhash: "hash", seed: SEED };

const drawn = (draw: Draw = DRAW, seconds = LEFT) => drawnArguments(WASM, budget(draw), draw, SEED, seconds);
const judged = (draw: Draw = DRAW) => judgeDraw(WASM, MODULE, budget(draw), beacon(draw), () => LEFT, { seed: 1, clock: 0 });

const generatorRefused = (why: string) => `the spec's ${CASES_FENCE} draw generator ${why}; the spec is at fault, not the worker, and nothing was paid`;
const invalid = (count: number) => generatorRefused(`did not return ${count} lists of at most ${MAX_ARGUMENTS} JSON strings, numbers, booleans or nulls, in at most ${OUTPUT_BYTES} bytes of JSON`);

describe("the seed a draw runs the engine with", () => {
  it("maps the beacon's first 24 hex digits into the engine's seed and clock ranges", () => {
    expect(engineRun("f".repeat(64))).toStrictEqual({ seed: 1, clock: 1_836_106_310_655 });
    expect(engineRun("0".repeat(64))).toStrictEqual({ seed: 1, clock: CLOCK_FROM });
    expect(engineRun(`${"0".repeat(11)}2${"0".repeat(11)}3${"0".repeat(40)}`)).toStrictEqual({ seed: 3, clock: CLOCK_FROM + 3 });
  });
});

describe("drawing cases with the generator", () => {
  beforeEach(() => {
    roles = [];
    vi.mocked(runViper).mockClear();
  });

  it("runs no engine once the time is up", async () => {
    engine(() => ({ output: Buffer.alloc(0), exitCode: null, timedOut: true, diagnostic: "" }));
    await expect(drawn(DRAW, 0)).rejects.toMatchObject({ message: generatorRefused(`did not finish: ${deadlineMissed("the viper judge", 0)}`) });
    expect(roles).toEqual([]);
  });

  it("names the verdict a broken generator gave, with its detail when it has one", async () => {
    engine(() => [{ verdict: "stopped" }]);
    await expect(drawn()).rejects.toMatchObject({ message: generatorRefused("gave the verdict stopped") });
    engine(() => [{ verdict: "threw", detail: "Error: boom" }]);
    await expect(drawn()).rejects.toMatchObject({ message: generatorRefused('gave the verdict threw with "Error: boom"') });
  });

  it("refuses a length that is not a whole number of bytes from 0 up before reading anything, and reads a zero length back as empty JSON", async () => {
    for (const length of [5.5, -1]) {
      roles = [];
      engine(() => [{ verdict: "wrong", detail: length }]);
      await expect(drawn(), String(length)).rejects.toMatchObject({ message: invalid(2) });
      expect(roles, String(length)).toEqual(["generator"]);
    }
    roles = [];
    engine(({ cases }) => cases.map(() => ({ verdict: "wrong", detail: 0 })));
    await expect(drawn()).rejects.toMatchObject({ message: invalid(2) });
    expect(roles).toEqual(["generator", "generator"]);
  });

  it("reads lists of exactly the output limit, and refuses one byte more without reading it", async () => {
    const one = { ...DRAW, count: 1 };
    const fill = (bytes: number) => [["x".repeat(bytes - '[[""]]'.length)]];
    engine((asked) => generating(fill(OUTPUT_BYTES), asked));
    expect(await drawn(one)).toStrictEqual(fill(OUTPUT_BYTES));
    roles = [];
    engine((asked) => generating(fill(OUTPUT_BYTES + 1), asked));
    await expect(drawn(one)).rejects.toMatchObject({ message: invalid(1) });
    expect(roles).toEqual(["generator"]);
  }, 60_000);

  it("takes lists of exactly the argument limit", async () => {
    const full = [Array.from({ length: MAX_ARGUMENTS }, (_, n) => n), [1]];
    engine((asked) => generating(full, asked));
    expect(await drawn()).toStrictEqual(full);
    engine((asked) => generating([[...(full[0] ?? []), 0], [1]], asked));
    await expect(drawn()).rejects.toMatchObject({ message: invalid(2) });
  });
});

describe("judging a drawn delivery", () => {
  beforeEach(() => {
    roles = [];
    vi.mocked(runViper).mockClear();
  });

  const LISTS: Primitive[][] = [[0], [1]];

  it("names a crashed answer run once, and a stopped one on every case it reports", async () => {
    judging({ lists: LISTS, answer: () => ({ verdict: "pass" }), answerRun: { output: Buffer.alloc(0), exitCode: 1, timedOut: false, diagnostic: " broke \n" } });
    expect(await judged()).toStrictEqual({ ...recorded, total: 2, passed: 0, failures: [{ case: 0, verdict: "crashed", detail: "the judge process ended with exit code 1: broke" }] });
    judging({ lists: LISTS, answer: () => ({ verdict: "pass" }), answerRun: { output: Buffer.alloc(0), exitCode: null, timedOut: true, diagnostic: "" } });
    const detail = deadlineMissed("the viper judge", LEFT);
    expect(await judged()).toStrictEqual({ ...recorded, total: 2, passed: 0, failures: [{ case: 0, verdict: "stopped", detail }, { case: 1, verdict: "stopped" }] });
  });

  it("confirms only answers longer than the engine reports whole", async () => {
    const answers = ["a".repeat(DETAIL_BYTES - 4), 3];
    judging({ lists: LISTS, answer: ([n]) => ({ verdict: "wrong", detail: answers[Number(n)] ?? null }) });
    expect(await judged()).toStrictEqual({ ...recorded, total: 2, passed: 2, failures: [] });
    expect(roles).toEqual(["generator", "generator", "answer", "checker"]);
    roles = [];
    answers[0] = "a".repeat(DETAIL_BYTES - 3);
    expect(await judged()).toStrictEqual({ ...recorded, total: 2, passed: 2, failures: [] });
    expect(roles).toEqual(["generator", "generator", "answer", "confirm", "checker"]);
  });

  it("runs no checker when no case gave an answer, so a broken checker is never read", async () => {
    judging({ lists: LISTS, answer: () => ({ verdict: "threw", detail: "Error: no" }) });
    const failures = [0, 1].map((index) => ({ case: index, verdict: "threw", detail: "Error: no" }));
    expect(await judged({ ...DRAW, checker: "const nothing = 0;" })).toStrictEqual({ ...recorded, total: 2, passed: 0, failures });
    expect(roles).toEqual(["generator", "generator", "answer"]);
  });

  it("lists the failures in case order, whichever run found them", async () => {
    judging({ lists: LISTS, answer: ([n]) => (n === 1 ? { verdict: "threw", detail: "Error: no" } : { verdict: "wrong", detail: 5 }), holds: () => false });
    expect(await judged()).toStrictEqual({
      ...recorded,
      total: 2,
      passed: 0,
      failures: [
        { case: 0, verdict: "wrong", detail: 5 },
        { case: 1, verdict: "threw", detail: "Error: no" },
      ],
    });
  });
});
