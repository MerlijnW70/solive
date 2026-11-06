import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Transport } from "../src/index.js";
import { MIRROR_OFF, publishSpec, RUN_BLOCK_UNJUDGEABLE, runBlockProblem, TIMEOUT_RULE } from "../src/internal.js";

const IMAGE = "node:22-bookworm-slim@sha256:" + "ab".repeat(32);
const fenced = (body: object) => "```judge-run\n" + JSON.stringify(body) + "\n```\n";
const bytesOf = (text: string) => new TextEncoder().encode(text);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const idle = {} as Transport;

describe("publishSpec preflight of a judge-run block", () => {
  it("refuses a block no judge can run, with the reason, and uploads nothing", async () => {
    const text = `# Job\n\n${fenced({ image: IMAGE, run: "true", timeout: 0 })}`;
    const reason = `the spec's judge-run block has timeout 0, which is not ${TIMEOUT_RULE}`;
    expect(runBlockProblem(bytesOf(text))).toBe(reason);
    expect(await publishSpec(bytesOf(text), { transport: idle, mirror: null })).toEqual({ published: false, sha256: sha(text), reason: `${reason}; ${RUN_BLOCK_UNJUDGEABLE}` });
    expect(await publishSpec(bytesOf(text), { transport: idle, mirror: "https://" + "mirror.example", fetch: () => Promise.reject(new Error("no upload")) })).toMatchObject({ published: false, reason: `${reason}; ${RUN_BLOCK_UNJUDGEABLE}` });
  });

  it("goes on as before for a spec with no block and for a valid block", async () => {
    for (const text of ["# Job\n\nDeliver it.\n", `# Job\n\n${fenced({ image: IMAGE, run: "true", timeout: 60 })}`]) {
      expect(runBlockProblem(bytesOf(text))).toBeUndefined();
      expect(await publishSpec(bytesOf(text), { transport: idle, mirror: null })).toEqual({ published: false, sha256: sha(text), reason: MIRROR_OFF });
    }
  });
});
