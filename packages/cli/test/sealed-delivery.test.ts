import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, createKeyPairSignerFromBytes, generateKeyPairSigner, type KeyPairSigner, lamports } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { deliveryCommitment, deliveryMemoV2, findAssociatedTokenAddress, getIntentDecoder, IntentStatus, Kind, sealUrl, sortMembers } from "@intent-engine/core";
import { createClient, type EngineTransaction } from "@intent-engine/client";
import { SEALED_ELSEWHERE } from "../src/judge-watch.js";
import { VOTE_NEXT } from "../src/judge.js";
import { EXIT_OK, main } from "../src/main.js";
import { balance, cli, creation, funded, h, NOW, runtime, transport, type World, world } from "./harness.js";

const CASES = '{"cases": [{"args": [""], "expected": 0}, {"args": ["one two"], "expected": 2}]}';
const SPEC = `# Count words\n\n\`\`\`judge-cases\n${CASES}\n\`\`\`\n`;
const CORRECT = "export default function count(text) { const words = text.match(/\\S+/g); return words === null ? 0 : words.length; }\n";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

async function keyed(): Promise<{ signer: KeyPairSigner; keypair: Uint8Array }> {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const keypair = Uint8Array.from([...Buffer.from(jwk.d ?? "", "base64url"), ...Buffer.from(jwk.x ?? "", "base64url")]);
  const signer = await createKeyPairSignerFromBytes(keypair);
  h.svm.airdrop(signer.address, lamports(100_000_000_000n));
  return { signer, keypair };
}

async function escrow(w: World, attestor: Address, judgeFee = 0n) {
  const dir = await mkdtemp(join(tmpdir(), "sealed-"));
  const spec = join(dir, "spec.md");
  await writeFile(spec, SPEC);
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor, specHash: new Uint8Array(createHash("sha256").update(SPEC).digest()), judgeFee } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  h.engineLog = [creation(intent)];
  return { dir, spec, intent };
}

async function sealedMemo(intent: Address, worker: Address, module: string, url: string, sealedTo: readonly Address[]): Promise<string> {
  h.specPages.set(url, new TextEncoder().encode(module));
  const commitment = await deliveryCommitment({ intent, worker, sha256: sha(module) });
  return deliveryMemoV2({ intent, commitment, blob: await sealUrl(url, sealedTo, intent) });
}

function landed(signature: string, slot: bigint, memo: string, feePayer: Address): void {
  const tx: EngineTransaction = { signature, slot, blockTime: null, failed: false, emitted: [], memos: [memo], feePayer };
  h.engineLog = [tx, ...h.engineLog];
}

const paidTo = async (mint: Address, worker: Address) => balance(await findAssociatedTokenAddress({ owner: worker, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }));

async function watch(argv: string[], rounds = 2) {
  const out: string[] = [];
  const err: string[] = [];
  const fetched: string[] = [];
  const base = runtime({});
  let slept = 0;
  const code = await main(
    argv,
    {
      ...base,
      specFetch: async (url, init) => {
        fetched.push(url);
        return base.specFetch(url, init);
      },
      sleep: async () => {
        slept += 1;
        return slept < rounds;
      },
    },
    { out: (t) => out.push(t), err: (t) => err.push(t) },
  );
  return { code, err: err.join("\n"), lines: out.map((o) => JSON.parse(o) as Record<string, unknown>), fetched };
}

