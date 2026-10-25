import { createHash, getRandomValues } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, createNoopSigner, generateKeyPairSigner, getAddressEncoder, getBase58Encoder, type Instruction, type KeyPairSigner, lamports } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { beforeEach, describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, IntentStatus, Kind } from "@intent-engine/core";
import {
  buildEd25519Instruction,
  COMMITTEE_COSIGN_TAG,
  committeeEnvelope,
  ED25519_PROGRAM_ADDRESS,
  findIntentPda,
  getIntentDecoder,
  sortMembers,
  splitCosignEnvelope,
} from "@intent-engine/core/internal";
import { LedgerError, type Transport } from "@intent-engine/client";
import { createClient, ledgerSigner, notOwnEnvelope } from "@intent-engine/client/node";
import { committeeJudged, LEDGER_ERRORS, LEDGER_FORMS, MESSAGE_ONLY, messageOnly, type OpenTransport } from "@intent-engine/client/internal";
import { getTransferSolInstruction } from "@solana-program/system";
import { parse } from "../src/args.js";
import { DIGEST_NEXT } from "../src/judge-digest.js";
import { DEVICE_PREVIEW, DEVICE_VOTE_PREVIEW, FEE_PAYER_IS_JUDGE, GIVE_KEY_FLAG } from "../src/judge.js";
import { FEE_PAYER_FOR_LEDGER, FEE_PAYER_KEY_FILE, ledgerNeedsFeePayer } from "../src/arg-values.js";
import { LEDGER_COMMANDS, signsOnDevice } from "../src/ledger-keys.js";
import { EXIT_FAILED, EXIT_OK, main } from "../src/main.js";
import { secretsPath } from "../src/worker-secrets.js";
import { announced, keyed } from "./announce.js";
import { keyedProfile } from "./encryption-job.js";
import { ata, balance, creation, funded, h, HOME, NOW, runtime, transport, type World, world } from "./harness.js";

const KEY_FILE = "judge.enc";
import { CONFIG, type Device, device, deviceKey, found, type Key, MESSAGE, messageThen, REJECT, SIGN, transactionThen, TransportError } from "./ledger-device.js";

const CASES = '{"cases": [{"args": [""], "expected": 0}, {"args": ["one two"], "expected": 2}]}';
const SPEC = `# Count words\n\n\`\`\`judge-cases\n${CASES}\n\`\`\`\n`;
const COUNT = "export default function count(text) { const words = text.match(/\\S+/g); return words === null ? 0 : words.length; }\n";
const LEVELS = [44, 501, 1, 0];
const PATH = "usb://ledger?key=1/0";

const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest();

const ascii = (text: string) => [...new TextEncoder().encode(text)];

const programEnvelope = (signer: Address, digestHex: string) =>
  Uint8Array.from([0xff, ...ascii("solana offchain"), 1, 1, ...getAddressEncoder().encode(signer), ...ascii(digestHex)]);

type Sent = Instruction[][];

async function run(argv: string[], ledger?: Device | OpenTransport, keys: Record<string, KeyPairSigner> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const open = ledger === undefined ? {} : { ledger: typeof ledger === "function" ? ledger : ledger.open };
  const code = await main(argv, { ...runtime(keys), ...open }, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join("\n"), err: err.join("\n"), json: () => JSON.parse(out.join("\n")) as Record<string, unknown> };
}

function recording(): Sent {
  const sent: Sent = [];
  const through: Transport = {
    ...transport,
    send: async (instructions, payer) => {
      const signature = await transport.send(instructions, payer);
      sent.push([...instructions]);
      return signature;
    },
  };
  h.through = through;
  return sent;
}

const statusOf = (intent: Address) => {
  const view = h.svm.getAccount(intent);
  return view.exists ? getIntentDecoder().decode(view.data).status : undefined;
};

type Job = {
  w: World;
  key: Key;
  worker: Address;
  intent: Address;
  announcement: Address;
  sha256: string;
  salt: string;
  spec: string;
  artifact: string;
  payer: KeyPairSigner;
  keys: Record<string, KeyPairSigner>;
};

