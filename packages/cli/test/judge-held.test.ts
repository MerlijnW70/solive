import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { getIntentDecoder, IntentStatus, Kind, seal, sortMembers } from "@intent-engine/core";
import { createClient, type EngineTransaction, type FinalizedBlock, type Transport } from "@intent-engine/client";
import { EXIT_FAILED, EXIT_OK, main } from "../src/main.js";
import { HELD_MARGIN_SECONDS, heldCommittee, heldHashWrong, heldOf, heldOnDevice, heldOnlyViper, heldOutside, heldQueued, heldTooSoon, SLOT_MS } from "../src/held.js";
import { casesOf } from "../src/viper.js";
import type { Runtime } from "../src/runtime.js";
import { keyed, sealedDelivery } from "./announce.js";
import { device, deviceKey, found } from "./ledger-device.js";
import { cli, creation, funded, h, NOW, runtime, transport, type World, world } from "./harness.js";

const GENERATOR = `export default function generate(seed, count) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    let text = "w";
    for (let j = 0; j < 8; j += 1) {
      const digit = parseInt(seed[(i * 8 + j) % seed.length], 16);
      text += digit % 4 === 0 ? " " : String.fromCharCode(97 + digit);
    }
    out.push([text]);
  }
  return out;
}`;
const CHECKER = "export default (args, answer) => { const words = args[0].match(/\\S+/g); return answer === (words === null ? 0 : words.length); };";
const DOMAIN = "export default (text) => typeof text === 'string' && text.length < 200;";
const PUBLISHED = [
  { args: [""], expected: 0 },
  { args: ["one"], expected: 1 },
  { args: ["one\ttwo　three"], expected: 3 },
];
const HELD = [
  { args: ["hello world"], expected: 2 },
  { args: ["a b c"] },
  { args: ["  spaced   out  "], expected: 2 },
  { args: ["tab\tsplit here"] },
];
const CORRECT = "export default function count(text) { const words = text.match(/\\S+/g); return words === null ? 0 : words.length; }\n";
const GENERATED_ONLY =
  'const table = { "": 0, "one": 1, "one\\ttwo\\u3000three": 3 }; export default (text) => (text in table ? table[text] : text[0] === "w" ? (text.match(/\\S+/g) || []).length : -1);\n';
const BLOCKHASH = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const K = 3;
const AT = 50;
const HELD_URL = "https://" + "cases.example.org/held.sealed";

const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const specOf = (block: object) => `# Count words\n\n\`\`\`judge-cases\n${JSON.stringify(block)}\n\`\`\`\n`;
const plainOf = (entries: object[]) => JSON.stringify(entries);
const heldSpec = (plain = plainOf(HELD), held: object = {}) =>
  specOf({
    cases: PUBLISHED,
    draw: { count: 12, generator: GENERATOR, checker: CHECKER, k: K },
    held: { sha256: sha(plain), count: JSON.parse(plain).length, url: HELD_URL, at: AT, domain: DOMAIN, ...held },
  });

type Chain = { reached: boolean; asked: bigint[] };
type Job = { w: World; judge: KeyPairSigner; intent: Address; spec: string; dir: string; chain: Chain };

async function escrow(specText: string, attestor?: Address, served = plainOf(HELD)): Promise<Job> {
  const w = await world();
  const judge = await keyed("judge.json");
  const dir = await mkdtemp(join(tmpdir(), "judge-held-"));
  const spec = join(dir, "spec.md");
  await writeFile(spec, specText);
  h.specPages.set(HELD_URL, await seal(new TextEncoder().encode(served), [judge.address]));
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: attestor ?? judge.address, specHash: new Uint8Array(createHash("sha256").update(specText).digest()), judgeFee: 0n } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  h.engineLog = [creation(intent)];
  const chain: Chain = { reached: false, asked: [] };
  const finalizedBlock = async (from: bigint): Promise<FinalizedBlock | null> => {
    chain.asked.push(from);
    return from >= BigInt(AT) && !chain.reached ? null : { slot: from, blockhash: BLOCKHASH };
  };
  h.through = { ...transport, finalizedBlock } as Transport;
  return { w, judge, intent, spec, dir, chain };
}

async function announce(j: Job, worker: Address, module: string, slot: bigint): Promise<string> {
  const url = ["https://work.example.org", String(slot), "count.mjs"].join("/");
  h.specPages.set(url, new TextEncoder().encode(module));
  const delivered: EngineTransaction = {
    signature: `delivery-${slot}`,
    slot,
    blockTime: null,
    failed: false,
    emitted: [],
    memos: [await sealedDelivery(j.intent, worker, sha(module), url, [j.judge.address])],
    feePayer: worker,
  };
  h.engineLog = [delivered, ...h.engineLog];
  const artifact = join(j.dir, `count-${slot}.mjs`);
  await writeFile(artifact, module);
  return artifact;
}

