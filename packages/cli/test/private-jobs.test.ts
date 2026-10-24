import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, createKeyPairSignerFromBytes, getAddressDecoder, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it, vi } from "vitest";
import { DEVNET_TEST_MINT, NATIVE_MINT, specMemo } from "@intent-engine/core";
import { commitmentOf, deliverySalt } from "@intent-engine/client";
import { ENV_KEYPAIR, ENV_URL } from "../src/args.js";
import { EXIT_FAILED, EXIT_OK } from "../src/main.js";
import { ata, cli, creation, funded, h, ownerSigned, world } from "./harness.js";

vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "93.184.215.14", family: 4 }] }));

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const PAGE = readFileSync(join(ROOT, "docs/private-jobs.md"), "utf8");
const FENCE = "```";
const blocks = (language: string) =>
  PAGE.split(`${FENCE}${language}\n`)
    .slice(1)
    .map((rest) => rest.slice(0, rest.indexOf(`${FENCE}\n`)).trimEnd().split("\n"));
const PIPED = /^export ([A-Z_]+)=\$\((intent-engine [^|]+) \| (node -p .+)\)$/;

function preset(at: Address): void {
  if (h.svm.getAccount(at).exists) {
    return;
  }
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

describe("the company-only job guide", () => {
  it("posts a job with only its spec hash, lets a worker check a spec it got privately and deliver behind a private link", async () => {
    const w = await world();
    const owner = await funded();
    const worker = await funded();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    await ata(w.authority, w.feeRecipient.address, NATIVE_MINT);
    const dir = await mkdtemp(join(tmpdir(), "private-job-"));
    const spec = "Write answer.txt holding 42.\n";
    await writeFile(join(dir, "spec.md"), spec);
    await mkdir(join(dir, "work"));
    await writeFile(join(dir, "work", "answer.txt"), "42\n");
    const keys = { "owner.json": owner, "worker.json": worker };
    const files: Record<string, string> = { "spec.md": join(dir, "spec.md"), work: join(dir, "work") };
    h.env[ENV_URL] = "devnet";
    h.env[ENV_KEYPAIR] = "owner.json";
    h.watched.push(owner.address, worker.address);
    const vars: Record<string, string> = { WORK_URL: "https://git.example.com/private/answer.tar" };
    const run = async (line: string) => {
      const argv = line
        .split(" ")
        .slice(1)
        .map((word) => files[word] ?? word.replace(/^\$([A-Z_]+)$/, (whole, name: string) => vars[name] ?? whole));
      const result = await cli(argv, keys);
      expect([result.code, result.err], line).toEqual([EXIT_OK, ""]);
      return result;
    };

    const [posting = [], checking = [], delivering = []] = blocks("sh");
    expect(blocks("powershell")).toHaveLength(6);
    for (const line of posting) {
      const piped = PIPED.exec(line);
      if (piped === null) {
        expect(line.startsWith("intent-engine create attested ")).toBe(true);
        expect(line).not.toContain("--spec-url");
        await run(line);
        continue;
      }
      const [, name = "", command = "", filter = ""] = piped;
      const out = (await run(command)).out;
      const picked = spawnSync("sh", ["-c", filter], { input: out, encoding: "utf8" });
      expect([picked.status, picked.stderr], filter).toEqual([0, ""]);
      vars[name] = picked.stdout.trim();
    }
    expect(vars["JUDGE"]).toBe(owner.address);
    expect(vars["SPEC_HASH"]).toBe(createHash("sha256").update(spec).digest("hex"));

    const [jobsLine = "", hashLine = ""] = checking;
    const listed = (await run(jobsLine)).json() as { jobs: { intent: string; specHash: string; specUrl: string | null }[] };
    expect(listed.jobs).toHaveLength(1);
    expect(listed.jobs[0]).toMatchObject({ specHash: vars["SPEC_HASH"], specUrl: null });
    expect(PAGE).toContain("`jobs` lists the job with `specUrl` set to `null`.");
    expect((await run(hashLine)).json()["sha256"]).toBe(listed.jobs[0]?.specHash);
    vars["INTENT"] = listed.jobs[0]?.intent ?? "";

    h.env[ENV_KEYPAIR] = "worker.json";
    const [deliverLine = ""] = delivering;
    const work = (await cli(["hash", "--artifact", join(dir, "work")], keys)).json()["sha256"] as string;
    const delivered = (await run(deliverLine)).json() as { sent: boolean; intent: string; attestor: string; summary: string[] };
    expect(delivered).toMatchObject({ sent: true, intent: vars["INTENT"], attestor: owner.address });
    expect(delivered.summary[0]).toBe(`Announces: the work with sha256 ${work}, for the proof escrow ${vars["INTENT"]}, as the commitment ${commitmentOf(vars["INTENT"] as Address, worker.address, await deliverySalt(worker, vars["INTENT"] as Address, work), work)}, which binds it to ${worker.address} and a salt only its key derives`);
    expect(delivered.summary[1]).toBe(`Seals: the salt and the url ${vars["WORK_URL"]}, so only the judge ${owner.address} can read it`);
    h.env[ENV_KEYPAIR] = "owner.json";
    expect(PAGE).toContain("`deliver` seals the link to the judge and hides the work's hash until a release records it.");
    expect(PAGE).toContain("Without private hosting, upload the work to a public host under a long random path or file name, such as 32 random hex characters, so nobody can guess the link.");
    expect(PAGE).toContain("Run `deliver` right after the upload: the earliest announcer is paid");
  }, 60_000);

  it("seals the spec to invited wallets, lets an invited worker read it and seal the work to the judge, and lets the judge open it", async () => {
    const w = await world();
    const raw = () => {
      const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
      return Uint8Array.from([...Buffer.from(jwk.d ?? "", "base64url"), ...Buffer.from(jwk.x ?? "", "base64url")]);
    };
    const [ownerKey, workerKey, strangerKey] = [raw(), raw(), raw()];
    const owner = await createKeyPairSignerFromBytes(ownerKey);
    h.svm.airdrop(owner.address, lamports(1_000_000_000n));
    const judgeWallet = "~/.config/intent-engine/wallet.json";
    h.files.set(judgeWallet, JSON.stringify([...ownerKey]));
    h.files.set("worker.json", JSON.stringify([...workerKey]));
    h.files.set("stranger.json", JSON.stringify([...strangerKey]));
    const worker = getAddressDecoder().decode(workerKey.slice(32));
    h.svm.airdrop(worker, lamports(100_000_000n));
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    await ata(w.authority, w.feeRecipient.address, NATIVE_MINT);
    const [ownerDir = "", workerDir = "", judgeDir = ""] = await Promise.all(["owner", "worker", "judge"].map((who) => mkdtemp(join(tmpdir(), `invite-${who}-`))));
    const spec = "Pack answer.txt holding 42 into work.tar.\n";
    await writeFile(join(ownerDir, "spec.md"), spec);
    await writeFile(join(workerDir, "work.tar"), "answer.txt: 42\n");
    const vars: Record<string, string> = {
      WORKER: worker,
      JUDGE: owner.address,
      SPEC_HASH: createHash("sha256").update(spec).digest("hex"),
      SPEC_URL: "https://files.example.com/jobs/spec.sealed",
      WORK_URL: "https://files.example.com/work/work.sealed",
    };
    const keys = { "owner.json": owner };
    const as = async (wallet: string, line: string, files: Record<string, string>) => {
      h.env[ENV_KEYPAIR] = wallet;
      const argv = line
        .split(" ")
        .slice(1)
        .map((word) => files[word] ?? word.replace(/\$([A-Z_]+)/g, (whole, name: string) => vars[name] ?? whole));
      const result = await cli(argv, keys);
      expect([result.code, result.err], line).toEqual([EXIT_OK, ""]);
      return result.json();
    };
    h.env[ENV_URL] = "devnet";
    h.watched.push(owner.address, worker);
    const [, , , posting = [], working = [], opening = []] = blocks("sh");
    const ownerFiles = { "spec.md": join(ownerDir, "spec.md"), "spec.sealed": join(ownerDir, "spec.sealed") };
    const [sealLine = "", createLine = ""] = posting;
    expect((await as("owner.json", sealLine, ownerFiles))["to"]).toEqual([worker, owner.address]);
    h.specPages.set(vars["SPEC_URL"] ?? "", new Uint8Array(await readFile(join(ownerDir, "spec.sealed"))));
    const made = await as("owner.json", createLine, ownerFiles);
    vars["INTENT"] = made["intent"] as string;
    h.engineLog.push({ ...creation(made["intent"] as Address), ...ownerSigned(made["intent"] as Address, [specMemo(vars["SPEC_URL"] ?? "")]) });

    const workerFiles = { "spec.md": join(workerDir, "spec.md"), "work.tar": join(workerDir, "work.tar"), "work.sealed": join(workerDir, "work.sealed") };
    const [readLine = "", sealWork = "", deliverLine = ""] = working;
    expect(await as("worker.json", readLine, workerFiles)).toMatchObject({ matches: true, sealed_to: [worker, owner.address] });
    expect(await readFile(join(workerDir, "spec.md"), "utf8")).toBe(spec);
    h.env[ENV_KEYPAIR] = "stranger.json";
    expect((await cli(["spec", "--intent", vars["INTENT"] ?? ""], keys)).code).toBe(EXIT_FAILED);
    expect((await as("worker.json", sealWork, workerFiles))["to"]).toEqual([owner.address]);
    const workHash = createHash("sha256").update("answer.txt: 42\n").digest("hex");
    const delivered = (await as("worker.json", deliverLine, workerFiles)) as { sent: boolean; summary: string[] };
    expect(delivered.sent).toBe(true);
    expect(delivered.summary[0]).toContain(`Announces: the work with sha256 ${workHash}, for the proof escrow ${vars["INTENT"]}, as the commitment `);
    expect(delivered.summary[1]).toBe(`Seals: the salt and the url ${vars["WORK_URL"]}, so only the judge ${owner.address} can read it`);

    const judgeFiles = { "work.sealed": join(workerDir, "work.sealed"), "work.tar": join(judgeDir, "work.tar") };
    const [unsealLine = ""] = opening;
    expect(unsealLine).toContain(`--keypair ${judgeWallet} `);
    expect(await as("owner.json", unsealLine, judgeFiles)).toEqual({ out: join(judgeDir, "work.tar"), sha256: workHash });
    expect(await readFile(join(judgeDir, "work.tar"), "utf8")).toBe("answer.txt: 42\n");
    expect(PAGE).toContain("`judge` refuses to pay a wallet the spec was not sealed to.");
  }, 60_000);
});
