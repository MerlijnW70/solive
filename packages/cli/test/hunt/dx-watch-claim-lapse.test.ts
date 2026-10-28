import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, KeyPairSigner } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, IntentStatus, Kind } from "@intent-engine/core";
import { buildClaimJob, getIntentDecoder } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { EXIT_OK, main } from "../../src/main.js";
import type { Runtime } from "../../src/runtime.js";
import { announced, keyed } from "../announce.js";
import { balance, cli, h, NOW, runtime, send, setNow, transport, world } from "../harness.js";

const CASES = '{"cases": [{"args": [""], "expected": 0}, {"args": ["one two"], "expected": 2}]}';
const SPEC = "# Count words\n\n```judge-cases\n" + CASES + "\n```\n";
const CORRECT = "export default function count(text) { const words = text.match(/\\S+/g); return words === null ? 0 : words.length; }\n";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

type Claimed = { w: Awaited<ReturnType<typeof world>>; judge: KeyPairSigner; worker: KeyPairSigner; stranger: KeyPairSigner; intent: Address; spec: string };

async function claimedJob(): Promise<Claimed> {
  const w = await world();
  const judge = await keyed("judge.json");
  const dir = await mkdtemp(join(tmpdir(), "dx-watch-claim-"));
  const spec = join(dir, "spec.md");
  await writeFile(spec, SPEC);
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: new Uint8Array(createHash("sha256").update(SPEC).digest()), judgeFee: 0n } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({
    signer: w.owner,
    params,
    inputMint: w.inputMint,
    outputMint: w.outputMint,
    nonce: 0n,
    expiresAt: NOW + 3_600n,
  });
  const opened = await cli(["claims", "open", "--keypair", "owner.json", "--nonce", "0", "--max-secs", "3600", "--stake", "0.05", "--yes"], { "owner.json": w.owner });
  expect([opened.code, opened.err]).toEqual([EXIT_OK, ""]);
  const worker = await keyed();
  const url = ["https://work.example.org", "honest", "count.mjs"].join("/");
  h.specPages.set(url, new TextEncoder().encode(CORRECT));
  await announced(intent, worker, sha(CORRECT), url);
  const stranger = await keyed();
  await send(stranger, [await buildClaimJob({ worker: stranger, intent, owner: w.owner.address, secs: 600 })]);
  return { w, judge, worker, stranger, intent, spec };
}

const judging = (j: Claimed) => ["judge", "--keypair", "judge.json", "--owner", j.w.owner.address, "--nonce", "0", "--spec", j.spec, "--sandbox", "viper", "--yes"];

function settled(j: Claimed) {
  const account = h.svm.getAccount(j.intent);
  return account.exists ? getIntentDecoder().decode(account.data).status : undefined;
}

const paidTo = async (j: Claimed) => balance(await findAssociatedTokenAddress({ owner: j.worker.address, mint: j.w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }));

describe("judge --watch on a job that takes claims", () => {
  it("DX-1 never pays the first announcer of passing work once a stranger's claim on the job has lapsed", async () => {
    const j = await claimedJob();
    const out: string[] = [];
    let rounds = 0;
    const rt: Runtime = {
      ...runtime({ "judge.json": j.judge }),
      sleep: async (_seconds, stop) => {
        rounds += 1;
        setNow(NOW + 700n * BigInt(rounds));
        if (rounds === 1) {
          const again = ["https://work.example.org", "again", "count.mjs"].join("/");
          h.specPages.set(again, new TextEncoder().encode(CORRECT));
          await announced(j.intent, j.worker, sha(CORRECT), again);
        }
        return rounds < 4 && stop?.aborted !== true;
      },
    };
    const code = await main([...judging(j), "--watch"], rt, { out: (t) => out.push(t), err: () => undefined });
    const lines = out.map((o) => JSON.parse(o) as Record<string, unknown>);
    expect(code).toBe(EXIT_OK);
    expect(lines[0]).toMatchObject({ worker: j.worker.address, verdict: "retry", retry: true });
    expect(String(lines[0]?.["reason"])).toContain(j.stranger.address);
    expect({ status: settled(j), paid: (await paidTo(j)) > 0n, stopped: lines.at(-1)?.["stopped"] }).toEqual({ status: IntentStatus.Filled, paid: true, stopped: "paid" });
  }, 120_000);

  it("the same release is valid: judge run once after the claim lapsed pays the first announcer", async () => {
    const j = await claimedJob();
    const dir = await mkdtemp(join(tmpdir(), "dx-watch-artifact-"));
    const artifact = join(dir, "count.mjs");
    await writeFile(artifact, CORRECT);
    const refused = await cli([...judging(j), "--artifact", artifact], { "judge.json": j.judge });
    expect(refused.err).toContain(j.stranger.address);
    expect(settled(j)).toBe(IntentStatus.Open);
    setNow(NOW + 700n);
    const once = await cli([...judging(j), "--artifact", artifact], { "judge.json": j.judge });
    expect([once.code, once.err]).toEqual([EXIT_OK, ""]);
    expect(once.json()).toMatchObject({ verdict: "pass", payTo: j.worker.address, signature: expect.any(String) });
    expect(settled(j)).toBe(IntentStatus.Filled);
    expect(await paidTo(j)).toBeGreaterThan(0n);
  }, 120_000);
});
