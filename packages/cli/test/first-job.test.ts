import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, createKeyPairSignerFromBytes, getBase58Decoder, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEVNET_TEST_MINT, findAssociatedTokenAddress, findIntentPda, formatAmount, getIntentDecoder, IntentStatus, NATIVE_MINT } from "@intent-engine/core";
import { svmTransport } from "@intent-engine/client/svm";
import { EXIT_FAILED, EXIT_OK, ONE_NODE } from "../src/main.js";
import { AIRDROP } from "../src/wallet.js";
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
      "solana transfer --url devnet --keypair <keypair> worker.json 0.01 --allow-unfunded-recipient",
      "solana-keygen pubkey worker.json",
      "solana-keygen new --no-bip39-passphrase -o copier.json",
    ]);
    expect(commands.map(verbOf)).toEqual(["setup", "hash", "create attested", "jobs", "hash", "deliver", "judge", "balance", "deliver", "judge", "receipt", "deliver", "judge"]);
    expect(Object.keys(files)).toEqual(["spec.md", "wrong.mjs", "right.mjs"]);
    const ran = await follower.follow(STEPS);
    const [setup, specHash, created, jobs, checked, wrong, refused, shown, right, paid, receipt, copied, again] = ran.filter((r) => r.line.startsWith("intent-engine "));
    const { keys, values } = follower;
    const worker = keys["worker.json"]?.address;

    expect(PAGE).toContain(`asks devnet for ${AIRDROP / SOL} SOL when it holds little`);
    expect([setup?.code, setup?.err]).toEqual([EXIT_OK, ""]);
    expect(setup?.out).toMatchObject({ created: true, sol: String(AIRDROP / SOL) });

    expect(PAGE).toContain("send it 0.01 SOL from yours for its network fees");
    const fees = raw("0.01");
    expect(PAGE).toContain("the judge runs the module's default export and pays only when it returns 42");
    expect(files["spec.md"]).toContain('```judge-cases\n{"cases": [{"args": [], "expected": 42}]}\n```');
    expect(specHash?.out["sha256"]).toBe(await follower.hash("spec.md"));

    expect(PAGE).toContain("Post the job with 0.01 SOL of pay for a day");
    expect(created?.line).toContain("--expires-in 86400 ");
    expect([created?.code, created?.err]).toEqual([EXIT_OK, ""]);
    const [intent] = await findIntentPda({ owner: values["address"] as Address, nonce: BigInt(values["nonce"] ?? "") });
    expect(values["intent"]).toBe(intent);
    expect(statusOf(intent)?.escrowed).toBe(raw(TEXT_AMOUNT));

    const net = raw(TEXT_AMOUNT) - (raw(TEXT_AMOUNT) * BigInt(FEE_BPS)) / BPS;
    expect(PAGE).toContain("what the worker gets, the 0.01 less the protocol fee");
    expect(jobs?.out["jobs"]).toMatchObject([{ intent, specHash: specHash?.out["sha256"], net_pay: formatAmount(net, 9) }]);
    expect(checked?.out["sha256"]).toBe(specHash?.out["sha256"]);

    expect([wrong?.code, wrong?.err]).toEqual([EXIT_OK, ""]);
    expect(wrong?.out).toMatchObject({ intent, sent: true });
    expect(PAGE).toContain('`judge` prints `"verdict": "fail"`: the module returned 41 where the spec wants 42, so it sends nothing.');
    expect(files["wrong.mjs"]).toBe("export default () => 41;\n");
    expect(refused?.out).toMatchObject({ intent, verdict: "fail", artifactSha256: await follower.hash("wrong.mjs") });
    expect(refused?.out["signature"]).toBeNull();
    expect(refused?.code).toBe(EXIT_FAILED);
    expect(PAGE).toContain("Each `judge` first warns that it reads one RPC node, which is fine for a test job.");
    expect(named(ran, "judge").map((r) => r.warned)).toEqual([`${ONE_NODE}
`, `${ONE_NODE}
`, `${ONE_NODE}
`]);
    expect(ran.filter((r) => verbOf(r.line) !== "judge").map((r) => r.warned).join("")).toBe("");
    expect(PAGE).toContain("`balance` shows the worker's `wrapped SOL` at `0`.");
    expect(shown?.out).toMatchObject({ address: worker, tokens: [{ name: "wrapped SOL", balance: "0" }, { name: "TEST" }] });
    expect([wrong?.status, refused?.status, shown?.status]).toEqual([IntentStatus.Open, IntentStatus.Open, IntentStatus.Open]);

    expect(right?.out).toMatchObject({ intent, sent: true });
    expect(PAGE).toContain('`judge` prints `"verdict": "pass"`, the worker\'s address as `payTo` and the `signature` of the release.');
    expect([paid?.code, paid?.err]).toEqual([EXIT_OK, ""]);
    expect(paid?.out).toMatchObject({ intent, verdict: "pass", payTo: worker, signature: expect.any(String) });
    expect(paid?.status).toBe(IntentStatus.Filled);

    const pubkey = ran.find((r) => r.line === "solana-keygen pubkey worker.json");
    expect(pubkey?.out["address"]).toBe(worker);
    expect(PAGE).toContain("The receipt shows who was paid as `paid_to`, the address `solana-keygen` prints, how much as `paid`, the job's `net_pay`, and for which work as `delivered_sha256`, the `sha256` that `intent-engine hash --artifact right.mjs` prints.");
    expect(receipt?.out).toMatchObject({
      intent,
      released: true,
      paid_to: worker,
      paid: formatAmount(net, 9),
      delivered_sha256: await follower.hash("right.mjs"),
      signature: paid?.out["signature"],
      valid: true,
    });

    expect(PAGE).toContain("`deliver` refuses: the job is paid and no longer open, so the copier gets nothing. It needs no SOL, since nothing is sent.");
    expect(copied?.code).not.toBe(EXIT_OK);
    expect(copied?.err).toContain(`${intent} is no longer open`);
    expect(h.svm.getBalance(keys["copier.json"]?.address as Address) ?? 0n).toBe(0n);
    expect(await follower.wrapped("copier.json")).toBe(-1n);

    expect(PAGE).toContain("`judge` refuses, since the job is no longer open, and sends nothing.");
    expect(again?.code).not.toBe(EXIT_OK);
    expect(again?.err).toContain(`${intent} is no longer open`);
    expect(await follower.wrapped("worker.json")).toBe(net);
    const left = h.svm.getBalance(worker as Address) ?? 0n;
    expect(left > 0n && left < fees).toBe(true);
  });

  it("pays the worker, not a copier that announces the same work before the release", async () => {
    expect(PAGE).toContain("A copy announced before the release fails too: the judge pays only the wallet that announced the work first.");
    const rightAnnounced = STEPS.findIndex((step) => "line" in step && step.line.startsWith("intent-engine deliver --keypair worker.json") && step.line.includes("right.mjs"));
    const copierMade = STEPS.findIndex((step) => "line" in step && step.line.endsWith("-o copier.json"));
    const copy = STEPS[copierMade + 1];
    const pay = STEPS[rightAnnounced + 1];
    if (copy === undefined || pay === undefined || !("line" in copy) || !("line" in pay)) {
      throw new Error("the guide lost its copy or its pay step");
    }
    expect(verbOf(pay.line)).toBe("judge");
    await follower.follow([...STEPS.slice(0, rightAnnounced + 1), STEPS[copierMade] as Step]);
    h.svm.airdrop(follower.keys["copier.json"]?.address as Address, lamports(SOL / 100n));
    const ran = await follower.follow([copy, pay]);
    const [copied, paid] = ran.slice(-2);
    expect(copied?.out).toMatchObject({ sent: true });
    expect(paid?.out).toMatchObject({ verdict: "pass", payTo: follower.keys["worker.json"]?.address });
    expect(await follower.wrapped("copier.json")).toBe(-1n);
    expect(await follower.wrapped("worker.json")).toBeGreaterThan(0n);
  });
});
