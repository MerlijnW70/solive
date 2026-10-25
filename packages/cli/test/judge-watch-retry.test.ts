import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, type KeyPairSigner, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, IntentStatus, Kind } from "@intent-engine/core";
import { buildClaimJob, getIntentDecoder } from "@intent-engine/core/internal";
import { type Transport } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { EXIT_OK, main } from "../src/main.js";
import { rpcFailed } from "../src/rpc-failure.js";
import type { Runtime } from "../src/runtime.js";
import { announced, keyed } from "./announce.js";
import { balance, cli, h, NOW, runtime, send, setNow, transport, world } from "./harness.js";

const CASES = '{"cases": [{"args": [""], "expected": 0}, {"args": ["one two"], "expected": 2}]}';
const SPEC = "# Count words\n\n```judge-cases\n" + CASES + "\n```\n";
const CORRECT = "export default function count(text) { const words = text.match(/\\S+/g); return words === null ? 0 : words.length; }\n";
const WRONG = "export default function count(text) { return text.split(' ').length; }\n";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

type Job = { w: Awaited<ReturnType<typeof world>>; judge: KeyPairSigner; worker: KeyPairSigner; intent: Address; spec: string };

async function job(module: string, claimed: boolean): Promise<Job & { stranger: KeyPairSigner | undefined }> {
  const w = await world();
  const judge = await keyed("judge.json");
  const dir = await mkdtemp(join(tmpdir(), "judge-watch-retry-"));
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
  let stranger: KeyPairSigner | undefined;
  if (claimed) {
    const opened = await cli(["claims", "open", "--keypair", "owner.json", "--nonce", "0", "--max-secs", "3600", "--stake", "0.05", "--yes"], { "owner.json": w.owner });
    expect([opened.code, opened.err]).toEqual([EXIT_OK, ""]);
  }
  const worker = await keyed();
  const url = ["https://work.example.org", "retry", sha(module).slice(0, 8), "count.mjs"].join("/");
  h.specPages.set(url, new TextEncoder().encode(module));
  await announced(intent, worker, sha(module), url);
  if (claimed) {
    stranger = await keyed();
    await send(stranger, [await buildClaimJob({ worker: stranger, intent, owner: w.owner.address, secs: 600 })]);
  }
  return { w, judge, worker, intent, spec, stranger };
}

const judging = (j: Job) => ["judge", "--keypair", "judge.json", "--owner", j.w.owner.address, "--nonce", "0", "--spec", j.spec, "--sandbox", "viper", "--yes", "--watch"];

async function watch(j: Job, rounds: number, step: bigint, through?: Transport) {
  const out: string[] = [];
  const err: string[] = [];
  let slept = 0;
  const base = runtime({ "judge.json": j.judge });
  const rt: Runtime = {
    ...base,
    ...(through === undefined ? {} : { transport: () => through }),
    sleep: async (_seconds, stop) => {
      slept += 1;
      setNow(NOW + step * BigInt(slept));
      return slept < rounds && stop?.aborted !== true;
    },
  };
  const code = await main(judging(j), rt, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, err: err.join("\n"), lines: out.map((o) => JSON.parse(o) as Record<string, unknown>), slept };
}

const status = (intent: Address) => {
  const account = h.svm.getAccount(intent);
  return account.exists ? getIntentDecoder().decode(account.data).status : undefined;
};

const paidTo = async (j: Job) => balance(await findAssociatedTokenAddress({ owner: j.worker.address, mint: j.w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }));

const unavailable = () =>
  new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers(), message: "Service Unavailable", statusCode: 503 });

describe("judge --watch on a refusal that can change", () => {
  it("prints a held claim once with retry: true while it lasts, judges the work again once it lapses, and pays once", async () => {
    const j = await job(CORRECT, true);
    const watched = await watch(j, 10, 250n);
    expect([watched.code, watched.err]).toEqual([EXIT_OK, ""]);
    expect(watched.slept).toBe(3);
    expect(watched.lines).toEqual([
      expect.objectContaining({ worker: j.worker.address, verdict: "fail", retry: true, artifactSha256: sha(CORRECT), reason: expect.stringContaining(`is claimed by ${j.stranger?.address}`) }),
      expect.objectContaining({ worker: j.worker.address, verdict: "pass", payTo: j.worker.address, signature: expect.any(String) }),
      { stopped: "paid", intent: j.intent, judged: 1 },
    ]);
    expect(watched.lines[1]).not.toHaveProperty("retry");
    expect(status(j.intent)).toBe(IntentStatus.Filled);
    expect(await paidTo(j)).toBeGreaterThan(0n);
  }, 120_000);

  it("keeps a failed check final and never judges that work again", async () => {
    const j = await job(WRONG, false);
    const watched = await watch(j, 3, 10n);
    expect(watched.code).toBe(EXIT_OK);
    expect(watched.lines).toEqual([expect.objectContaining({ worker: j.worker.address, verdict: "fail", signature: null }), { stopped: "ended", intent: j.intent, judged: 1 }]);
    expect(watched.lines[0]).not.toHaveProperty("retry");
    expect(status(j.intent)).toBe(IntentStatus.Open);
  }, 120_000);

  it("prints a round the RPC node failed once with retry: true, and pays once the node answers again", async () => {
    const j = await job(CORRECT, false);
    let failures = 2;
    const listing = transport.engineAccounts as NonNullable<Transport["engineAccounts"]>;
    const flaky: Transport = {
      ...transport,
      engineAccounts: async (filter) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("the request failed", { cause: unavailable() });
        }
        return listing(filter);
      },
    };
    const watched = await watch(j, 10, 10n, flaky);
    expect([watched.code, watched.err]).toEqual([EXIT_OK, ""]);
    expect(watched.lines).toEqual([
      { intent: j.intent, reason: "the request failed", retry: true },
      expect.objectContaining({ worker: j.worker.address, verdict: "pass", signature: expect.any(String) }),
      { stopped: "paid", intent: j.intent, judged: 1 },
    ]);
    expect(watched.slept).toBe(2);
    expect(status(j.intent)).toBe(IntentStatus.Filled);
  }, 120_000);

  it("tells an RPC failure from an error of the judge itself", () => {
    const unreached = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    expect([unavailable(), new TypeError("fetch failed", { cause: unreached }), new Error("wrapped", { cause: unavailable() })].map(rpcFailed)).toEqual([true, true, true]);
    expect([new Error("a bug"), new TypeError("x is undefined"), "text"].map(rpcFailed)).toEqual([false, false, false]);
  });
});
