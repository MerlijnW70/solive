import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, createSignableMessage, getBase58Decoder, type KeyPairSigner } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, Kind } from "@intent-engine/core";
import { announcementCommitment, buildAnnounceDelivery, deliverySecrets, saltMessage, sealDeliveryV4, sortMembers } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { svmTransport } from "@intent-engine/client/svm";
import { SEALED_ELSEWHERE } from "../src/judge-watch.js";
import { VOTE_NEXT } from "../src/judge.js";
import { EXIT_OK, main } from "../src/main.js";
import { balance, cli, DOMAIN, funded, h, NOW, runtime, transport, type World, world } from "./harness.js";
import { announced, keyed, nextSlot } from "./announce.js";

const CASES = '{"cases": [{"args": [""], "expected": 0}, {"args": ["one two"], "expected": 2}]}';
const SPEC = `# Count words\n\n\`\`\`judge-cases\n${CASES}\n\`\`\`\n`;
const CORRECT = "export default function count(text) { const words = text.match(/\\S+/g); return words === null ? 0 : words.length; }\n";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

async function escrow(w: World, attestor: Address, judgeFee = 0n) {
  const dir = await mkdtemp(join(tmpdir(), "sealed-"));
  const spec = join(dir, "spec.md");
  await writeFile(spec, SPEC);
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor, specHash: new Uint8Array(createHash("sha256").update(SPEC).digest()), judgeFee } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  return { dir, spec, intent };
}

async function served(intent: Address, worker: KeyPairSigner, module: string, url: string) {
  h.specPages.set(url, new TextEncoder().encode(module));
  return announced(intent, worker, sha(module), url);
}