describe("sealed announcements", () => {
  it("judge --watch opens the url with its key, fails a copy landed earlier from another wallet and pays the honest worker", async () => {
    const w = await world();
    const judge = await keyed();
    const { spec, intent } = await escrow(w, judge.signer.address);
    h.files.set("judge.json", JSON.stringify(Array.from(judge.keypair)));
    const worker = await generateKeyPairSigner();
    const copier = await generateKeyPairSigner();
    const url = ["https://work.example.org", "5", "count.mjs"].join("/");
    const memo = await sealedMemo(intent, worker.address, CORRECT, url, [judge.signer.address]);
    landed("copied", 4n, memo, copier.address);
    landed("honest", 5n, memo, worker.address);
    const watched = await watch(["judge", "--keypair", "judge.json", "--owner", w.owner.address, "--nonce", "0", "--spec", spec, "--sandbox", "viper", "--watch", "--yes"]);
    expect([watched.code, watched.err]).toEqual([EXIT_OK, ""]);
    expect(watched.fetched).toEqual([url, url]);
    expect(watched.lines[0]).toEqual({
      url,
      worker: copier.address,
      announced: "copied",
      artifactSha256: "",
      verdict: "fail",
      reason: `the work at ${url} has sha256 ${sha(CORRECT)}, which the commitment ${memo.split(":")[2] ?? ""} of ${copier.address} does not bind; it is not judged again`,
    });
    expect(watched.lines[1]).toMatchObject({ url, worker: worker.address, announced: "honest", verdict: "pass", payTo: worker.address, signature: expect.any(String) });
    expect(watched.lines[2]).toEqual({ stopped: "paid", intent, judged: 2 });
    expect(await paidTo(w.inputMint, worker.address)).toBeGreaterThan(0n);
    expect(await paidTo(w.inputMint, copier.address)).toBe(-1n);
  }, 60_000);

  it("judge --watch reports an announcement sealed to other wallets and judges nothing from it", async () => {
    const w = await world();
    const judge = await keyed();
    const { spec, intent } = await escrow(w, judge.signer.address);
    h.files.set("judge.json", JSON.stringify(Array.from(judge.keypair)));
    const worker = await generateKeyPairSigner();
    const url = ["https://work.example.org", "5", "count.mjs"].join("/");
    landed("elsewhere", 5n, await sealedMemo(intent, worker.address, CORRECT, url, [worker.address]), worker.address);
    const watched = await watch(["judge", "--keypair", "judge.json", "--owner", w.owner.address, "--nonce", "0", "--spec", spec, "--sandbox", "viper", "--watch", "--yes"]);
    expect(watched.fetched).toEqual([]);
    expect(watched.lines).toEqual([
      { url: "", worker: worker.address, announced: "elsewhere", artifactSha256: "", verdict: "fail", reason: `the work at announcement elsewhere ${SEALED_ELSEWHERE}; it is not judged again` },
      { stopped: "ended", intent, judged: 1 },
    ]);
    const account = h.svm.getAccount(intent);
    expect(account.exists ? getIntentDecoder().decode(account.data).status : undefined).toBe(IntentStatus.Open);
  }, 60_000);

  it("deliveries lists sealed announcements and opens their urls only with the judge's key", async () => {
    const w = await world();
    const judge = await keyed();
    const { intent } = await escrow(w, judge.signer.address);
    h.files.set("judge.json", JSON.stringify(Array.from(judge.keypair)));
    const worker = await generateKeyPairSigner();
    const url = "https://example.org/count.mjs";
    const memo = await sealedMemo(intent, worker.address, CORRECT, url, [judge.signer.address]);
    landed("honest", 5n, memo, worker.address);
    const listedOne = { worker: worker.address, commitment: memo.split(":")[2], signature: "honest", slot: "5" };
    const listed = await cli(["deliveries", "--attestor", judge.signer.address, "--intent", intent], {});
    expect([listed.code, listed.err]).toEqual([EXIT_OK, ""]);
    expect(listed.json()).toEqual({ intent, complete: true, deliveries: [listedOne] });
    expect(listed.out).not.toContain("example.org");
    const opened = await cli(["deliveries", "--attestor", judge.signer.address, "--intent", intent, "--judge-keypair", "judge.json"], {});
    expect(opened.json()).toEqual({ intent, complete: true, deliveries: [{ ...listedOne, url }] });
  }, 60_000);

  it("a committee member's vote pays the worker whose commitment matches, not a copier that landed the same memo first", async () => {
    const w = await world();
    const members = await Promise.all([0, 1, 2].map(() => funded()));
    const payer = await funded();
    const keys: Record<string, KeyPairSigner> = { "payer.json": payer };
    members.forEach((m, i) => (keys[`m${i}.json`] = m));
    const addresses = sortMembers(members.map((m) => m.address));
    const created = await cli(["committee", "create", "--keypair", "payer.json", "--members", addresses.join(","), "--threshold", "2", "--fee-wallet", payer.address, "--yes"], keys);
    const committee = created.json()["committee"] as Address;
    const { dir, spec, intent } = await escrow(w, committee);
    const artifact = join(dir, "count.mjs");
    await writeFile(artifact, CORRECT);
    const worker = await generateKeyPairSigner();
    const copier = await generateKeyPairSigner();
    const memo = await sealedMemo(intent, worker.address, CORRECT, "https://example.org/count.mjs", addresses);
    landed("copied", 4n, memo, copier.address);
    landed("honest", 5n, memo, worker.address);
    const judged = await cli(
      ["judge", "--keypair", "m0.json", "--owner", w.owner.address, "--nonce", "0", "--spec", spec, "--artifact", artifact, "--sandbox", "viper", "--verdict", join(dir, "v0.json")],
      keys,
    );
    expect([judged.code, judged.err]).toEqual([EXIT_OK, ""]);
    expect(judged.json()).toMatchObject({ verdict: "pass", payTo: worker.address, committee, next: VOTE_NEXT });
    const forced = await cli(
      ["judge", "--keypair", "m1.json", "--owner", w.owner.address, "--nonce", "0", "--spec", spec, "--artifact", artifact, "--sandbox", "viper", "--pay-to", copier.address],
      keys,
    );
    expect(forced.err).toContain(`${worker.address} announced the artifact with sha256 ${sha(CORRECT)} first, in honest; it is paid, not --pay-to ${copier.address}`);
  }, 60_000);
});
