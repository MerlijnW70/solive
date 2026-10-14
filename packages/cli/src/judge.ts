import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Address, Signature } from "@solana/kit";
import { decodeParams, IntentStatus, Kind, type ManifestEntry, manifestSha256 } from "@intent-engine/core";
import { chainTime, createClient, deliveryRecord, firstDelivery, loadIntent, type Transport } from "@intent-engine/client";
import type { Command } from "./args.js";
import { NOT_SENT } from "./flows.js";
import type { Runtime } from "./commands.js";

export const SKIPPED = new Set([".git", "node_modules", "target"]);
export const ENV_SPEC_PATH = "SPEC_PATH";
export const ENV_ARTIFACT_PATH = "ARTIFACT_PATH";
export const ENV_ARTIFACT_SHA256 = "ARTIFACT_SHA256";
export const SPEC_COPY = "SPEC.md";
export const CLEANUP_RETRIES = 5;
export const CHECK_ENV = ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR", "LANG", "TERM"] as const;

export class JudgeRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "JudgeRefused";
  }
}

export type JudgeCommand = Extract<Command, { name: "judge" }>;

export type Verdict = {
  intent: Address;
  specHash: string;
  artifactSha256: string;
  command: string;
  exitCode: number | null;
  verdict: "pass" | "fail";
  payTo: Address;
  signature: Signature | null;
  next?: string;
  cleanup?: string;
};

export type Check = { exitCode: number | null; timedOut: boolean };

export type CheckOptions = { cwd?: string; interrupted?: () => Promise<unknown> };

const EXECUTABLE = 0o111;

type CopiedEntry = ManifestEntry & { executable: number };

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

async function readEntry(path: string, full: string): Promise<CopiedEntry> {
  const handle = await open(full, "r");
  try {
    const { mode } = await handle.stat();
    return { path, bytes: await handle.readFile(), executable: mode & EXECUTABLE };
  } finally {
    await handle.close();
  }
}

async function filesUnder(root: string, prefix: string): Promise<CopiedEntry[]> {
  const entries: CopiedEntry[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) {
      continue;
    }
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      entries.push(...(await filesUnder(full, path)));
    } else if (entry.isFile()) {
      entries.push(await readEntry(path, full));
    } else {
      throw new JudgeRefused(`the artifact holds ${path}, which is neither a regular file nor a directory; the judge hashes only those`);
    }
  }
  return entries;
}

type Artifact = { sha256: string; entries: CopiedEntry[]; single: boolean };

async function readArtifact(path: string): Promise<Artifact> {
  const found = await stat(path);
  if (found.isFile()) {
    const entry = await readEntry(basename(path), path);
    return { sha256: createHash("sha256").update(entry.bytes).digest("hex"), entries: [entry], single: true };
  }
  if (found.isDirectory()) {
    const entries = await filesUnder(path, "");
    return { sha256: await manifestSha256(entries), entries, single: false };
  }
  throw new JudgeRefused(`--artifact ${path} is neither a regular file nor a directory`);
}

export async function artifactSha256(path: string): Promise<string> {
  return (await readArtifact(path)).sha256;
}

type Copy = { root: string; path: string; spec: string };

