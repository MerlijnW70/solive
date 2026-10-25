import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { IntentStatus, Kind } from "@intent-engine/core";
import { getIntentDecoder } from "@intent-engine/core/internal";
import type { Transport } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { type Beacon, judgeDraw } from "../../src/draw.js";
import { judgeHost } from "../../src/host-judge.js";
import { casesOf, type Draw, judgeViper, pinnedWasm } from "../../src/viper.js";
import { announced, keyed } from "../announce.js";
import { cli, funded, h, NOW, transport, world } from "../harness.js";

const GENERATOR = `export default function generate(seed, count) {
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(["port " + seed.slice(i % 48, (i % 48) + 6)]);
  return out;
}`;
const CHECKER = "export default (args, answer) => { const text = args[0]; const ok = /^[1-9][0-9]{0,4}$/.test(text) && Number(text) <= 65535; return answer === (ok ? Number(text) : null); };";
const DRAWN = 16;
const K = 2;
const ANNOUNCED = 5n;
const BLOCKHASH = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const PUBLISHED = [
  { args: ["80"], expected: 80 },
  { args: ["65535"], expected: 65535 },
  { args: ["8080"], expected: 8080 },
  { args: ["0"], expected: null },
  { args: ["65536"], expected: null },
  { args: ["abc"], expected: null },
  { args: [""], expected: null },
];
const CORRECT = "export default (text) => (/^[1-9][0-9]{0,4}$/.test(text) && Number(text) <= 65535 ? Number(text) : null);\n";
const TABLE = 'const table = { "80": 80, "65535": 65535, "8080": 8080, "0": null, "65536": null, "abc": null, "": null };\nexport default (text) => table[text];\n';
const SPEC = `# Parse a port\n\nReturn the port as a number, or null when the text is not a port.\n\n\`\`\`judge-cases\n${JSON.stringify({ cases: PUBLISHED, draw: { count: DRAWN, generator: GENERATOR, checker: CHECKER, k: K } })}\n\`\`\`\n`;

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const bytes = (text: string) => new TextEncoder().encode(text);

const status = (intent: Address) => {
  const account = h.svm.getAccount(intent);
  return account.exists ? getIntentDecoder().decode(account.data).status : undefined;
};

async function escrowed(module: string) {
  const w = await world();
  const judge = await funded();
  const worker = await keyed();
  const dir = await mkdtemp(join(tmpdir(), "hunt-js-drawn-"));
  const spec = join(dir, "spec.md");
  const artifact = join(dir, "port.mjs");
  await writeFile(spec, SPEC);
  await writeFile(artifact, module);
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: new Uint8Array(createHash("sha256").update(SPEC).digest()), judgeFee: 0n } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  h.svm.warpToSlot(ANNOUNCED - 1n);
  await announced(intent, worker, sha(module), "https://" + "example.org/port.mjs");
  const finalizedBlock = async () => ({ slot: ANNOUNCED + BigInt(K), blockhash: BLOCKHASH });
  h.through = { ...transport, finalizedBlock } as Transport;
  const argv = ["judge", "--keypair", "judge.json", "--owner", w.owner.address, "--nonce", "0", "--spec", spec, "--artifact", artifact, "--sandbox", "viper"];
  return { judge, intent, argv };
}

describe("drawn cases and answers that are not JSON values", () => {
  it("JS-3 a delivery that returns undefined is failed as a published case but passes the same input as a drawn case", async () => {
    const wasm = await pinnedWasm();
    const cases = casesOf(bytes(SPEC));
    const input = "port 1a2b3c";
    const published = { ...cases, cases: [{ args: [input], expected: null }] };
    const viper = await judgeViper(wasm, bytes(TABLE), published, 20, { seed: 1, clock: 0 });
    const host = await judgeHost(bytes(TABLE), published, 20, 1);
    expect([viper.passed, host.passed]).toEqual([0, 0]);
    const draw: Draw = { count: 1, generator: `export default () => [[${JSON.stringify(input)}]];`, checker: CHECKER, k: K };
    const beacon = { slot: ANNOUNCED + BigInt(K), blockhash: BLOCKHASH, seed: "ab".repeat(32), draw } as Beacon;
    const drawn = await judgeDraw(wasm, bytes(TABLE), { ...cases, draw }, beacon, () => 20, { seed: 1, clock: 0 });
    expect(drawn.passed).toBe(0);
  }, 60_000);

  it("JS-3 judge --yes pays a table of the published cases that answers undefined on every drawn case", async () => {
    const honest = await escrowed(CORRECT);
    const fair = await cli(honest.argv, { "judge.json": honest.judge });
    expect(fair.json()).toMatchObject({ verdict: "pass", drawn: { total: DRAWN, passed: DRAWN } });
    const table = await escrowed(TABLE);
    const judged = await cli([...table.argv, "--yes"], { "judge.json": table.judge });
    expect(judged.json()).toMatchObject({ cases: { total: PUBLISHED.length, passed: PUBLISHED.length }, host: { total: PUBLISHED.length, passed: PUBLISHED.length } });
    expect(status(table.intent)).toBe(IntentStatus.Open);
    expect(judged.json()["signature"]).toBeNull();
    expect(judged.json()["verdict"]).toBe("fail");
    expect(judged.json()["drawn"]).not.toMatchObject({ passed: DRAWN });
  }, 120_000);
});
