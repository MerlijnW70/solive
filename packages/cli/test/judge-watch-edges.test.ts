import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { Kind } from "@intent-engine/core";
import { createClient, type Transport } from "@intent-engine/client";
import { EXIT_OK, main } from "../src/main.js";
import type { Runtime } from "../src/runtime.js";
import { announced, keyed } from "./announce.js";
import { h, NOW, runtime, setNow, transport, world } from "./harness.js";

const CASES = '{"cases": [{"args": [""], "expected": 0}, {"args": ["one two"], "expected": 2}]}';
const SPEC = `# Count words\n\n\`\`\`judge-cases\n${CASES}\n\`\`\`\n`;
const CORRECT = "export default function count(text) { const words = text.match(/\\S+/g); return words === null ? 0 : words.length; }\n";
const WRONG = "export default function count(text) { return text.split(' ').length; }\n";
const EXPIRES = NOW + 3_600n;

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

type Job = { owner: Address; judge: KeyPairSigner; intent: Address; spec: string };

async function job(): Promise<Job> {
  const w = await world();
  const judge = await keyed("judge.json");
  const spec = join(await mkdtemp(join(tmpdir(), "judge-watch-edges-")), "spec.md");
  await writeFile(spec, SPEC);
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: new Uint8Array(createHash("sha256").update(SPEC).digest()), judgeFee: 0n } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: EXPIRES });
  return { owner: w.owner.address, judge, intent, spec };
}

let urls = 0;

async function announce(j: Job, worker: KeyPairSigner, module: string): Promise<void> {
  urls += 1;
  const url = ["https://work.example.org", String(urls), "count.mjs"].join("/");
  h.specPages.set(url, new TextEncoder().encode(module));
  await announced(j.intent, worker, sha(module), url);
}

const judging = (j: Job) => ["judge", "--keypair", "judge.json", "--owner", j.owner, "--nonce", "0", "--spec", j.spec, "--sandbox", "viper", "--watch", "--yes"];

async function watch(j: Job, slept: (round: number) => void = () => undefined) {
  const out: string[] = [];
  const err: string[] = [];
  let rounds = 0;
  const rt: Runtime = {
    ...runtime({ "judge.json": j.judge }),
    sleep: async () => {
      rounds += 1;
      slept(rounds);
      return rounds < 3;
    },
  };
  const code = await main(judging(j), rt, { out: (t) => out.push(t), err: (t) => err.push(t) });
  const lines = out.map((o) => JSON.parse(o) as Record<string, unknown>);
  return { code, err: err.join("\n"), order: lines.map((l) => l["worker"] ?? l["stopped"]), last: lines.at(-1) };
}

describe("the order judge --watch judges deliveries in", () => {
  it("takes announcements in seq order, whichever work comes first", async () => {
    for (const correctFirst of [false, true]) {
      const j = await job();
      const [first, second] = [await keyed(), await keyed()];
      await announce(j, first, correctFirst ? CORRECT : WRONG);
      await announce(j, second, correctFirst ? WRONG : CORRECT);
      expect((await watch(j)).order, String(correctFirst)).toEqual(correctFirst ? [first.address, "paid"] : [first.address, second.address, "paid"]);
    }
  }, 60_000);
});

describe("judge --watch stops when the escrow is no longer open", () => {
  const closing = async (change: (j: Job) => void, read?: Transport["getAccount"]) => {
    const j = await job();
    await announce(j, await keyed(), WRONG);
    let changed = false;
    if (read !== undefined) {
      h.through = { ...transport, getAccount: async (address) => (changed && address === j.intent ? read(address) : transport.getAccount(address)) };
    }
    const watched = await watch(j, (round) => {
      if (round === 1) {
        changed = true;
        change(j);
      }
    });
    expect([watched.code, watched.err]).toEqual([EXIT_OK, ""]);
    return watched.last;
  };

  it("when its account is gone, owned by another program or empty", async () => {
    const other = (await generateKeyPairSigner()).address;
    for (const read of [
      async () => null,
      async (address: Address) => {
        const account = await transport.getAccount(address);
        return account === null ? null : { ...account, owner: other };
      },
      async (address: Address) => {
        const account = await transport.getAccount(address);
        return account === null ? null : { ...account, data: new Uint8Array() };
      },
    ] as Transport["getAccount"][]) {
      let intent: Address | undefined;
      const last = await closing((j) => {
        intent = j.intent;
      }, read);
      expect(last).toEqual({ stopped: "closed", intent, judged: 1 });
    }
  }, 60_000);

  it("the moment the chain clock reaches its expiry", async () => {
    let intent: Address | undefined;
    const last = await closing((j) => {
      intent = j.intent;
      setNow(EXPIRES);
    });
    expect(last).toEqual({ stopped: "closed", intent, judged: 1 });
  }, 60_000);
});
