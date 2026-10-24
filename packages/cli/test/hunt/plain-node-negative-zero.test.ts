import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Address, KeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { Kind } from "@intent-engine/core";
import { createClient } from "@intent-engine/client";
import { NODE_ENGINE } from "../../src/node-judge.js";
import { SANDBOX_IMAGE } from "../../src/sandbox.js";
import { casesOf } from "../../src/viper.js";
import { DOCKER_TEST } from "../docker-switch.js";
import { announced, keyed } from "../announce.js";
import { cli, funded, h, NOW, transport, type World, world } from "../harness.js";

const DELIVERY = [
  "export default function sign(x) {",
  "  if (Object.is(x, -0)) return 'negative zero';",
  "  if (x < 0) return 'negative';",
  "  if (x > 0) return 'positive';",
  "  return 'zero';",
  "}",
  "",
].join("\n");

const CASES = '{"seed": 5, "cases": [{"args": [-0], "expected": "negative zero"}, {"args": [0], "expected": "zero"}, {"args": [-1.5], "expected": "negative"}, {"args": [2], "expected": "positive"}]}';
const SPEC = `# Sign of a number\n\nReturn "negative zero", "negative", "zero" or "positive" for the number given.\n\n\`\`\`judge-cases\n${CASES}\n\`\`\`\n`;
const NAME = "sign.mjs";

type Job = { w: World; judge: KeyPairSigner; intent: Address; spec: string; artifact: string };

const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");

async function job(): Promise<Job> {
  const w = await world();
  const judge = await funded();
  const worker = await keyed();
  const dir = await mkdtemp(join(tmpdir(), "hunt-plain-node-"));
  const spec = join(dir, "SPEC.md");
  await writeFile(spec, SPEC);
  const artifact = join(dir, NAME);
  await writeFile(artifact, DELIVERY);
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: new Uint8Array(createHash("sha256").update(SPEC).digest()), judgeFee: 0n } as const;
  const client = createClient({ url: "http://cluster", transport });
  const { intent } = await client.createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  await announced(intent, worker, sha(DELIVERY), "https://" + "example.org/" + NAME);
  return { w, judge, intent, spec, artifact };
}

describe("plain Node engine and arguments that JSON keeps", () => {
  it("P-4: a correct delivery that tells a published -0 argument from 0 passes in Node 22 but fails a case in the plain Node engine", DOCKER_TEST, async () => {
    const j = await job();
    const published = casesOf(new TextEncoder().encode(SPEC)).cases;
    expect(Object.is(published[0]?.args[0], -0)).toBe(true);
    expect(process.versions.node.split(".")[0]).toBe("22");
    for (const { args, expected } of published) {
      const reference = execFileSync(
        process.execPath,
        ["--input-type=module", "-e", `const args = JSON.parse(process.argv[1]); process.stdout.write(JSON.stringify((await import(${JSON.stringify(pathToFileURL(j.artifact).href)})).default(...args)))`, `[${args.map((arg) => (Object.is(arg, -0) ? "-0" : JSON.stringify(arg))).join(",")}]`],
        { encoding: "utf8" },
      );
      expect(JSON.parse(reference)).toBe(expected);
    }
    const judged = await cli(["judge", "--keypair", "judge.json", "--owner", j.w.owner.address, "--nonce", "0", "--spec", j.spec, "--artifact", j.artifact, "--sandbox", "viper", "--plain-node"], { "judge.json": j.judge });
    const node = judged.json()["node"] as { engine: string; image: string; total: number; passed: number; failures: unknown[] };
    expect(node).toMatchObject({ engine: NODE_ENGINE, image: SANDBOX_IMAGE, total: published.length });
    expect(node.failures).toEqual([]);
    expect(node.passed).toBe(published.length);
  });
});
