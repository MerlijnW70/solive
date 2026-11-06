import { createHash } from "node:crypto";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { manifestSha256 } from "@intent-engine/core/internal";
import { artifactSha256, readArtifact } from "../src/artifact.js";
import { JudgeRefused } from "../src/judge-errors.js";
import {
  BOTH_BLOCKS,
  checkFilesSha256,
  CPUS_RULE,
  IMAGE_RULE,
  manyBlocks,
  MAX_PINNED_TIMEOUT,
  MAX_RUN_BYTES,
  MEMORY_RULE,
  NOT_UTF8,
  ODD_LINE_ENDS,
  pinnedRunOf,
  RUN_OVERHEAD_SECONDS,
  RUN_RULE,
  runProblem,
  runRead,
  TIMEOUT_RULE,
} from "../src/judge-run.js";
import { strayFence } from "../src/spec-blocks.js";
import { DOCKER_ASK_SECONDS, SANDBOX_IMAGE } from "../src/sandbox.js";
import { MAX_JUDGE_TIMEOUT } from "../src/command-builders.js";
import { casesOf } from "../src/viper.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const MINIMAL = { image: SANDBOX_IMAGE, run: "node check/check.mjs", timeout: 60 };
const HEX = "ab".repeat(32);
const specOf = (body: string, eol = "\n") => bytes(`# Job${eol}${eol}Count words.${eol}${eol}\`\`\`judge-run${eol}${body}${eol}\`\`\`${eol}`);
const block = (fields: object) => specOf(JSON.stringify(fields));
const blockRefusal = (why: string) => `the spec's judge-run block ${why}; nothing was run or paid`;
const specRefusal = (why: string) => `the spec ${why}; nothing was run or paid`;
const has = (name: string, value: unknown, rule: string) => blockRefusal(`has ${name} ${(JSON.stringify(value) ?? String(value)).slice(0, 80)}, which is not ${rule}`);
const lacks = (name: string, rule: string) => blockRefusal(`has no ${name}, which must be ${rule}`);

const refusalOf = (spec: Uint8Array): string => {
  try {
    pinnedRunOf(spec);
  } catch (error) {
    expect(error).toBeInstanceOf(JudgeRefused);
    return (error as Error).message;
  }
  return "accepted";
};

