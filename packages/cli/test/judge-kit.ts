import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, type KeyPairSigner, type Signature } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { TransactionMetadata } from "litesvm";
import { expect, vi } from "vitest";
import { findAssociatedTokenAddress, Kind } from "@intent-engine/core";
import { decodeEvent, getIntentDecoder, manifestSha256 } from "@intent-engine/core/internal";
import { type Announced } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { announced as announce, keyed } from "./announce.js";
import { balance, h, NOW, transport, type World, world } from "./harness.js";

export const SPEC = "answer.txt holds 42\n";
export const WORK_URL = "https://" + "example.org/work.tar";
export const STOLEN_URL = "https://" + "example.org/stolen";
export const TIMEOUT_SECONDS = 1;
export const STARTUP_SECONDS = 3;

export const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));

export type Job = { w: World; judge: KeyPairSigner; worker: KeyPairSigner; copier: KeyPairSigner; intent: Address; dir: string; spec: string; artifact: string; sha256: string; first: Announced };

export async function job(specText = SPEC, workSha256?: string): Promise<Job> {
  const w = await world();
  const judge = await keyed("judge.json");
  const worker = await keyed();
  const copier = await keyed();
  const dir = await mkdtemp(join(tmpdir(), "judge-"));
  const spec = join(dir, "spec.md");
  await writeFile(spec, specText);
  const artifact = join(dir, "work");
  for (const skipped of [".git", "node_modules", "target"]) {
    await mkdir(join(artifact, skipped), { recursive: true });
    await writeFile(join(artifact, skipped, "ignored"), "not hashed");
  }
  await mkdir(join(artifact, "src"), { recursive: true });
  await writeFile(join(artifact, "answer.txt"), "42\n");
  await writeFile(join(artifact, "src", "notes.txt"), "how\n");
  const sha256 =
    workSha256 ??
    (await manifestSha256([
      { path: "answer.txt", bytes: new TextEncoder().encode("42\n") },
      { path: "src/notes.txt", bytes: new TextEncoder().encode("how\n") },
    ]));
  const specHash = new Uint8Array(createHash("sha256").update(specText).digest());
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash, judgeFee: 0n } as const;
  const client = createClient({ url: "http://cluster", transport });
  const { intent } = await client.createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  const first = await announce(intent, worker, sha256, WORK_URL);
  await announce(intent, copier, sha256, STOLEN_URL);
  return { w, judge, worker, copier, intent, dir, spec, artifact, sha256, first };
}

export const judging = (j: Job, run: string, ...more: string[]) => [...boxed(j, run, ...more), "--sandbox", "none"];

export const boxed = (j: Job, run: string, ...more: string[]) => [
  "judge",
  "--keypair",
  "judge.json",
  "--owner",
  j.w.owner.address,
  "--nonce",
  "0",
  "--spec",
  j.spec,
  "--artifact",
  j.artifact,
  "--run",
  run,
  ...more,
];

export const paidTo = async (j: Job, wallet: Address) =>
  balance(await findAssociatedTokenAddress({ owner: wallet, mint: j.w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }));

export const releasedIn = (signature: unknown) => {
  const landed = h.svm.getTransaction(signature as Signature);
  if (!(landed instanceof TransactionMetadata)) {
    throw new Error("the settle did not land");
  }
  return landed
    .innerInstructions()
    .flat()
    .map((inner) => decodeEvent(new Uint8Array(inner.instruction().data())))
    .filter((event) => event !== null);
};

export const paidAnnouncement = (signature: unknown) => {
  const released = releasedIn(signature).find((event) => event.name === "DeliveryReleased");
  return (released?.fields as { announcement?: Address } | undefined)?.announcement;
};

export const PROCESS_WAIT = { timeout: 20_000, interval: 20 } as const;

export const PROCESS_TEST = { timeout: 30_000 } as const;

export const signalled = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const alive = (pid: number) => {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return process.platform !== "linux" && signalled(pid);
  }
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
};

export const gone = async (pid: number) => {
  try {
    await vi.waitFor(() => expect(alive(pid)).toBe(false), PROCESS_WAIT);
  } catch {
    return false;
  }
  return true;
};

export const status = (intent: Address) => {
  const account = h.svm.getAccount(intent);
  return account.exists ? getIntentDecoder().decode(account.data).status : undefined;
};
