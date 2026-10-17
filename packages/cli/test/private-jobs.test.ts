import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import { ENV_KEYPAIR, ENV_URL } from "../src/args.js";
import { EXIT_OK } from "../src/main.js";
import { ata, cli, funded, h, world } from "./harness.js";

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
    expect(blocks("powershell")).toHaveLength(3);
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
    expect(delivered.summary[0]).toBe(`Announces: the work with sha256 ${work} at ${vars["WORK_URL"]}, for the proof escrow ${vars["INTENT"]}`);
    expect(delivered.summary[1]).toContain(worker.address);
    h.env[ENV_KEYPAIR] = "owner.json";
    expect(PAGE).toContain("The link and the work's hash are public; the work is not.");
  }, 60_000);
});
