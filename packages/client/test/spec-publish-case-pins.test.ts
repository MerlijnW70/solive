import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Transport } from "../src/index.js";
import {
  CASE_MS_MAX,
  CASE_MS_MIN,
  CASE_MS_RULE,
  casePinsPreflight,
  casePinsRead,
  MIRROR_OFF,
  NODE_CPUS_RULE,
  NODE_MEMORY_RULE,
  NODE_MIN_MEGABYTES,
  pinRefused,
  pinTwice,
  publishSpec,
  RUN_BLOCK_UNJUDGEABLE,
} from "../src/internal.js";

const bytesOf = (text: string) => new TextEncoder().encode(text);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const idle = {} as Transport;
const casesBlock = (fields: string) => `# Job\n\n\`\`\`judge-cases\n{${fields}"cases": [{"args": [1], "expected": 2}]}\n\`\`\`\n`;

describe("publishSpec preflight of the pins in a judge-cases block", () => {
  it("refuses a node_memory, case_ms or node_cpus that every judge would refuse, and uploads nothing", async () => {
    const bad: [string, unknown, string][] = [
      ["node_memory", "64m", NODE_MEMORY_RULE],
      ["node_memory", `${NODE_MIN_MEGABYTES - 1}m`, NODE_MEMORY_RULE],
      ["node_memory", 512, NODE_MEMORY_RULE],
      ["case_ms", CASE_MS_MIN - 1, CASE_MS_RULE],
      ["case_ms", CASE_MS_MAX + 1, CASE_MS_RULE],
      ["case_ms", 1500.5, CASE_MS_RULE],
      ["case_ms", "1000", CASE_MS_RULE],
      ["node_cpus", "0", NODE_CPUS_RULE],
      ["node_cpus", 1, NODE_CPUS_RULE],
      ["node_cpus", "1.505", NODE_CPUS_RULE],
    ];
    for (const [name, value, rule] of bad) {
      const text = casesBlock(`${JSON.stringify(name)}: ${JSON.stringify(value)}, `);
      const reason = `the spec's judge-cases block ${pinRefused(name, value, rule)}`;
      expect(casePinsPreflight(bytesOf(text)), name).toBe(reason);
      expect(await publishSpec(bytesOf(text), { transport: idle, mirror: null }), name).toEqual({ published: false, sha256: sha(text), reason: `${reason}; ${RUN_BLOCK_UNJUDGEABLE}` });
    }
    const twice = casesBlock('"case_ms": 500, "case_ms": 600, ');
    expect(await publishSpec(bytesOf(twice), { transport: idle, mirror: null })).toMatchObject({ published: false, reason: `the spec's judge-cases block ${pinTwice("case_ms")}; ${RUN_BLOCK_UNJUDGEABLE}` });
  });

  it("goes on as before for valid pins and reads them", async () => {
    const text = casesBlock('"node_memory": "256m", "case_ms": 500, "node_cpus": "0.5", ');
    expect(casePinsRead(bytesOf(text))).toEqual({ pins: { nodeMemory: "256m", caseMs: 500, nodeCpus: "0.5" } });
    expect(await publishSpec(bytesOf(text), { transport: idle, mirror: null })).toEqual({ published: false, sha256: sha(text), reason: MIRROR_OFF });
    const plain = casesBlock("");
    expect(casePinsRead(bytesOf(plain))).toEqual({ pins: {} });
    expect(await publishSpec(bytesOf(plain), { transport: idle, mirror: null })).toEqual({ published: false, sha256: sha(plain), reason: MIRROR_OFF });
  });
});
