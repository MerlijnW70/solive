import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, createKeyPairSignerFromBytes, getBase58Decoder, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEVNET_TEST_MINT, findAssociatedTokenAddress, formatAmount, IntentStatus, NATIVE_MINT } from "@intent-engine/core";
import { findIntentPda, getIntentDecoder } from "@intent-engine/core/internal";
import { svmTransport } from "@intent-engine/client/svm";
import { EXIT_FAILED, EXIT_OK, ONE_NODE } from "../src/main.js";
import { quietWebCryptoWarnings } from "../src/node-warnings.js";
import { AIRDROP, ENOUGH_TO_START } from "../src/wallet.js";
import { ata, balance, cli, DOMAIN, FEE_BPS, h, send, world } from "./harness.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const read = (path: string) => readFileSync(`${ROOT}/${path}`, "utf8");
const PAGE = read("docs/first-job.md");
const SOL = 1_000_000_000n;
const BPS = 10_000n;

type Step = { file: string; text: string } | { line: string };
type Ran = { line: string; code: number; err: string; out: Record<string, unknown>; warned: string; status?: number };

const fenced = [...PAGE.matchAll(/^(`{3,4})(\w*)\n([\s\S]*?)\n\1$/gm)];

const STEPS: Step[] = fenced.flatMap((m): Step[] => {
  const body = m[3] ?? "";
  if (m[2] === "sh") {
    return body.split("\n").map((line) => ({ line }));
  }
  const named = /as `([^`]+)`:\n\n$/.exec(PAGE.slice(0, m.index));
  if (named === null) {
    throw new Error(`a ${m[2]} block that names no file: ${body}`);
  }
  return [{ file: named[1] ?? "", text: `${body}\n` }];
});

const lines = STEPS.flatMap((step) => ("line" in step ? [step.line] : []));
const commands = lines.filter((line) => line.startsWith("intent-engine "));
const files = Object.fromEntries(STEPS.flatMap((step) => ("file" in step ? [[step.file, step.text]] : [])));
const verbOf = (line: string) => {
  const [, verb = "", sub = ""] = line.split(" ");
  return sub === "" || sub.startsWith("--") ? verb : `${verb} ${sub}`;
};

const TEXT_AMOUNT = /with ([\d.]+) SOL of pay/.exec(PAGE)?.[1] ?? "missing";
const raw = (amount: string) => {
  const [whole = "0", part = ""] = amount.split(".");
  return BigInt(whole) * SOL + BigInt(part.padEnd(9, "0").slice(0, 9));
};

function preset(at: Address): void {
  const space = BigInt(getMintSize());
  h.svm.setAccount({
    address: at,
    data: Uint8Array.from(getMintEncoder().encode({ mintAuthority: none(), supply: 0n, decimals: 9, isInitialized: true, freezeAuthority: none() })),
    executable: false,
    lamports: lamports(h.svm.minimumBalanceForRentExemption(space)),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space,
  });
}

async function newKey(): Promise<KeyPairSigner> {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const bytes = Uint8Array.from([...Buffer.from(jwk.d ?? "", "base64url"), ...Buffer.from(jwk.x ?? "", "base64url")]);
  const signer = await createKeyPairSignerFromBytes(bytes);
  h.keypairs.set(signer.address, bytes);
  return signer;
}

const statusOf = (intent: string) => {
  const held = h.svm.getAccount(intent as Address);
  return held.exists ? getIntentDecoder().decode(held.data) : undefined;
};

class Follower {
  readonly keys: Record<string, KeyPairSigner> = {};
  readonly ran: Ran[] = [];
  readonly values: Record<string, string> = {};

  constructor(private readonly dir: string) {}

  private fill(line: string): string[] {
    const filled = line.replace(/<([a-z0-9]+)>/g, (whole, name: string) => {
      const value = this.values[name];
      if (value === undefined) {
        throw new Error(`${whole} has no value yet in: ${line}`);
      }
      return value;
    });
    return filled.split(" ").map((word) => (files[word] === undefined ? word : join(this.dir, word)));
  }

  private async own(): Promise<KeyPairSigner> {
    return createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(h.files.get(this.values["keypair"] ?? "") ?? "[]") as number[]));
  }

  private async solana(line: string): Promise<Record<string, unknown>> {
    const made = /^solana-keygen new --no-bip39-passphrase -o (\S+)$/.exec(line);
    if (made !== null) {
      this.keys[made[1] ?? ""] = await newKey();
      return {};
    }
    const shown = /^solana-keygen pubkey (\S+)$/.exec(line);
    if (shown !== null) {
      return { address: this.keys[shown[1] ?? ""]?.address };
    }
    const sent = /^solana transfer --url devnet --keypair (\S+) (\S+) ([\d.]+) --allow-unfunded-recipient$/.exec(line);
    if (sent !== null) {
      const [, from = "", to = "", amount = ""] = sent;
      expect(from).toBe(this.values["keypair"]);
      const recipient = this.keys[to];
      if (recipient === undefined) {
        throw new Error(`no key file ${to}`);
      }
      const source = await this.own();
      await send(source, [getTransferSolInstruction({ source, destination: recipient.address, amount: raw(amount) })]);
      return {};
    }
    throw new Error(`the guide runs a command this test does not know: ${line}`);
  }

  async step(step: Step): Promise<void> {
    if ("file" in step) {
      await writeFile(join(this.dir, step.file), step.text);
      return;
    }
    const { line } = step;
    if (!line.startsWith("intent-engine ")) {
      this.ran.push({ line, code: EXIT_OK, err: "", out: await this.solana(this.fill(line).join(" ")), warned: "" });
      return;
    }
    const warnings: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((text) => warnings.push(String(text)) > 0);
    const run = await cli(this.fill(line).slice(1), this.keys).finally(() => stderr.mockRestore());
    h.svm.warpToSlot(h.svm.getClock().slot + 1n);
    const out = run.out === "" ? {} : run.json();
    const status = this.values["intent"] === undefined ? undefined : statusOf(this.values["intent"])?.status;
    this.ran.push({ line, code: run.code, err: run.err, out, warned: warnings.join(""), ...(status === undefined ? {} : { status }) });
    if (verbOf(line) === "setup") {
      this.values["address"] = String(out["address"]);
      this.values["keypair"] = String(out["keypair"]);
    }
    if (verbOf(line) === "hash" && this.values["sha256"] === undefined) {
      this.values["sha256"] = String(out["sha256"]);
    }
    if (verbOf(line) === "create attested") {
      this.values["intent"] = String(out["intent"]);
      this.values["nonce"] = String(out["nonce"]);
    }
  }

  async follow(steps: readonly Step[]): Promise<Ran[]> {
    for (const step of steps) {
      await this.step(step);
    }
    return this.ran;
  }

  async hash(file: string): Promise<string> {
    return String((await cli(["hash", "--artifact", join(this.dir, file)], {})).json()["sha256"]);
  }

  async wrapped(file: string): Promise<bigint> {
    const owner = this.keys[file]?.address;
    if (owner === undefined) {
      throw new Error(`no key file ${file}`);
    }
    return balance(await findAssociatedTokenAddress({ owner, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS }));
  }
}

const named = (ran: readonly Ran[], verb: string) => ran.filter((r) => verbOf(r.line) === verb);

describe("the first paid job guide", () => {
  let follower: Follower;

  beforeAll(() => {
    quietWebCryptoWarnings();
  });

  beforeEach(async () => {
    const w = await world();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    await ata(w.authority, w.feeRecipient.address, NATIVE_MINT);
    h.through = svmTransport(h.svm, { genesisHash: getBase58Decoder().decode(DOMAIN) });
    follower = new Follower(await mkdtemp(join(tmpdir(), "first-job-")));
  });

  it("is linked first under Start after the quickstart and ends at the AI guide", () => {
    const config = read("docs/.vitepress/config.mjs");
    const start = config.slice(config.indexOf('text: "Start"'), config.indexOf('text: "Guides"'));
    const links = [...start.matchAll(/link: "([^"]+)"/g)].map((m) => m[1]);
    expect(links.slice(0, 2)).toEqual(["/quickstart", "/first-job"]);
    expect(PAGE.trimEnd().endsWith("Do the same from your AI: [Earn and hire](ai.md#earn-and-hire).")).toBe(true);
    expect(read("docs/ai.md")).toContain("\n## Earn and hire\n");
  });

  it("runs the commands it prints in order, and every outcome it promises holds", async () => {
    expect(lines.filter((line) => !line.startsWith("intent-engine "))).toEqual([
      "solana-keygen new --no-bip39-passphrase -o worker.json",
      "solana transfer --url devnet --keypair <keypair> worker.json 0.02 --allow-unfunded-recipient",
      "solana-keygen new --no-bip39-passphrase -o copier.json",
      "solana transfer --url devnet --keypair <keypair> copier.json 0.01 --allow-unfunded-recipient",
      "solana-keygen pubkey worker.json",
    ]);
    expect(commands.map(verbOf)).toEqual(["setup", "hash", "create attested", "jobs", "hash", "deliver", "judge", "balance", "deliver", "deliver", "judge", "receipt", "deliver", "judge"]);
    expect(Object.keys(files)).toEqual(["spec.md", "wrong.mjs", "right.mjs"]);
    const ran = await follower.follow(STEPS);
    const [setup, specHash, created, jobs, checked, wrong, refused, shown, right, early, paid, receipt, copied, again] = ran.filter((r) => r.line.startsWith("intent-engine "));
    const { keys, values } = follower;
    const worker = keys["worker.json"]?.address;
    const copier = keys["copier.json"]?.address;

    expect(PAGE).toContain(`asks devnet for ${AIRDROP / SOL} SOL when it holds little, then for less if devnet refuses.`);
    expect([setup?.code, setup?.err]).toEqual([EXIT_OK, ""]);
    expect(setup?.out).toMatchObject({ created: true, sol: String(AIRDROP / SOL), airdrop: String(AIRDROP / SOL) });

    expect(PAGE).toContain("send it 0.02 SOL from yours for its network fees and the rent of its two announcements");
    const fees = raw("0.02");
    expect(PAGE).toContain("the judge runs the module's default export and pays only when it returns 42");
    expect(files["spec.md"]).toContain('```judge-cases\n{"cases": [{"args": [], "expected": 42}]}\n```');
    expect(specHash?.out["sha256"]).toBe(await follower.hash("spec.md"));

    expect(PAGE).toContain("Post the job with 0.01 SOL of pay for a day");
    expect(created?.line).toContain("--expires-in 86400 ");
    expect([created?.code, created?.err]).toEqual([EXIT_OK, ""]);
    const [intent] = await findIntentPda({ owner: values["address"] as Address, nonce: BigInt(values["nonce"] ?? "") });
    expect(values["intent"]).toBe(intent);
    expect(statusOf(intent)?.escrowed).toBe(raw(TEXT_AMOUNT));
    expect(PAGE).toContain("It also warns about judging on a Ledger; your wallet is a key file, so that warning does not apply.");
    const warnings = created?.out["warnings"] as string[];
    expect(warnings.filter((w) => w.includes("Ledger"))).toEqual([expect.stringMatching(/A judge with a key file can ignore this$/)]);
    expect(values["keypair"]?.endsWith(".json")).toBe(true);

    const net = raw(TEXT_AMOUNT) - (raw(TEXT_AMOUNT) * BigInt(FEE_BPS)) / BPS;
    expect(PAGE).toContain("what the worker gets, the 0.01 less the protocol fee");
    expect(jobs?.out["jobs"]).toMatchObject([{ intent, specHash: specHash?.out["sha256"], net_pay: formatAmount(net, 9) }]);
    expect(checked?.out["sha256"]).toBe(specHash?.out["sha256"]);

    expect([wrong?.code, wrong?.err]).toEqual([EXIT_OK, ""]);
    expect(PAGE).toContain('`deliver` prints `"sent": true`, the `signature` of the announcement, and a warning to share neither the work nor its url until the announcement lands, since the first wallet to announce the work is paid.');
    expect(wrong?.out).toMatchObject({ intent, sent: true, signature: expect.any(String) });
    expect(wrong?.out["warnings"]).toEqual([expect.stringMatching(/^share neither the url nor the work until this announcement lands: the first announcement that opens to the work is paid/)]);
    expect(PAGE).toContain('`judge` prints `"verdict": "fail"`: the module returned 41 where the spec wants 42, so it sends nothing.');
    expect(files["wrong.mjs"]).toBe("export default () => 41;\n");
    expect(refused?.out).toMatchObject({ intent, verdict: "fail", artifactSha256: await follower.hash("wrong.mjs") });
    expect(refused?.out["signature"]).toBeNull();
    expect(refused?.code).toBe(EXIT_FAILED);
    expect(PAGE).toContain("Each `judge` first warns that it reads one RPC node, which is fine for a test job.");
    expect(named(ran, "judge").map((r) => r.warned)).toEqual([`${ONE_NODE}\n`, `${ONE_NODE}\n`, `${ONE_NODE}\n`]);
    expect(ran.filter((r) => verbOf(r.line) !== "judge").map((r) => r.warned).join("")).toBe("");
    expect(PAGE).toContain("`balance` shows the worker's `wrapped SOL` at `0`.");
    expect(shown?.out).toMatchObject({ address: worker, tokens: [{ name: "wrapped SOL", balance: "0" }, { name: "TEST" }] });
    expect([wrong?.status, refused?.status, shown?.status]).toEqual([IntentStatus.Open, IntentStatus.Open, IntentStatus.Open]);

    expect(right?.out).toMatchObject({ intent, sent: true });
    expect(PAGE).toContain("A third wallet gets the same work before the release and announces it as its own.");
    expect(PAGE).toContain('`deliver` prints `"sent": true` for the copier too.');
    expect(early?.line).toContain("--keypair copier.json ");
    expect([early?.code, early?.err]).toEqual([EXIT_OK, ""]);
    expect(early?.out).toMatchObject({ intent, sent: true });
    expect(early?.status).toBe(IntentStatus.Open);

    expect(PAGE).toContain('`judge` prints `"verdict": "pass"`, the worker\'s address as `payTo` and the `signature` of the release: the judge pays only the first announcement that opens to the work, so the copier gets nothing.');
    expect([paid?.code, paid?.err]).toEqual([EXIT_OK, ""]);
    expect(paid?.out).toMatchObject({ intent, verdict: "pass", payTo: worker, signature: expect.any(String) });
    expect(paid?.status).toBe(IntentStatus.Filled);
    expect(await follower.wrapped("copier.json")).toBe(-1n);

    const pubkey = ran.find((r) => r.line === "solana-keygen pubkey worker.json");
    expect(pubkey?.out["address"]).toBe(worker);
    expect(PAGE).toContain("The receipt shows who was paid as `paid_to`, the address `solana-keygen` prints, how much as `paid`, the job's `net_pay`, and for which work as `delivered_sha256`, the `sha256` that `intent-engine hash --artifact right.mjs` prints.");
    expect(PAGE).toContain("`payee` is the wrapped SOL account the pay landed in, which `paid_to` owns.");
    expect(receipt?.out).toMatchObject({
      intent,
      released: true,
      paid_to: worker,
      payee: await findAssociatedTokenAddress({ owner: worker as Address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
      paid: formatAmount(net, 9),
      delivered_sha256: await follower.hash("right.mjs"),
      signature: paid?.out["signature"],
      announcer: worker,
    });

    expect(PAGE).toContain("`deliver` refuses: the job is paid and no longer open, so the copier gets nothing and sends nothing.");
    expect(copied?.code).not.toBe(EXIT_OK);
    expect(copied?.err).toContain(`${intent} is no longer open`);
    expect(await follower.wrapped("copier.json")).toBe(-1n);

    expect(PAGE).toContain("`judge` refuses, since the job is no longer open, and sends nothing.");
    expect(again?.code).not.toBe(EXIT_OK);
    expect(again?.err).toContain(`${intent} is no longer open`);
    expect(await follower.wrapped("worker.json")).toBe(net);
    const left = h.svm.getBalance(worker as Address) ?? 0n;
    expect(left > 0n && left < fees).toBe(true);
    const copierLeft = h.svm.getBalance(copier as Address) ?? 0n;
    expect(copierLeft > 0n && copierLeft < raw("0.01")).toBe(true);
  });

  it("runs from a wallet that holds only the SOL it says it needs", async () => {
    const need = /This guide needs ([\d.]+) SOL in your wallet\./.exec(PAGE)?.[1] ?? "missing";
    expect(raw(need)).toBe(ENOUGH_TO_START);
    const through = h.through;
    if (through === null) {
      throw new Error("the guide runs on a node");
    }
    h.through = { ...through, airdrop: async () => Promise.reject(new Error("429 Too Many Requests")) };
    const setupAt = STEPS.findIndex((step) => "line" in step && verbOf(step.line) === "setup");
    await follower.follow(STEPS.slice(0, setupAt + 1));
    h.svm.airdrop(follower.values["address"] as Address, lamports(raw(need)));
    const ran = await follower.follow(STEPS.slice(setupAt + 1));
    expect(ran.filter((r) => r.code !== EXIT_OK).map((r) => r.line)).toEqual([
      "intent-engine judge --owner <address> --nonce <nonce> --spec spec.md --artifact wrong.mjs --sandbox viper --yes",
      "intent-engine deliver --keypair copier.json --intent <intent> --artifact right.mjs --work-url https://example.org/right.mjs --yes",
      "intent-engine judge --owner <address> --nonce <nonce> --spec spec.md --artifact right.mjs --sandbox viper --yes",
    ]);
    expect(named(ran, "judge")[1]?.out).toMatchObject({ verdict: "pass", payTo: follower.keys["worker.json"]?.address });
    expect(await follower.wrapped("worker.json")).toBeGreaterThan(0n);
  });
});