const judging = (j: Job, artifact: string, ...more: string[]) => ["judge", "--keypair", "judge.json", "--owner", j.w.owner.address, "--nonce", "0", "--spec", j.spec, "--artifact", artifact, "--sandbox", "viper", ...more];

const status = (intent: Address) => {
  const account = h.svm.getAccount(intent);
  return account.exists ? getIntentDecoder().decode(account.data).status : undefined;
};

async function watch(j: Job, argv: string[], rounds: number, onSleep: (round: number) => void) {
  const out: string[] = [];
  const err: string[] = [];
  const base = runtime({ "judge.json": j.judge });
  let slept = 0;
  const rt: Runtime = {
    ...base,
    sleep: async () => {
      slept += 1;
      onSleep(slept);
      return slept < rounds;
    },
  };
  const code = await main(argv, rt, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, err: err.join("\n"), lines: out.map((o) => JSON.parse(o) as Record<string, unknown>) };
}

describe("judge --sandbox viper with sealed held cases", () => {
  it("fails a delivery correct only on generator-shaped inputs on the held cases, records one bit and pays nothing", async () => {
    const j = await escrow(heldSpec());
    j.chain.reached = true;
    const worker = await generateKeyPairSigner();
    const artifact = await announce(j, worker.address, GENERATED_ONLY, 5n);
    const judged = await cli(judging(j, artifact, "--yes"), { "judge.json": j.judge });
    expect([judged.code, judged.err]).toEqual([EXIT_FAILED, ""]);
    const verdict = judged.json();
    expect(verdict).toMatchObject({ verdict: "fail", signature: null, cases: { total: 3, passed: 3 }, drawn: { total: 12, passed: 12 }, host: { total: 3, passed: 3 } });
    expect(verdict["held"]).toEqual({ count: HELD.length, passed: false, slot: AT });
    expect(JSON.stringify(verdict)).not.toMatch(/hello|spaced|split|"a b c"/);
    expect(status(j.intent)).toBe(IntentStatus.Open);
  }, 60_000);

  it("queues a correct delivery before the held slot without opening the cases, and pays it only once a block at or after the slot is finalized", async () => {
    const j = await escrow(heldSpec());
    const worker = await generateKeyPairSigner();
    const artifact = await announce(j, worker.address, CORRECT, 5n);
    const sealed = h.specPages.get(HELD_URL) as Uint8Array;
    h.specPages.delete(HELD_URL);
    const early = await cli(judging(j, artifact, "--yes"), { "judge.json": j.judge });
    expect([early.code, early.err]).toEqual([EXIT_FAILED, ""]);
    expect(early.json()).toMatchObject({ verdict: "queued", signature: null, drawn: { passed: 12 }, next: heldQueued(AT) });
    expect("held" in early.json()).toBe(false);
    expect(status(j.intent)).toBe(IntentStatus.Open);
    expect(j.chain.asked).toContain(BigInt(AT));
    j.chain.reached = true;
    h.specPages.set(HELD_URL, sealed);
    const paid = await cli(judging(j, artifact, "--yes"), { "judge.json": j.judge });
    expect([paid.code, paid.err]).toEqual([EXIT_OK, ""]);
    expect(paid.json()).toMatchObject({ verdict: "pass", payTo: worker.address, signature: expect.any(String), held: { count: HELD.length, passed: true, slot: AT } });
    expect(status(j.intent)).toBe(IntentStatus.Filled);
  }, 60_000);

  it("judge --watch queues passing deliveries before the slot, then judges them on the held cases in announcement order and pays the first that passes", async () => {
    const j = await escrow(heldSpec());
    const [early, late] = [await generateKeyPairSigner(), await generateKeyPairSigner()];
    await announce(j, late.address, CORRECT, 9n);
    await announce(j, early.address, GENERATED_ONLY, 4n);
    const argv = ["judge", "--keypair", "judge.json", "--owner", j.w.owner.address, "--nonce", "0", "--spec", j.spec, "--sandbox", "viper", "--watch", "--yes"];
    const watched = await watch(j, argv, 4, (round) => {
      j.chain.reached = round >= 1;
    });
    expect([watched.code, watched.err]).toEqual([EXIT_OK, ""]);
    expect(watched.lines.map((l) => [l["worker"] ?? l["stopped"], l["verdict"], l["held"]])).toEqual([
      [early.address, "queued", undefined],
      [late.address, "queued", undefined],
      [early.address, "fail", { count: HELD.length, passed: false, slot: AT }],
      [late.address, "pass", { count: HELD.length, passed: true, slot: AT }],
      ["paid", undefined, undefined],
    ]);
    expect(status(j.intent)).toBe(IntentStatus.Filled);
  }, 120_000);

  it("refuses the spec as its own fault when a held case lies outside its domain or the held file's hash differs, and pays nothing", async () => {
    const outside = plainOf([...HELD.slice(0, 3), { args: [42], expected: 0 }]);
    for (const [specText, served, said] of [
      [heldSpec(outside), outside, heldOutside],
      [heldSpec(), plainOf(HELD.slice(1)), heldHashWrong(sha(plainOf(HELD.slice(1))), sha(plainOf(HELD)))],
    ] as const) {
      const j = await escrow(specText, undefined, served);
      j.chain.reached = true;
      const worker = await generateKeyPairSigner();
      const artifact = await announce(j, worker.address, CORRECT, 5n);
      const refused = await cli(judging(j, artifact, "--yes"), { "judge.json": j.judge });
      expect([refused.code, refused.out]).toEqual([EXIT_FAILED, ""]);
      expect(refused.err).toContain(said);
      expect(refused.err).toContain("the spec is at fault, not the worker");
      expect(status(j.intent)).toBe(IntentStatus.Open);
    }
  }, 60_000);

  it("judge --watch stops on a held file it refuses instead of failing the delivery", async () => {
    const j = await escrow(heldSpec(), undefined, plainOf(HELD.slice(1)));
    j.chain.reached = true;
    const worker = await generateKeyPairSigner();
    await announce(j, worker.address, CORRECT, 5n);
    const argv = ["judge", "--keypair", "judge.json", "--owner", j.w.owner.address, "--nonce", "0", "--spec", j.spec, "--sandbox", "viper", "--watch", "--yes"];
    const watched = await watch(j, argv, 3, () => undefined);
    expect(watched.code).toBe(EXIT_FAILED);
    expect(watched.err).toContain(heldHashWrong(sha(plainOf(HELD.slice(1))), sha(plainOf(HELD))));
    expect(watched.lines).toEqual([]);
    expect(status(j.intent)).toBe(IntentStatus.Open);
  }, 60_000);

  it("refuses held cases on a committee escrow and outside --sandbox viper", async () => {
    const w = await world();
    const members = await Promise.all([0, 1, 2].map(() => funded()));
    const payer = await funded();
    const keys: Record<string, KeyPairSigner> = { "payer.json": payer, "m0.json": members[0] as KeyPairSigner };
    const addresses = sortMembers(members.map((m) => m.address));
    const created = await cli(["committee", "create", "--keypair", "payer.json", "--members", addresses.join(","), "--threshold", "2", "--fee-wallet", payer.address, "--yes"], keys);
    const committee = created.json()["committee"] as Address;
    const dir = await mkdtemp(join(tmpdir(), "judge-held-"));
    const spec = join(dir, "spec.md");
    await writeFile(spec, heldSpec());
    const artifact = join(dir, "count.mjs");
    await writeFile(artifact, CORRECT);
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: committee, specHash: new Uint8Array(createHash("sha256").update(heldSpec()).digest()), judgeFee: 0n } as const;
    const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
    h.engineLog = [creation(intent)];
    const refused = await cli(["judge", "--keypair", "m0.json", "--owner", w.owner.address, "--nonce", "0", "--spec", spec, "--artifact", artifact, "--sandbox", "viper"], keys);
    expect([refused.code, refused.out]).toEqual([EXIT_FAILED, ""]);
    expect(refused.err).toContain(heldCommittee(intent, committee));
    const j = await escrow(heldSpec());
    const worker = await generateKeyPairSigner();
    const plain = await announce(j, worker.address, CORRECT, 5n);
    const unboxed = await cli(["judge", "--keypair", "judge.json", "--owner", j.w.owner.address, "--nonce", "0", "--spec", j.spec, "--artifact", plain, "--sandbox", "none", "--run", "true", "--yes"], { "judge.json": j.judge });
    expect([unboxed.code, unboxed.out]).toEqual([EXIT_FAILED, ""]);
    expect(unboxed.err).toContain(heldOnlyViper);
    expect(status(j.intent)).toBe(IntentStatus.Open);
  }, 60_000);

  it("refuses held cases to a judge on a Ledger, which cannot open them, before the device signs anything", async () => {
    const key = await deviceKey();
    const j = await escrow(heldSpec(), key.address);
    const worker = await generateKeyPairSigner();
    const artifact = await announce(j, worker.address, CORRECT, 5n);
    const path = "usb://ledger?key=1/0";
    const ledger = device(key, found([44, 501, 1, 0], key));
    const err: string[] = [];
    const code = await main(judging(j, artifact, "--yes").map((arg) => (arg === "judge.json" ? path : arg)), { ...runtime({}), ledger: ledger.open }, { out: () => undefined, err: (t) => err.push(t) });
    expect([code, err]).toEqual([EXIT_FAILED, [heldOnDevice(path)]]);
    ledger.store.ensureQueueEmpty();
    expect(ledger.signed).toEqual([]);
    expect(status(j.intent)).toBe(IntentStatus.Open);
  }, 60_000);

  it("judges a spec without held as before, without opening anything or waiting for a slot", async () => {
    const plainSpec = specOf({ cases: PUBLISHED, draw: { count: 12, generator: GENERATOR, checker: CHECKER, k: K } });
    expect("held" in casesOf(new TextEncoder().encode(plainSpec))).toBe(false);
    expect(heldOf(new TextEncoder().encode(plainSpec))).toBeUndefined();
    const j = await escrow(plainSpec);
    const worker = await generateKeyPairSigner();
    const artifact = await announce(j, worker.address, CORRECT, 5n);
    const paid = await cli(judging(j, artifact, "--yes"), { "judge.json": j.judge });
    expect([paid.code, paid.err]).toEqual([EXIT_OK, ""]);
    expect(paid.json()).toMatchObject({ verdict: "pass", signature: expect.any(String) });
    expect("held" in paid.json()).toBe(false);
    expect(j.chain.asked).toEqual([5n + BigInt(K)]);
    expect(status(j.intent)).toBe(IntentStatus.Filled);
  }, 60_000);

  it("refuses a held block it cannot trust before reading anything", () => {
    for (const [held, said] of [
      [{ sha256: "AB".repeat(32) }, "has a held sha256 that is not 64 lowercase hex digits"],
      [{ count: 0 }, "has a held count 0, which is not a whole number from 1 to 10000"],
      [{ url: "http://" + "cases.example.org/held" }, "has a held url that is not an https url"],
      [{ at: -1 }, "has a held at -1, which is not a slot"],
      [{ domain: " " }, "has a held domain that is not the source of a module"],
      [{ extra: 1 }, 'has a held field "extra" it does not know'],
    ] as const) {
      expect(() => casesOf(new TextEncoder().encode(heldSpec(plainOf(HELD), held))), said).toThrow(said);
    }
    expect(casesOf(new TextEncoder().encode(heldSpec())).held).toEqual({ sha256: sha(plainOf(HELD)), count: HELD.length, url: HELD_URL, at: AT, domain: DOMAIN });
  });
});