async function job(attestorOf?: (key: Key) => Promise<Address>): Promise<Job> {
  const w = await world();
  const key = await deviceKey();
  h.svm.airdrop(key.address, lamports(10_000_000_000n));
  const profile = await keyedProfile(key, KEY_FILE);
  const attestor = attestorOf === undefined ? key.address : await attestorOf(key);
  const workerKey = await keyed();
  const worker = workerKey.address;
  const dir = await mkdtemp(join(tmpdir(), "ledger-judge-"));
  const spec = join(dir, "spec.md");
  const artifact = join(dir, "count.mjs");
  await writeFile(spec, SPEC);
  await writeFile(artifact, COUNT);
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor, specHash: new Uint8Array(sha(SPEC)), judgeFee: 0n } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  const sha256 = sha(COUNT).toString("hex");
  const made = await announced(intent, workerKey, sha256, "https://" + "example.org/count.mjs");
  h.engineLog = [creation(intent), profile.entry];
  const payer = await funded();
  return { w, key, worker, intent, announcement: made.announcement, sha256, salt: made.salt, spec, artifact, payer, keys: { "payer.json": payer } };
}

const judging = (j: Job, path = PATH, opening = true) => [
  "judge", "--keypair", path, "--owner", j.w.owner.address, "--nonce", "0", "--spec", j.spec, "--artifact", j.artifact, "--sandbox", "viper",
  ...(opening ? ["--encryption-keypair", KEY_FILE] : []), "--fee-payer", "payer.json",
];

const digesting = (j: Job) => ["judge", "digest", "--owner", j.w.owner.address, "--nonce", "0", "--announcement", j.announcement, "--sha256", j.sha256, "--salt", j.salt];

const kinds = (ledger: Device) => ledger.signed.map(({ kind }) => kind);

