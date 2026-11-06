import { createHash } from "node:crypto";
import type { Client } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it } from "vitest";
import type { Transport } from "@intent-engine/client";
import { MIRROR_OFF, publishSpec, RUN_BLOCK_UNJUDGEABLE } from "@intent-engine/client/internal";
import { pinnedRunOf, runProblem } from "../src/judge-run.js";
import { JudgeRefused } from "../src/judge-errors.js";
import { SANDBOX_IMAGE } from "../src/sandbox.js";
import { fresh, type Json, ok } from "./agent-wallet-kit.js";

const BLOCK = { image: SANDBOX_IMAGE, run: "node check/check.mjs", timeout: 60 };
const fenced = (body: string, fence = "judge-run") => "```" + fence + "\n" + body + "\n```\n";
const specWith = (...blocks: string[]) => `# Job\n\nCount words.\n\n${blocks.join("\n")}`;
const bytesOf = (text: string) => new TextEncoder().encode(text);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const BAD: Record<string, string> = {
  "a timeout of zero": specWith(fenced(JSON.stringify({ ...BLOCK, timeout: 0 }))),
  "an image without a digest": specWith(fenced(JSON.stringify({ ...BLOCK, image: "node:22" }))),
  "an unknown field": specWith(fenced(JSON.stringify({ ...BLOCK, shell: "bash" }))),
  "a second block": specWith(fenced(JSON.stringify(BLOCK)), fenced(JSON.stringify(BLOCK))),
  "a judge-cases block beside it": specWith(fenced(JSON.stringify(BLOCK)), fenced(JSON.stringify({ cases: [{ args: [1], expected: 1 }] }), "judge-cases")),
  "a block that is not JSON": specWith(fenced("run it")),
  "an indented fence": specWith("  " + fenced(JSON.stringify(BLOCK))),
};

const WELL_FORMED: Record<string, string> = {
  "no block": specWith(),
  "a valid block": specWith(fenced(JSON.stringify({ ...BLOCK, memory: "512m" }))),
  "a stray judge-cases fence the judge refuses": specWith("  " + fenced(JSON.stringify({ cases: [{ args: [1], expected: 1 }] }), "judge-cases")),
};

const nodeless = {} as Transport;

describe("a spec with a judge-run block no judge can run is refused before it is published, and hashing stays free", () => {
  let client: Client;

  beforeEach(async () => {
    client = await fresh();
  });

  it.each(Object.entries(BAD))("refuses %s in publishSpec with the reason judge gives, while solive_hash still hashes the text", async (_name, text) => {
    const problem = runProblem(bytesOf(text));
    expect(problem).toBeDefined();
    expect(() => pinnedRunOf(bytesOf(text))).toThrow(JudgeRefused);
    const published = await publishSpec(bytesOf(text), { transport: nodeless, mirror: null });
    expect(published).toEqual({ published: false, sha256: sha(text), reason: `${problem}; ${RUN_BLOCK_UNJUDGEABLE}` });
    const hashed: Json = await ok(client, "hash", { text });
    expect(hashed["sha256"]).toBe(sha(text));
  });

  it.each(Object.entries(WELL_FORMED))("leaves %s as it was in publishSpec and in solive_hash", async (_name, text) => {
    expect(await publishSpec(bytesOf(text), { transport: nodeless, mirror: null })).toEqual({ published: false, sha256: sha(text), reason: MIRROR_OFF });
    const hashed: Json = await ok(client, "hash", { text });
    expect(hashed["sha256"]).toBe(sha(text));
  });
});