async function copied(intent: Address, judge: Address, worker: KeyPairSigner, copier: KeyPairSigner, module: string, url: string): Promise<Address> {
  const [signed] = await worker.signMessages([createSignableMessage(saltMessage(intent, sha(module)))]);
  const source = Uint8Array.from(signed?.[worker.address] ?? []);
  const blob = await sealDeliveryV4({ source, url, recipients: [judge] }, intent, worker.address);
  const { salt } = await deliverySecrets(url, [judge], source);
  const commitment = await announcementCommitment(intent, worker.address, { delivered: Uint8Array.from(Buffer.from(sha(module), "hex")), salt });
  nextSlot();
  const { announcement, instruction } = await buildAnnounceDelivery({ worker: copier, intent, attestor: judge, commitment, blob });
  await createClient({ url: "http://cluster", transport }).send([instruction], copier);
  return announcement;
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
  it("judge --watch fails a copy of a worker's blob landed first from another wallet, never fetches it, and pays the honest worker", async () => {
    const w = await world();
    const judge = await keyed("judge.json");
    const { spec, intent } = await escrow(w, judge.address);
    const [worker, copier] = [await keyed(), await keyed()];
    const url = ["https://work.example.org", "5", "count.mjs"].join("/");
    const copy = await copied(intent, judge.address, worker, copier, CORRECT, url);
    const honest = await served(intent, worker, CORRECT, url);
    const watched = await watch(["judge", "--keypair", "judge.json", "--owner", w.owner.address, "--nonce", "0", "--spec", spec, "--sandbox", "viper", "--watch", "--yes"]);
    expect([watched.code, watched.err]).toEqual([EXIT_OK, ""]);
    expect(watched.fetched).toEqual([url]);
    expect(watched.lines[0]).toEqual({
      announcement: copy,
      seq: "1",
      worker: copier.address,
      url: null,
      artifactSha256: null,
      verdict: "fail",
      reason: `the announcement ${copy} ${SEALED_ELSEWHERE}`,
    });
    expect(watched.lines[1]).toMatchObject({
      url,
      worker: worker.address,
      announcement: honest.announcement,
      verdict: "pass",
      payTo: worker.address,
      signature: expect.any(String),
      skipped: [{ announcement: copy, seq: "1", worker: copier.address, reason: "does-not-open" }],
    });
    expect(watched.lines[2]).toEqual({ stopped: "paid", intent, judged: 2 });
    expect(await paidTo(w.inputMint, worker.address)).toBeGreaterThan(0n);
    expect(await paidTo(w.inputMint, copier.address)).toBe(-1n);
  }, 60_000);

  it("judge pays the first announcement that opens to the work, deliveries shows it paid, and the receipt reads its salt from the release", async () => {
    const w = await world();
    h.through = svmTransport(h.svm, { genesisHash: getBase58Decoder().decode(DOMAIN) });
    const judge = await keyed("judge.json");
    const { dir, spec, intent } = await escrow(w, judge.address);
    const artifact = join(dir, "count.mjs");
    await writeFile(artifact, CORRECT);
    const [worker, other] = [await keyed("worker.json"), await keyed("other.json")];
    for (const [path, module, name] of [["other.json", "export default 1;\n", "other.mjs"], ["worker.json", CORRECT, "count.mjs"]] as const) {
      const work = join(dir, name);
      await writeFile(work, module);
      const delivered = await cli(["deliver", "--keypair", path, "--intent", intent, "--artifact", work, "--work-url", "https://" + "example.org/" + name, "--yes"], {});
      expect([delivered.code, delivered.err]).toEqual([EXIT_OK, ""]);
    }
    const judged = await cli(["judge", "--keypair", "judge.json", "--owner", w.owner.address, "--nonce", "0", "--spec", spec, "--artifact", artifact, "--sandbox", "viper", "--yes"], {});
    expect([judged.code, judged.err]).toEqual([EXIT_OK, ""]);
    expect(judged.json()).toMatchObject({ verdict: "pass", payTo: worker.address, seq: "2", signature: expect.any(String) });
    expect(judged.json()).not.toHaveProperty("openings");
    expect(await paidTo(w.inputMint, worker.address)).toBeGreaterThan(0n);
    expect(await paidTo(w.inputMint, other.address)).toBe(-1n);
    const listed = (await cli(["deliveries", "--intent", intent], {})).json();
    expect((listed["announcements"] as { worker: string; state: string }[]).map(({ worker: by, state }) => [by, state])).toEqual([
      [other.address, "announced"],
      [worker.address, "paid"],
    ]);
    const shown = await cli(["receipt", "--owner", w.owner.address, "--nonce", "0", "--sha256", sha(CORRECT)], {});
    expect([shown.code, shown.err]).toEqual([EXIT_OK, ""]);
    expect(shown.json()).toMatchObject({
      released: true,
      matches: true,
      delivered_sha256: sha(CORRECT),
      delivered_salt: judged.json()["salt"],
      announcement: judged.json()["announcement"],
      announcer: worker.address,
      paid_to: worker.address,
    });
    expect(shown.json()).not.toHaveProperty("refuted_by");
  }, 60_000);

  it("deliveries lists sealed announcements and opens their urls only with the judge's key", async () => {
    const w = await world();
    const judge = await keyed("judge.json");
    const { intent } = await escrow(w, judge.address);
    const worker = await keyed();
    const url = "https://" + "example.org/count.mjs";
    const made = await served(intent, worker, CORRECT, url);
    const listed = await cli(["deliveries", "--intent", intent], {});
    expect([listed.code, listed.err]).toEqual([EXIT_OK, ""]);
    expect(listed.json()).toMatchObject({ intent, complete: true, closed: false, missing: [], announcements: [{ announcement: made.announcement, seq: "1", worker: worker.address, state: "announced", commitment: made.commitment }] });
    expect(listed.out).not.toContain("example.org");
    const opened = await cli(["deliveries", "--intent", intent, "--judge-keypair", "judge.json"], {});
    expect(opened.json()).toMatchObject({ announcements: [{ announcement: made.announcement, url }] });
  }, 60_000);

  it("a committee member's vote names the announcement that opens to the work, not an earlier one of other work", async () => {
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
    const [other, worker] = [await keyed(), await keyed()];
    await served(intent, other, "export default 1;\n", "https://" + "example.org/other.mjs");
    const made = await served(intent, worker, CORRECT, "https://" + "example.org/count.mjs");
    const verdict = join(dir, "v0.json");
    const judged = await cli(["judge", "--keypair", "m0.json", "--owner", w.owner.address, "--nonce", "0", "--spec", spec, "--artifact", artifact, "--sandbox", "viper", "--verdict", verdict], keys);
    expect([judged.code, judged.err]).toEqual([EXIT_OK, ""]);
    expect(judged.json()).toMatchObject({ verdict: "pass", payTo: worker.address, committee, next: VOTE_NEXT });
    expect(judged.json()["vote"]).toMatchObject({ announcement: made.announcement, sha256: sha(CORRECT), salt: made.salt });
    expect(JSON.parse(await readFile(verdict, "utf8"))).toMatchObject({ vote: { announcement: made.announcement } });
  }, 60_000);
});