describe("a judge on a Ledger", () => {
  it("judge digest prints the digest the Ledger then signs, as the program's offchain_envelope, for a release that lands in LiteSVM", async () => {
    const j = await job();
    const digest = await run(digesting(j));
    expect([digest.code, digest.err]).toEqual([EXIT_OK, ""]);
    const payee = await findAssociatedTokenAddress({ owner: j.worker, mint: j.w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const printed = digest.json();
    expect(printed).toEqual({ intent: j.intent, judge: j.key.address, announcement: j.announcement, payee, result: "1", digest: expect.stringMatching(/^[0-9a-f]{64}$/), next: DIGEST_NEXT });
    const sent = recording();
    const ledger = device(j.key, [...found(LEVELS, j.key), ...messageThen()]);
    const judged = await run([...judging(j), "--yes"], ledger, j.keys);
    expect([judged.code, judged.err]).toEqual([EXIT_OK, ""]);
    ledger.store.ensureQueueEmpty();
    expect(judged.json()).toMatchObject({ verdict: "pass", payTo: j.worker, signature: expect.any(String), digest: printed["digest"], feePayer: j.payer.address });
    expect(ledger.signed.map(({ kind, path }) => [kind, path])).toEqual([[MESSAGE, LEVELS]]);
    const envelope = ledger.signed[0]?.bytes ?? new Uint8Array();
    expect(envelope).toEqual(programEnvelope(j.key.address, String(printed["digest"])));
    const signature = Uint8Array.from(getBase58Encoder().encode(ledger.signatures[0] ?? ""));
    const verify = buildEd25519Instruction({ publicKey: j.key.address, signature, message: envelope });
    const released = sent.at(-1) ?? [];
    expect(released.filter((ix) => ix.programAddress === ED25519_PROGRAM_ADDRESS).map((ix) => Buffer.from(ix.data ?? []))).toEqual([Buffer.from(verify.data ?? [])]);
    expect(statusOf(j.intent)).toBe(IntentStatus.Filled);
    expect(balance(payee)).toBeGreaterThan(0n);
  });

  it("refuses announced work without an encryption key file, naming --encryption-keypair, before asking the Ledger to sign", async () => {
    const j = await job();
    const ledger = device(j.key, found(LEVELS, j.key));
    const refused = await run([...judging(j, PATH, false), "--yes"], ledger, j.keys);
    expect([refused.code, refused.out]).toEqual([EXIT_FAILED, ""]);
    expect(refused.err).toContain(`intent ${j.intent} has the earlier announcement ${j.announcement} (seq 1) by ${j.worker} sealed to the encryption key of ${j.key.address}'s profile`);
    expect(refused.err.endsWith(GIVE_KEY_FLAG)).toBe(true);
    ledger.store.ensureQueueEmpty();
    expect(ledger.signed).toEqual([]);
    expect(statusOf(j.intent)).toBe(IntentStatus.Open);
  });

  it("lets a worker on a Ledger, which cannot sign the salt message, announce with random secrets it keeps, the device signing only the transaction", async () => {
    const j = await job();
    const worker = await deviceKey();
    h.svm.airdrop(worker.address, lamports(10_000_000_000n));
    const ledger = device(worker, [...found(LEVELS, worker), ...transactionThen()]);
    const work = "ab".repeat(32);
    const delivered = await run(["deliver", "--keypair", PATH, "--intent", j.intent, "--sha256", work, "--work-url", "https://" + "example.org/work", "--yes"], ledger);
    expect([delivered.code, delivered.err]).toEqual([EXIT_OK, ""]);
    ledger.store.ensureQueueEmpty();
    expect(kinds(ledger)).toEqual([SIGN]);
    const path = secretsPath(HOME, worker.address, j.intent, work);
    expect(delivered.json()).toMatchObject({ sent: true, seq: "2", secrets: path });
    expect(JSON.parse(h.files.get(path) ?? "{}")).toMatchObject({ worker: worker.address, intent: j.intent, sha256: work, secret: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("previews a release without asking the Ledger to sign, showing the digest it will sign", async () => {
    const j = await job();
    const ledger = device(j.key, found(LEVELS, j.key));
    const previewed = await run(judging(j), ledger, j.keys);
    expect([previewed.code, previewed.err]).toEqual([EXIT_OK, ""]);
    ledger.store.ensureQueueEmpty();
    expect(ledger.signed).toEqual([]);
    const digest = await run(digesting(j));
    expect(previewed.json()).toMatchObject({ verdict: "pass", signature: null, digest: digest.json()["digest"], next: DEVICE_PREVIEW });
    expect(previewed.json()["simulated"]).toBeUndefined();
    expect(statusOf(j.intent)).toBe(IntentStatus.Open);
  });

  it("a rejection on the device and every Ledger error send nothing", async () => {
    const j = await job();
    const missing: OpenTransport = async () => {
      throw new TransportError("NoDevice", "NoDevice");
    };
    const unbuilt: OpenTransport = async () => {
      throw new Error("Could not locate the bindings file. Tried:\n → node_modules/node-hid/build/Release/HID_hidraw.node");
    };
    const cases: [string, Device][] = [
      [LEDGER_ERRORS.notFound, device(j.key, [], missing)],
      [LEDGER_ERRORS.driver, device(j.key, [], unbuilt)],
      [LEDGER_ERRORS.locked, device(j.key, [[CONFIG, "5515"]])],
      [LEDGER_ERRORS.noApp, device(j.key, [[CONFIG, "6e01"]])],
      [LEDGER_ERRORS.rejected, device(j.key, [...found(LEVELS, j.key), [MESSAGE, REJECT]])],
      [LEDGER_ERRORS.locked, device(j.key, [...found(LEVELS, j.key), [MESSAGE, "6982"]])],
    ];
    for (const [error, ledger] of cases) {
      const sent = recording();
      const result = await run([...judging(j), "--yes"], ledger, j.keys);
      expect([result.code, result.err, result.out]).toEqual([EXIT_FAILED, error, ""]);
      ledger.store.ensureQueueEmpty();
      expect(sent).toEqual([]);
      expect(statusOf(j.intent)).toBe(IntentStatus.Open);
    }
  }, 120_000);

  it("the device signs only an envelope that lists its own key", async () => {
    let committee = "" as Address;
    const c = await job(async (key) => {
      const made = await createClient({ url: "http://cluster", transport }).createCommittee({
        members: [key.address, (await generateKeyPairSigner()).address],
        threshold: 1,
        feeWallet: key.address,
        payer: await funded(),
      });
      committee = made.committee;
      return committee;
    });
    const j = c;
    const previewed = device(j.key, found(LEVELS, j.key));
    const preview = await run(judging(c), previewed, c.keys);
    expect([preview.code, preview.err]).toEqual([EXIT_OK, ""]);
    expect(preview.json()).toMatchObject({ verdict: "pass", committee, digest: expect.stringMatching(/^[0-9a-f]{64}$/), next: DEVICE_VOTE_PREVIEW });
    previewed.store.ensureQueueEmpty();
    expect(previewed.signed).toEqual([]);
    const judged = device(j.key, [...found(LEVELS, j.key), ...messageThen()]);
    const asCommittee = await run([...judging(c), "--yes"], judged, c.keys);
    expect([asCommittee.code, asCommittee.err]).toEqual([EXIT_OK, ""]);
    judged.store.ensureQueueEmpty();
    expect(kinds(judged)).toEqual([MESSAGE]);
    expect(asCommittee.json()).toMatchObject({ verdict: "pass", committee, vote: { member: j.key.address, signature: Buffer.from(getBase58Encoder().encode(judged.signatures[0] ?? "")).toString("hex") } });
    expect(statusOf(c.intent)).toBe(IntentStatus.Open);
    const printed = await run(digesting(c));
    expect([printed.code, printed.err, printed.out]).toEqual([EXIT_FAILED, `intent ${c.intent} ${committeeJudged(committee)}`, ""]);
    expect(signsOnDevice(parse(["committee", "vote", "--keypair", PATH, "--owner", c.w.owner.address, "--nonce", "0", "--sha256", c.sha256, "--result", "1"]))).toBe(true);
    const direct = device(j.key, [...found(LEVELS, j.key), ...messageThen()]);
    const signer = await ledgerSigner(PATH, direct.open);
    const digest = getRandomValues(new Uint8Array(32));
    const [a, b] = sortMembers([(await generateKeyPairSigner()).address, (await generateKeyPairSigner()).address]);
    if (a === undefined || b === undefined) throw new Error("two keys");
    const unsorted = sortMembers([a, j.key.address]).reverse();
    const refused = [
      committeeEnvelope(digest, [a, b]),
      splitCosignEnvelope(digest, [a]),
      Uint8Array.from([0xff, ...ascii("solana offchain"), 1, 1, ...COMMITTEE_COSIGN_TAG, ...ascii(Buffer.from(digest).toString("hex"))]),
      Uint8Array.from([0xff, ...ascii("solana offchain"), 1, 2, ...unsorted.flatMap((k) => [...getAddressEncoder().encode(k)]), ...ascii(Buffer.from(digest).toString("hex"))]),
    ];
    for (const envelope of refused) {
      await expect(signer.signMessages([{ content: envelope, signatures: {} }])).rejects.toEqual(new LedgerError(notOwnEnvelope(j.key.address)));
    }
    expect(direct.signed).toEqual([]);
    const listed = committeeEnvelope(digest, [a, j.key.address, b]);
    const [signed] = await signer.signMessages([{ content: listed, signatures: {} }]);
    expect(signed?.[j.key.address]).toHaveLength(64);
    direct.store.ensureQueueEmpty();
    expect(direct.signed.map((s) => Buffer.from(s.bytes).toString("hex"))).toEqual([Buffer.from(listed).toString("hex")]);
  });

  it("a message signature from the device that does not verify for its key is refused", async () => {
    const key = await deviceKey();
    const other = await deviceKey();
    const lying = device({ ...key, secret: other.secret }, [...found(LEVELS, key), ...messageThen()]);
    const signer = await ledgerSigner(PATH, lying.open);
    const envelope = programEnvelope(key.address, "ab".repeat(32));
    await expect(signer.signMessages([{ content: envelope, signatures: {} }])).rejects.toEqual(
      new LedgerError(`the Ledger returned a signature that does not verify for ${key.address}; nothing was sent`),
    );
    lying.store.ensureQueueEmpty();
    expect(lying.signed.map(({ bytes }) => bytes)).toEqual([envelope]);
  });

  it("a host that appends an instruction to the release cannot get the Ledger to sign it", async () => {
    const j = await job();
    const thief = (await generateKeyPairSigner()).address;
    const through: Transport = {
      ...transport,
      send: async (instructions, payer) =>
        transport.send([...instructions, getTransferSolInstruction({ source: createNoopSigner(j.key.address), destination: thief, amount: 1_000_000n })], payer),
    };
    h.through = through;
    const ledger = device(j.key, [...found(LEVELS, j.key), ...messageThen()]);
    const judged = await run([...judging(j), "--yes"], ledger, j.keys);
    expect([judged.code, judged.err]).toEqual([EXIT_FAILED, `Transaction is missing signatures for addresses: ${j.key.address}.`]);
    ledger.store.ensureQueueEmpty();
    expect(kinds(ledger)).toEqual([MESSAGE]);
    expect(ledger.signed[0]?.bytes.subarray(0, 16)).toEqual(Uint8Array.from([0xff, ...ascii("solana offchain")]));
    expect(h.svm.getAccount(thief).exists).toBe(false);
    expect(statusOf(j.intent)).toBe(IntentStatus.Open);
    const direct = device(j.key, found(LEVELS, j.key));
    const held = messageOnly(await ledgerSigner(PATH, direct.open));
    await expect(held.signTransactions([])).rejects.toEqual(new LedgerError(MESSAGE_ONLY));
    direct.store.ensureQueueEmpty();
    expect(direct.signed).toEqual([]);
  });

  it("a judge on a Ledger without --fee-payer is refused naming the option, and the fee payer is a key file other than the judge", async () => {
    const owner = "11111111111111111111111111111111";
    const shape = ["judge", "--owner", owner, "--nonce", "0", "--spec", "SPEC.md", "--artifact", "work.mjs", "--sandbox", "viper"];
    expect(() => parse([...shape, "--keypair", PATH])).toThrow(ledgerNeedsFeePayer(PATH));
    expect(() => parse([...shape.slice(0, -4), "--watch", "--sandbox", "viper", "--keypair", PATH])).toThrow(ledgerNeedsFeePayer(PATH));
    expect(() => parse([...shape, "--keypair", PATH, "--fee-payer", "usb://ledger"])).toThrow(FEE_PAYER_KEY_FILE);
    expect(() => parse([...shape, "--keypair", "judge.json", "--fee-payer", "payer.json"])).toThrow(FEE_PAYER_FOR_LEDGER);
    expect(parse([...shape, "--keypair", PATH, "--fee-payer", "payer.json"])).toMatchObject({ keypair: PATH, feePayer: "payer.json" });
    expect(parse([...shape, "--keypair", "judge.json"])).not.toHaveProperty("feePayer");
    const j = await job();
    const ledger = device(j.key, found(LEVELS, j.key));
    const sent = recording();
    const refused = await run([...judging(j).slice(0, -2), "--fee-payer", "self.json", "--yes"], ledger, { "self.json": j.key.signer });
    expect([refused.code, refused.err]).toEqual([EXIT_FAILED, FEE_PAYER_IS_JUDGE]);
    expect([ledger.signed, sent]).toEqual([[], []]);
  });

  it("judge digest reads only the escrow and the announcement it pays, and takes no key", () => {
    const owner = "11111111111111111111111111111111" as Address;
    const named = ["judge", "digest", "--owner", owner, "--nonce", "3", "--announcement", owner, "--sha256", "AB".repeat(32), "--salt", "CD".repeat(16)];
    expect(parse(named, { INTENT_ENGINE_KEYPAIR: PATH })).toEqual({
      name: "judge-digest",
      url: expect.any(String),
      priority: 0n,
      owner,
      nonce: 3n,
      announcement: owner,
      sha256: "ab".repeat(32),
      salt: "cd".repeat(16),
      result: undefined,
    });
    expect(() => parse([...named, "--keypair", PATH])).toThrow("judge digest does not take --keypair");
    expect(() => parse(["judge", "digest", "--owner", owner, "--nonce", "3"])).toThrow("--announcement");
  });

  it("judge, judge --watch, committee release and signed prepare take every Ledger form", () => {
    const owner = "11111111111111111111111111111111";
    const shapes = [
      ["judge", "--owner", owner, "--nonce", "0", "--spec", "SPEC.md", "--artifact", "work.mjs", "--sandbox", "viper", "--fee-payer", "payer.json"],
      ["judge", "--owner", owner, "--nonce", "0", "--spec", "SPEC.md", "--run", "node check.mjs", "--watch", "--fee-payer", "payer.json"],
      ["committee", "release", "--vote", "vote.json"],
      ["signed", "prepare", "swap", "--out", "s.json", "--input-mint", owner, "--output-mint", owner, "--expires-in", "60", "--amount-in", "1", "--min-out", "1", "--units", "raw"],
    ];
    for (const path of LEDGER_FORMS.map((form) => form.replace("<account>", "1").replace("<change>", "0"))) {
      for (const shape of shapes) {
        expect(signsOnDevice(parse([...shape, "--keypair", path])), shape.join(" ")).toBe(true);
      }
    }
    expect(LEDGER_COMMANDS).toEqual(expect.arrayContaining(["judge", "committee release", "signed prepare"]));
    expect(LEDGER_COMMANDS).toContain("committee vote");
  });
});

describe("a signed-intent owner on a Ledger", () => {
  let w: World;
  let key: Key;

  beforeEach(async () => {
    w = await world();
    key = await deviceKey();
    h.svm.airdrop(key.address, lamports(10_000_000_000n));
    await ata(w.authority, key.address, w.inputMint, 1_000n);
  });

  const prepare = () => [
    "signed",
    "prepare",
    "swap",
    "--keypair",
    PATH,
    "--out",
    "s.json",
    "--input-mint",
    w.inputMint,
    "--output-mint",
    w.outputMint,
    "--expires-in",
    "3600",
    "--amount-in",
    "400",
    "--min-out",
    "300",
    "--units",
    "raw",
    "--yes",
  ];

  it("signs the intent on the device and a relayer submits it in LiteSVM", async () => {
    const relayer = await funded();
    const ledger = device(key, [...found(LEVELS, key), ...messageThen(), ...transactionThen()]);
    const prepared = await run(prepare(), ledger);
    expect([prepared.code, prepared.err]).toEqual([EXIT_OK, ""]);
    ledger.store.ensureQueueEmpty();
    expect(ledger.signed.map(({ kind }) => kind)).toEqual([MESSAGE, SIGN]);
    const saved = JSON.parse(h.files.get("s.json") ?? "{}") as { signature: string };
    expect(saved.signature).toBe(ledger.signatures[0]);
    const submitted = await run(["signed", "submit", "--keypair", "relayer.json", "--file", "s.json", "--yes"], undefined, { "relayer.json": relayer });
    expect([submitted.code, submitted.err]).toEqual([EXIT_OK, ""]);
    expect(submitted.json()).toMatchObject({ sent: true, signature: expect.any(String) });
    const [intent] = await findIntentPda({ owner: key.address, nonce: 0n });
    expect(statusOf(intent)).toBe(IntentStatus.Open);
  });

  it("a rejection on the device saves and sends nothing", async () => {
    for (const answer of [REJECT, "6982"]) {
      const ledger = device(key, [...found(LEVELS, key), [MESSAGE, answer]]);
      const wires = h.wires.length;
      const refused = await run(prepare(), ledger);
      expect([refused.code, refused.err, refused.out]).toEqual([EXIT_FAILED, answer === REJECT ? LEDGER_ERRORS.rejected : LEDGER_ERRORS.locked, ""]);
      ledger.store.ensureQueueEmpty();
      expect([h.files.has("s.json"), h.wires.length]).toEqual([false, wires]);
    }
  });
});