export async function removeCopy(root: string): Promise<string | undefined> {
  try {
    await rm(root, { recursive: true, force: true, maxRetries: CLEANUP_RETRIES });
    return undefined;
  } catch (error) {
    return `the artifact copy at ${root} could not be removed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function copyOf(artifact: Artifact, specBytes: Uint8Array): Promise<Copy> {
  const root = await mkdtemp(join(tmpdir(), "judge-artifact-"));
  const work = join(root, "work");
  const spec = join(root, "spec", SPEC_COPY);
  try {
    await mkdir(work);
    await mkdir(dirname(spec));
    await writeFile(spec, specBytes);
    for (const entry of artifact.entries) {
      const target = join(work, ...entry.path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, entry.bytes);
      if (entry.executable !== 0) {
        await chmod(target, ((await stat(target)).mode & 0o777) | entry.executable);
      }
    }
  } catch (error) {
    await removeCopy(root);
    throw error;
  }
  const [only] = artifact.entries;
  return { root, spec, path: artifact.single && only !== undefined ? join(work, only.path) : work };
}

function killTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) {
    return Promise.resolve();
  }
  if (process.platform === "win32") {
    return new Promise((done) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.once("error", () => done());
      killer.once("exit", () => done());
    });
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    return Promise.resolve();
  }
  return Promise.resolve();
}

const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143 } as const;

export function runCheck(command: string, env: NodeJS.ProcessEnv, timeoutSeconds: number, options: CheckOptions = {}): Promise<Check> {
  return new Promise((done, failed) => {
    const child = spawn(command, {
      shell: true,
      env,
      cwd: options.cwd,
      stdio: ["ignore", 2, 2],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let timedOut = false;
    let killing: Promise<void> = Promise.resolve();
    const handlers = (Object.keys(SIGNAL_EXIT) as (keyof typeof SIGNAL_EXIT)[]).map((signal) => {
      const handler = () => {
        void killTree(child.pid)
          .then(() => options.interrupted?.())
          .finally(() => process.exit(SIGNAL_EXIT[signal]));
      };
      process.once(signal, handler);
      return [signal, handler] as const;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killing = killTree(child.pid);
    }, timeoutSeconds * 1000);
    const settle = () => {
      clearTimeout(timer);
      for (const [signal, handler] of handlers) {
        process.removeListener(signal, handler);
      }
    };
    child.once("error", (error) => {
      settle();
      void killing.finally(() => failed(error));
    });
    child.once("exit", (code) => {
      settle();
      const after = process.platform !== "win32" ? killTree(child.pid) : Promise.resolve();
      void Promise.all([killing, after]).finally(() => done({ exitCode: timedOut ? null : code, timedOut }));
    });
  });
}

export function checkEnv(base: NodeJS.ProcessEnv, spec: string, artifact: string, sha256: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CHECK_ENV) {
    const value = base[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return { ...env, [ENV_SPEC_PATH]: spec, [ENV_ARTIFACT_PATH]: artifact, [ENV_ARTIFACT_SHA256]: sha256 };
}

async function escrowFor(transport: Transport, judge: Address, owner: Address, nonce: bigint) {
  const { address, intent } = await loadIntent(transport, owner, nonce);
  const params = decodeParams(intent.kind, Uint8Array.from(intent.params));
  if (params.kind !== Kind.AttestedResult || params.specHash.every((b) => b === 0)) {
    throw new JudgeRefused(`intent ${address} is not a proof escrow: an AttestedResult intent that commits a spec hash`);
  }
  if (intent.status !== IntentStatus.Open || intent.expiresAt <= (await chainTime(transport))) {
    throw new JudgeRefused(`intent ${address} is no longer open`);
  }
  if (params.attestor !== judge) {
    throw new JudgeRefused(`intent ${address} names ${params.attestor} as its judge, not ${judge}`);
  }
  return { address, specHash: hex(params.specHash) };
}

export async function judge(command: JudgeCommand, runtime: Runtime, transport: Transport): Promise<Verdict> {
  const signer = await runtime.loadSigner(command.keypair);
  const { address, specHash } = await escrowFor(transport, signer.address, command.owner, command.nonce);
  const specBytes = await readFile(resolve(command.spec));
  const specSha256 = createHash("sha256").update(specBytes).digest("hex");
  if (specSha256 !== specHash) {
    throw new JudgeRefused(`--spec ${command.spec} has sha256 ${specSha256}, but intent ${address} commits ${specHash}`);
  }
  const artifact = resolve(command.artifact);
  const read = await readArtifact(artifact);
  const sha256 = read.sha256;
  const record = await deliveryRecord(transport, signer.address, address);
  if (!record.complete) {
    throw new JudgeRefused(
      `the judge's history is too long to read in full, so the earliest announcer of the artifact with sha256 ${sha256} for intent ${address} cannot be known; nothing was run or paid`,
    );
  }
  const first = firstDelivery(record.deliveries, sha256);
  const payTo = command.payTo ?? first?.worker;
  if (payTo === undefined) {
    throw new JudgeRefused(`nobody announced the artifact with sha256 ${sha256} for intent ${address}; pass --pay-to to pay a worker who did not announce it`);
  }
  if (first !== null && first.worker !== payTo) {
    throw new JudgeRefused(`${first.worker} announced the artifact with sha256 ${sha256} first, in ${first.signature}; it is paid, not --pay-to ${payTo}`);
  }
  const copy = await copyOf(read, specBytes);
  let check: Check;
  let cleanup: string | undefined;
  try {
    check = await runCheck(command.run, checkEnv(process.env, copy.spec, copy.path, sha256), command.timeout, {
      cwd: copy.root,
      interrupted: () => removeCopy(copy.root),
    });
  } finally {
    cleanup = await removeCopy(copy.root);
  }
  const passed = check.exitCode === 0;
  const signature =
    passed && command.yes
      ? await createClient({ url: command.url, transport }).settleProof({
          judge: signer,
          owner: command.owner,
          nonce: command.nonce,
          payTo,
          result: 1n,
          deliveredSha256: sha256,
        })
      : null;
  const verdict: Verdict = {
    intent: address,
    specHash,
    artifactSha256: sha256,
    command: command.run,
    exitCode: check.exitCode,
    verdict: passed ? "pass" : "fail",
    payTo,
    signature,
    ...(passed && !command.yes ? { next: NOT_SENT } : {}),
    ...(cleanup !== undefined ? { cleanup } : {}),
  };
  if (command.verdict !== undefined) {
    await writeFile(command.verdict, `${JSON.stringify(verdict, null, 2)}\n`);
  }
  return verdict;
}
