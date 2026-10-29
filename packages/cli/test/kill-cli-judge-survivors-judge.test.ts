import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, KeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { Kind } from "@intent-engine/core";
import { getAnnouncementDecoder, getAnnouncementEncoder } from "@intent-engine/core/internal";
import type { Transport } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { NOBODY_ANNOUNCED } from "../src/announcement-views.js";
import { EXIT_FAILED, main } from "../src/main.js";
import type { Runtime } from "../src/runtime.js";
import { announced, keyed } from "./announce.js";
import { cli, h, NOW, runtime, transport, type World, world } from "./harness.js";

const CASES = '{"cases": [{"args": [""], "expected": 0}, {"args": ["one two"], "expected": 2}]}';
const SPEC = `# Count words\n\n\`\`\`judge-cases\n${CASES}\n\`\`\`\n`;
const WRONG = "export default function count(text) { return text.split(' ').length; }\n";
const ALSO_WRONG = "export default function count(text) { return text.length; }\n";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

type Job = { w: World; judge: KeyPairSigner; intent: Address; dir: string; spec: string };

async function job(spec: string): Promise<Job> {
  const w = await world();
  const judge = await keyed("judge.json");
  const dir = await mkdtemp(join(tmpdir(), "kill-judge-"));
  const path = join(dir, "spec.md");
  await writeFile(path, spec);
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: new Uint8Array(createHash("sha256").update(spec).digest()), judgeFee: 0n } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({
    signer: w.owner,
    params,
    inputMint: w.inputMint,
    outputMint: w.outputMint,
    nonce: 0n,
    expiresAt: NOW + 3_600n,
  });
  return { w, judge, intent, dir, spec: path };
}

let urls = 0;

async function announce(j: Job, worker: KeyPairSigner, module: string): Promise<Address> {
  urls += 1;
  const url = ["https://work.example.org", "kill", String(urls), "count.mjs"].join("/");
  h.specPages.set(url, new TextEncoder().encode(module));
  return (await announced(j.intent, worker, sha(module), url)).announcement;
}

const sameSeq: Transport = {
  ...transport,
  engineAccounts: async (filter) =>
    (await (transport.engineAccounts?.(filter) ?? Promise.resolve([]))).map((account) => {
      try {
        const stored = getAnnouncementDecoder().decode(account.data);
        return { ...account, data: new Uint8Array(getAnnouncementEncoder().encode({ ...stored, seq: 1n })) };
      } catch {
        return account;
      }
    }),
};

describe("judge --watch with two announcements of one seq", () => {
  it("judges them in the order the node listed them", async () => {
    const j = await job(SPEC);
    const first = await announce(j, await keyed(), WRONG);
    const second = await announce(j, await keyed(), ALSO_WRONG);
    const listed = (await createClient({ url: "http://cluster", transport: sameSeq }).announcementsTo(j.judge.address)).announcements.map(({ address }) => address);
    expect([...listed].sort()).toStrictEqual([first, second].sort());
    const out: string[] = [];
    const base = { ...runtime({ "judge.json": j.judge }), transport: () => sameSeq };
    const rt: Runtime = { ...base, sleep: async () => false };
    const argv = ["judge", "--keypair", "judge.json", "--owner", j.w.owner.address, "--nonce", "0", "--spec", j.spec, "--sandbox", "viper", "--watch", "--yes"];
    await main(argv, rt, { out: (t) => out.push(t), err: () => undefined });
    const judged = out.map((text) => JSON.parse(text) as Record<string, unknown>).filter((entry) => "announcement" in entry);
    expect(judged.map((entry) => [entry["announcement"], entry["seq"]])).toStrictEqual(listed.map((address) => [address, "1"]));
  });
});

describe("judge refusing an artifact no announcement opens to", () => {
  it("says the announcements do not open to the work, not that nobody announced", async () => {
    const spec = "answer.txt holds 42\n";
    const j = await job(spec);
    const artifact = join(j.dir, "answer.txt");
    await writeFile(artifact, "42\n");
    await announced(j.intent, await keyed(), sha("41\n"));
    const run = await cli(
      ["judge", "--keypair", "judge.json", "--owner", j.w.owner.address, "--nonce", "0", "--spec", j.spec, "--artifact", artifact, "--run", "true", "--sandbox", "none", "--i-trust-this-work", "--yes"],
      { "judge.json": j.judge },
    );
    expect(run.code).toBe(EXIT_FAILED);
    expect(run.err).toContain("no announcement opens to this work; its worker announces it first with deliver");
    expect(run.err).not.toContain(NOBODY_ANNOUNCED);
  });
});