describe("the judge-run block parser", () => {
  it("reads nothing from a spec without a judge-run line, so it judges as today", () => {
    for (const spec of ["# Job\n\nNo block here.\n", '# Job\n\n```judge-cases\n{"cases": [{"args": [], "expected": 1}]}\n```\n', "# Job\n\nRun judge-run later, or ```js judge-runner```.\n"]) {
      expect(pinnedRunOf(bytes(spec)), spec).toBeUndefined();
      expect(runRead(bytes(spec)), spec).toStrictEqual({});
    }
  });

  it("accepts every field at its valid values and boundaries", () => {
    const table: [object, object][] = [
      [MINIMAL, MINIMAL],
      [{ ...MINIMAL, timeout: 1 }, { ...MINIMAL, timeout: 1 }],
      [{ ...MINIMAL, timeout: MAX_PINNED_TIMEOUT }, { ...MINIMAL, timeout: MAX_PINNED_TIMEOUT }],
      [{ ...MINIMAL, check_sha256: HEX }, { ...MINIMAL, checkSha256: HEX }],
      [{ ...MINIMAL, memory: "6m" }, { ...MINIMAL, memory: "6m" }],
      [{ ...MINIMAL, memory: "999999g" }, { ...MINIMAL, memory: "999999g" }],
      [{ ...MINIMAL, cpus: "0.01" }, { ...MINIMAL, cpus: "0.01" }],
      [{ ...MINIMAL, cpus: "999.99" }, { ...MINIMAL, cpus: "999.99" }],
      [{ ...MINIMAL, run: "x".repeat(MAX_RUN_BYTES) }, { ...MINIMAL, run: "x".repeat(MAX_RUN_BYTES) }],
      [{ ...MINIMAL, run: "set -e\nnode check/a.mjs\nnode check/b.mjs" }, { ...MINIMAL, run: "set -e\nnode check/a.mjs\nnode check/b.mjs" }],
      [{ cpus: "1.5", memory: "2g", check_sha256: HEX, timeout: 600, run: "true", image: SANDBOX_IMAGE }, { image: SANDBOX_IMAGE, run: "true", timeout: 600, checkSha256: HEX, memory: "2g", cpus: "1.5" }],
    ];
    for (const [fields, read] of table) {
      expect(pinnedRunOf(block(fields)), JSON.stringify(fields)).toEqual(read);
    }
    expect(MAX_PINNED_TIMEOUT).toBe(MAX_JUDGE_TIMEOUT - RUN_OVERHEAD_SECONDS);
    expect(RUN_OVERHEAD_SECONDS).toBe(DOCKER_ASK_SECONDS);
  });

  it("refuses every field at an invalid value, naming the field", () => {
    const { image: _image, ...noImage } = MINIMAL;
    const { run: _run, ...noRun } = MINIMAL;
    const { timeout: _timeout, ...noTimeout } = MINIMAL;
    const table: [object, string][] = [
      [noImage, lacks("image", IMAGE_RULE)],
      [noRun, lacks("run", RUN_RULE)],
      [noTimeout, lacks("timeout", TIMEOUT_RULE)],
      ...["node:22", SANDBOX_IMAGE.toUpperCase(), SANDBOX_IMAGE.replace(/[0-9a-f]{64}$/, "C".repeat(64)), ` ${SANDBOX_IMAGE}`, `${SANDBOX_IMAGE} `, SANDBOX_IMAGE.slice(0, -1), 7, null].map(
        (image): [object, string] => [{ ...MINIMAL, image }, has("image", image, IMAGE_RULE)],
      ),
      ...["", "   ", "\n\t", "true\0false", "echo \ud800", "x".repeat(MAX_RUN_BYTES + 1), 1, null, ["true"]].map((run): [object, string] => [
        { ...MINIMAL, run },
        has("run", run, RUN_RULE),
      ]),
      ...[0, -1, 1.5, "60", MAX_PINNED_TIMEOUT + 1, null, 1e300].map((timeout): [object, string] => [{ ...MINIMAL, timeout }, has("timeout", timeout, TIMEOUT_RULE)]),
      ...[HEX.toUpperCase(), HEX.slice(1), `${HEX}0`, null, 5].map((sha): [object, string] => [{ ...MINIMAL, check_sha256: sha }, has("check_sha256", sha, "a sha256 of 64 lowercase hex")]),
      ...["5m", "0m", "1024", "1G", " 1g", "1.5g", "1000000m", 512, null].map((memory): [object, string] => [{ ...MINIMAL, memory }, has("memory", memory, MEMORY_RULE)]),
      ...["0", "0.00", "1.234", "-1", "1000", " 1", 1, null].map((cpus): [object, string] => [{ ...MINIMAL, cpus }, has("cpus", cpus, CPUS_RULE)]),
      [{ ...MINIMAL, network: "host" }, blockRefusal('has a field "network" it does not know')],
      [{ ...MINIMAL, ...(JSON.parse('{"__proto__": 1}') as object) },blockRefusal('has a field "__proto__" it does not know')],
    ];
    for (const [fields, why] of table) {
      expect(refusalOf(block(fields)), JSON.stringify(fields)).toBe(why);
    }
  });

  it("refuses a field written twice, even through an escape, so no reader can take the other copy", () => {
    const base = JSON.stringify(MINIMAL).slice(0, -1);
    for (const body of [`${base}, "run": "true"}`, `${base}, "\\u0072un": "true"}`, `{"timeout": 1, ${base.slice(1)}}`]) {
      expect(refusalOf(specOf(body)), body).toMatch(/^the spec's judge-run block has the field "(run|timeout)" more than once; nothing was run or paid$/);
    }
    expect(pinnedRunOf(specOf(`${base}, "check_sha256": "${HEX}"}`))).toEqual({ ...MINIMAL, checkSha256: HEX });
    expect(pinnedRunOf(specOf(JSON.stringify({ ...MINIMAL, run: 'echo "\\"run\\": 1"' })))).toMatchObject({ run: 'echo "\\"run\\": 1"' });
  });

  it("refuses a block that is not one JSON object", () => {
    expect(refusalOf(specOf("{not json"))).toMatch(/^the spec's judge-run block is not JSON: /);
    expect(refusalOf(specOf("[1, 2]"))).toBe(blockRefusal("is not a JSON object"));
    expect(refusalOf(specOf('"run"'))).toBe(blockRefusal("is not a JSON object"));
    expect(refusalOf(specOf(""))).toMatch(/^the spec's judge-run block is not JSON: /);
  });

  it("refuses two blocks, both block kinds, and any judge-run fence written in another form", () => {
    const one = `\`\`\`judge-run\n${JSON.stringify(MINIMAL)}\n\`\`\`\n`;
    expect(refusalOf(bytes(`# Job\n\n${one}\n${one}`))).toBe(specRefusal(manyBlocks(2)));
    expect(refusalOf(bytes(`# Job\n\n${one}\n\`\`\`judge-cases\n{"cases": [{"args": [], "expected": 1}]}\n\`\`\`\n`))).toBe(specRefusal(BOTH_BLOCKS));
    expect(refusalOf(bytes(`# Job\n\n${one}\n  ~~~judge-cases\n{}\n~~~\n`))).toBe(specRefusal(BOTH_BLOCKS));
  });

  it("refuses a fence of either kind anywhere but on a plain top-level line, in every form a Markdown reader may still see as a block", () => {
    const BOM = "\uFEFF";
    for (const [kind, body] of [["judge-run", JSON.stringify(MINIMAL)], ["judge-cases", '{"cases": [{"args": [], "expected": 1}]}']] as const) {
      const one = `\`\`\`${kind}\n${body}\n\`\`\`\n`;
      const table: [string, number, number][] = [
        [`  \`\`\`${kind}\n${body}\n\`\`\`\n`, 1, 0],
        [`~~~${kind}\n${body}\n~~~\n`, 1, 0],
        [`\`\`\`\`${kind}\n${body}\n\`\`\`\`\n`, 1, 0],
        [`\`\`\`${kind.toUpperCase()}\n${body}\n\`\`\`\n`, 1, 0],
        [`\`\`\` ${kind}\n${body}\n\`\`\`\n`, 1, 0],
        [`\`\`\`${kind} json\n${body}\n\`\`\`\n`, 1, 0],
        [`\`\`\`${kind}\n${body}\n`, 1, 1],
        [`> \`\`\`${kind}\n> ${body}\n> \`\`\`\n`, 1, 0],
        [`- \`\`\`${kind}\n  ${body}\n  \`\`\`\n`, 1, 0],
        [`1. \`\`\`${kind}\n   ${body}\n   \`\`\`\n`, 1, 0],
        [`Intro.\n${BOM}\`\`\`${kind}\n${body}\n\`\`\`\n`, 1, 0],
        [`\`\`\`\`markdown\n${one}\`\`\`\`\n`, 1, 0],
        [`Use a \`\`\`${kind}\`\`\` block.\n`, 1, 0],
        [`${one}\n    \`\`\`${kind}\n{}\n    \`\`\`\n`, 2, 1],
      ];
      for (const [form, mentions, plain] of table) {
        const spec = bytes(`# Job\n\n${form}`);
        const why = specRefusal(strayFence(kind, mentions, plain));
        expect(refusalOf(spec), `${kind}: ${form}`).toBe(why);
        expect(runRead(spec), `${kind}: ${form}`).toStrictEqual({ judge_run_refused: why.replace("; nothing was run or paid", "") });
        if (kind === "judge-cases") {
          expect(() => casesOf(spec), form).toThrow(why);
        }
      }
      const plain = bytes(`# Job\n\n${one}`);
      const leading = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(one)]);
      if (kind === "judge-run") {
        expect(pinnedRunOf(leading)).toEqual(pinnedRunOf(plain));
        expect(pinnedRunOf(leading)).toEqual(MINIMAL);
      } else {
        expect(pinnedRunOf(leading)).toBeUndefined();
        expect(casesOf(leading)).toEqual(casesOf(plain));
      }
    }
  });

  it("reads a CRLF spec exactly as the same spec with LF line ends", () => {
    for (const fields of [MINIMAL, { ...MINIMAL, check_sha256: HEX, memory: "512m", cpus: "1.5", run: "node check/a.mjs && node check/b.mjs" }]) {
      const body = JSON.stringify(fields, null, 2);
      const lf = specOf(body);
      const crlf = specOf(body.replaceAll("\n", "\r\n"), "\r\n");
      expect(new TextDecoder().decode(crlf)).toContain("\r\n");
      expect(pinnedRunOf(crlf)).toEqual(pinnedRunOf(lf));
    }
    for (const fields of [{ ...MINIMAL, timeout: 0 }, { ...MINIMAL, extra: 1 }]) {
      const body = JSON.stringify(fields, null, 2);
      expect(refusalOf(specOf(body.replaceAll("\n", "\r\n"), "\r\n"))).toBe(refusalOf(specOf(body)));
    }
  });

  it("refuses a spec with a judge-run line that is not valid UTF-8, since readers could decode it differently", () => {
    const spec = Buffer.concat([Buffer.from("# Job \xff\n\n", "latin1"), Buffer.from(specOf(JSON.stringify(MINIMAL)))]);
    expect(refusalOf(spec)).toBe(specRefusal(NOT_UTF8));
    expect(pinnedRunOf(Buffer.from("# Job \xff no block\n", "latin1"))).toBeUndefined();
  });

  it("refuses a spec with a judge-run block and line ends that Markdown reads otherwise than the judge", () => {
    const json = JSON.stringify(MINIMAL);
    for (const separator of ["\r", "\u2028", "\u2029"]) {
      expect(refusalOf(bytes(`# Job${separator}\`\`\`judge-run\n${json}\n\`\`\`\n`)), JSON.stringify(separator)).toBe(specRefusal(ODD_LINE_ENDS));
      expect(refusalOf(bytes(`# Job\n\nText${separator}more.\n\n\`\`\`judge-run\n${json}\n\`\`\`\n`)), JSON.stringify(separator)).toBe(specRefusal(ODD_LINE_ENDS));
      expect(pinnedRunOf(bytes(`# Job${separator}no block\n`))).toBeUndefined();
    }
  });

  it("leaves judge-cases parsing exactly as it was", () => {
    const cases = bytes('# Job\n\n```judge-cases\n{"cases": [{"args": [], "expected": 1}], "cases": [{"args": [], "expected": 2}]}\n```\n');
    expect(casesOf(cases).cases).toEqual([{ args: [], expected: 2 }]);
    expect(() => casesOf(bytes('```judge-cases\n{"cases": [], "x": 1}\n```\n'))).toThrow('the spec\'s judge-cases block has a field "x" it does not know; nothing was run or paid');
  });

  it("shows what judge reads, or why it refuses, in one shape", () => {
    expect(runRead(block({ ...MINIMAL, check_sha256: HEX, memory: "512m" }))).toEqual({
      judge_run: { image: SANDBOX_IMAGE, run: MINIMAL.run, timeout: 60, memory: "512m", cpus: null, check_files_pinned: true, check_sha256: HEX },
    });
    expect(runRead(block({ ...MINIMAL, timeout: 0 }))).toStrictEqual({ judge_run_refused: `the spec's judge-run block has timeout 0, which is not ${TIMEOUT_RULE}` });
    expect(runProblem(block(MINIMAL))).toBeUndefined();
  });
});

const le64 = (n: number) => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(n));
  return out;
};