describe("create attested with held cases", () => {
  it("refuses an escrow that expires too soon after the held slot, or names a committee, and accepts one with the margin", async () => {
    const w = await world();
    const judge = await generateKeyPairSigner();
    const slot = h.svm.getClock().slot;
    const at = Number(slot) + 10_000;
    const plain = plainOf(HELD);
    const specText = specOf({ cases: PUBLISHED, held: { sha256: sha(plain), count: HELD.length, url: HELD_URL, at, domain: DOMAIN } });
    const specUrl = "https://" + "example.org/held-spec.md";
    h.specPages.set(specUrl, new TextEncoder().encode(specText));
    const create = (attestor: Address, expiresIn: string) => [
      "create",
      "attested",
      "--keypair",
      "owner.json",
      "--input-mint",
      w.inputMint,
      "--output-mint",
      w.outputMint,
      "--expires-in",
      expiresIn,
      "--amount-in",
      "0.0001",
      "--min-result",
      "1",
      "--max-result",
      "1",
      "--attestor",
      attestor,
      "--spec-hash",
      sha(specText),
      "--spec-url",
      specUrl,
    ];
    const keys = { "owner.json": w.owner };
    const now = h.svm.getClock().unixTimestamp;
    const eta = now + (10_000n * BigInt(SLOT_MS)) / 1000n;
    const soon = await cli(create(judge.address, "3600"), keys);
    expect(soon).toMatchObject({ code: EXIT_FAILED, err: heldTooSoon(at, eta, now + 3_600n) });
    expect(soon.err).toContain(`${HELD_MARGIN_SECONDS} seconds`);
    const members = await Promise.all([0, 1, 2].map(() => funded()));
    const created = await cli(["committee", "create", "--keypair", "owner.json", "--members", sortMembers(members.map((m) => m.address)).join(","), "--threshold", "2", "--fee-wallet", w.owner.address, "--yes"], keys);
    const committee = created.json()["committee"] as Address;
    const voted = await cli(create(committee, "86400"), keys);
    expect(voted.code).toBe(EXIT_FAILED);
    expect(voted.err).toContain(`--attestor ${committee} is a committee`);
    const later = await cli(create(judge.address, "86400"), keys);
    expect([later.code, later.err]).toEqual([EXIT_OK, ""]);
    expect(later.json()).toMatchObject({ sent: false });
  });
});
