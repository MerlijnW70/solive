import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { findAssociatedTokenAddress, Kind } from "@intent-engine/core";
import { getIntentDecoder, specMemo } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { main } from "../src/main.js";
import type { Runtime } from "../src/runtime.js";
import { announced, keyed } from "./announce.js";
import { balance, creation, h, NOW, ownerSigned, runtime, transport, world } from "./harness.js";

const CASES = '{"cases": [{"args": [""], "expected": 0}, {"args": ["one two"], "expected": 2}]}';
export const SPEC = "# Count words\n\n```judge-cases\n" + CASES + "\n```\n";
export const CORRECT = "export default function count(text) { const words = text.match(/\\S+/g); return words === null ? 0 : words.length; }\n";
export const SPEC_URL = "https://" + "specs.example.org/count/SPEC.md";

export const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");

async function unfunded(path: string): Promise<KeyPairSigner> {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const keypair = Uint8Array.from([...Buffer.from(jwk.d ?? "", "base64url"), ...Buffer.from(jwk.x ?? "", "base64url")]);
  const signer = await createKeyPairSignerFromBytes(keypair);
  h.keypairs.set(signer.address, keypair);
  h.files.set(path, JSON.stringify(Array.from(keypair)));
  return signer;
}

export type Job = { owner: Address; mint: Address; judge: KeyPairSigner; worker: KeyPairSigner; intent: Address; spec: string; work: string; url: string };

export async function job(options: { specUrl?: string; broke?: boolean; specText?: string; before?: () => void } = {}): Promise<Job> {
  const w = await world();
  const specText = options.specText ?? SPEC;
  const judge = options.broke === true ? await unfunded("judge.json") : await keyed("judge.json");
  const dir = await mkdtemp(join(tmpdir(), "judge-watch-faults-"));
  const spec = join(dir, "spec.md");
  await writeFile(spec, specText);
  const work = join(dir, "count.mjs");
  await writeFile(work, CORRECT);
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: new Uint8Array(createHash("sha256").update(specText).digest()), judgeFee: 0n } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({
    signer: w.owner,
    params,
    inputMint: w.inputMint,
    outputMint: w.outputMint,
    nonce: 0n,
    expiresAt: NOW + 3_600n,
  });
  if (options.specUrl !== undefined) {
    h.engineLog = [{ ...creation(intent), ...ownerSigned(intent, [specMemo(options.specUrl)]) }];
  }
  const worker = await keyed();
  const url = ["https://work.example.org", "faults", sha(CORRECT).slice(0, 8), "count.mjs"].join("/");
  h.specPages.set(url, new TextEncoder().encode(CORRECT));
  options.before?.();
  await announced(intent, worker, sha(CORRECT), url);
  return { owner: w.owner.address, mint: w.inputMint, judge, worker, intent, spec, work, url };
}

export const once = (j: Job, ...more: string[]) => ["judge", "--keypair", "judge.json", "--owner", j.owner, "--nonce", "0", "--spec", j.spec, ...more];

export const viperWatch = (j: Job) => [...once(j), "--sandbox", "viper", "--yes", "--watch"];

export type Run = { rounds?: number; asleep?: (slept: number) => void };

export async function run(argv: string[], { rounds = 10, asleep }: Run = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const fetches: { url: string; round: number }[] = [];
  let slept = 0;
  const base = runtime({});
  const rt: Runtime = {
    ...base,
    specFetch: async (url, init) => {
      fetches.push({ url, round: slept });
      return base.specFetch(url, init);
    },
    sleep: async (_seconds, stop) => {
      slept += 1;
      asleep?.(slept);
      return slept < rounds && stop?.aborted !== true;
    },
  };
  const code = await main(argv, rt, { out: (t) => out.push(t), err: (t) => err.push(t) });
  const roundsOf = (url: string) => fetches.filter((one) => one.url === url).map((one) => one.round);
  return { code, err: err.join("\n"), lines: out.map((o) => JSON.parse(o) as Record<string, unknown>), slept, roundsOf };
}

export const status = (intent: Address) => {
  const account = h.svm.getAccount(intent);
  return account.exists ? getIntentDecoder().decode(account.data).status : undefined;
};

export const paidTo = async (j: Job) => balance(await findAssociatedTokenAddress({ owner: j.worker.address, mint: j.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }));

export const quietly = async <T>(body: () => Promise<T>): Promise<T> => {
  const others = process.listeners("SIGINT");
  process.removeAllListeners("SIGINT");
  try {
    return await body();
  } finally {
    for (const listener of others) {
      process.on("SIGINT", listener);
    }
  }
};