const byHand = (entries: [string, string][]) =>
  createHash("sha256")
    .update(Buffer.concat([...entries].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))).flatMap(([path, text]) => [le64(Buffer.byteLength(path)), Buffer.from(path), le64(Buffer.byteLength(text)), Buffer.from(text)])))
    .digest("hex");

const checkSha = async (path: string) => checkFilesSha256({ name: basename(path), read: await readArtifact(path) });

describe("check_sha256, the hash of the hidden check files as they are mounted", () => {
  it("is manifestSha256 over each file's path under /judge/check, its name included, as hash --artifact gives for a directory holding only the check", async () => {
    const root = await mkdtemp(join(tmpdir(), "check-sha-"));
    const holder = join(root, "holder");
    await mkdir(join(holder, "tests", "sub"), { recursive: true });
    await writeFile(join(holder, "tests", "a.mjs"), "export default 1;\n");
    await writeFile(join(holder, "tests", "sub", "b.sh"), "exit 0\n");
    await mkdir(join(holder, "tests", "node_modules"), { recursive: true });
    await writeFile(join(holder, "tests", "node_modules", "skipped.js"), "not hashed");
    const dir = join(holder, "tests");
    expect(await checkSha(dir)).toBe(byHand([["tests/a.mjs", "export default 1;\n"], ["tests/sub/b.sh", "exit 0\n"]]));
    expect(await checkSha(dir)).toBe(await artifactSha256(holder));
    const single = join(root, "one");
    await mkdir(single);
    await writeFile(join(single, "check.mjs"), "process.exit(0);\n");
    expect(await checkSha(join(single, "check.mjs"))).toBe(byHand([["check.mjs", "process.exit(0);\n"]]));
    expect(await checkSha(join(single, "check.mjs"))).toBe(await artifactSha256(single));
    expect(await checkSha(join(single, "check.mjs"))).toBe(await manifestSha256([{ path: "check.mjs", bytes: bytes("process.exit(0);\n") }]));
    expect(await checkSha(join(single, "check.mjs"))).not.toBe(await artifactSha256(join(single, "check.mjs")));
  });

  it("changes with a file's name, its bytes, or whether it sits in a directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "check-sha-"));
    const write = async (path: string, text: string) => {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, text);
      return path;
    };
    const base = await checkSha(await write(join(root, "a", "check.mjs"), "x"));
    expect(await checkSha(await write(join(root, "b", "check2.mjs"), "x"))).not.toBe(base);
    expect(await checkSha(await write(join(root, "c", "check.mjs"), "y"))).not.toBe(base);
    await write(join(root, "d", "check.mjs", "inner"), "x");
    expect(await checkSha(join(root, "d", "check.mjs"))).not.toBe(base);
    expect(await checkSha(await write(join(root, "e", "check.mjs"), "x"))).toBe(base);
  });

  it.skipIf(process.platform === "win32")("refuses check files that hold a symbolic link", async () => {
    const root = await mkdtemp(join(tmpdir(), "check-sha-"));
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "real.mjs"), "x");
    await symlink(join(root, "real.mjs"), join(root, "tests", "link.mjs"));
    await expect(checkSha(join(root, "tests"))).rejects.toThrow("the artifact holds link.mjs, which is neither a regular file nor a directory");
  });
});
