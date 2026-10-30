import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, KeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { IntentStatus, Kind } from "@intent-engine/core";
import { getIntentDecoder } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { EXIT_FAILED, EXIT_OK } from "../src/main.js";
import { workResaved } from "../src/judge.js";
import { isResaved, RESAVED, resavedFrom } from "../src/resaved.js";
import { announced, keyed } from "./announce.js";
import { cli, funded, h, NOW, transport, type World, world } from "./harness.js";

const SPEC = '# Count\n\n```judge-cases\n{"cases": [{"args": ["a b"], "expected": 2}]}\n```\n';
const MODULE = "export default (text) => text.split(\" \").length;\n";
const BOM = "﻿";

const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const setContent = (text: string) => `${BOM}${text}\r\n`;

type Job = { w: World; judge: KeyPairSigner; intent: Address; dir: string };

async function job(): Promise<Job> {
  const w = await world();
  const judge = await funded();
  const worker = await keyed();
  const dir = await mkdtemp(join(tmpdir(), "judge-resaved-"));
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: new Uint8Array(createHash("sha256").update(SPEC).digest()), judgeFee: 0n } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  await announced(intent, worker, sha(MODULE), "https://" + "example.org/count.mjs");
  return { w, judge, intent, dir };
}

const status = (intent: Address) => {
  const account = h.svm.getAccount(intent);
  return account.exists ? getIntentDecoder().decode(account.data).status : undefined;
};

describe("a file saved again on Windows", () => {
  it("finds the original of a file PowerShell's Set-Content saved with a byte-order mark and a CRLF end, or an editor saved with CRLF lines", () => {
    expect(resavedFrom(new TextEncoder().encode(setContent(SPEC)))).toContain(sha(SPEC));
    expect(isResaved(new TextEncoder().encode(SPEC.replaceAll("\n", "\r\n")), sha(SPEC))).toBe(true);
    expect(isResaved(new TextEncoder().encode(`${BOM}${SPEC}`), sha(SPEC).toUpperCase())).toBe(true);
  });

  it("finds nothing for a file saved byte for byte, or one whose text changed", () => {
    expect(resavedFrom(new TextEncoder().encode("no line end"))).toEqual([]);
    expect(isResaved(new TextEncoder().encode(SPEC), sha(SPEC))).toBe(false);
    expect(isResaved(new TextEncoder().encode(setContent(SPEC.replace("a b", "a b c"))), sha(SPEC))).toBe(false);
  });

  it("judge refuses a spec saved by Set-Content, says why, and runs and pays nothing", async () => {
    const j = await job();
    const spec = join(j.dir, "spec.md");
    const artifact = join(j.dir, "count.mjs");
    await writeFile(spec, setContent(SPEC));
    await writeFile(artifact, MODULE);
    const run = await cli(["judge", "--keypair", "judge.json", "--owner", j.w.owner.address, "--nonce", "0", "--spec", spec, "--artifact", artifact, "--sandbox", "viper", "--yes"], { "judge.json": j.judge });
    expect(run.code).toBe(EXIT_FAILED);
    expect(run.err).toContain(`has sha256 ${sha(setContent(SPEC))}, but intent ${j.intent} commits ${sha(SPEC)}; ${RESAVED}`);
    expect(status(j.intent)).toBe(IntentStatus.Open);
  });

  it("judge refuses work saved by Set-Content, names the sha256 announced, and runs and pays nothing; the bytes announced pass", async () => {
    const j = await job();
    const spec = join(j.dir, "spec.md");
    const artifact = join(j.dir, "count.mjs");
    await writeFile(spec, SPEC);
    await writeFile(artifact, setContent(MODULE));
    const args = ["judge", "--keypair", "judge.json", "--owner", j.w.owner.address, "--nonce", "0", "--spec", spec, "--artifact", artifact, "--sandbox", "viper"];
    const run = await cli(args, { "judge.json": j.judge });
    expect(run.code).toBe(EXIT_FAILED);
    expect(run.err).toContain(workResaved(artifact, sha(setContent(MODULE)), sha(MODULE)));
    await writeFile(artifact, MODULE);
    const passed = await cli(args, { "judge.json": j.judge });
    expect([passed.code, passed.json()["verdict"]]).toEqual([EXIT_OK, "pass"]);
  });
});
