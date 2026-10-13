import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Address, Signature } from "@solana/kit";
import { decodeParams, IntentStatus, Kind, type ManifestEntry, manifestSha256 } from "@intent-engine/core";
import { chainTime, createClient, deliveriesOf, firstDelivery, loadIntent, type Transport } from "@intent-engine/client";
import { type Command, ENV_KEYPAIR } from "./args.js";
import { NOT_SENT } from "./flows.js";
import type { Runtime } from "./commands.js";

export const SKIPPED = new Set([".git", "node_modules", "target"]);
export const ENV_SPEC_PATH = "SPEC_PATH";
export const ENV_ARTIFACT_PATH = "ARTIFACT_PATH";
export const ENV_ARTIFACT_SHA256 = "ARTIFACT_SHA256";

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
};

export type Check = { exitCode: number | null; timedOut: boolean };

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

async function filesUnder(root: string, prefix: string): Promise<ManifestEntry[]> {
  const entries: ManifestEntry[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) {
      continue;
    }
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      entries.push(...(await filesUnder(full, path)));
    } else if (entry.isFile()) {
      entries.push({ path, bytes: await readFile(full) });
    } else {
      throw new JudgeRefused(`the artifact holds ${path}, which is neither a regular file nor a directory; the judge hashes only those`);
    }
  }
  return entries;
}

export async function artifactSha256(path: string): Promise<string> {
  const found = await stat(path);
  if (found.isFile()) {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  }
  if (found.isDirectory()) {
    return manifestSha256(await filesUnder(path, ""));
  }
  throw new JudgeRefused(`--artifact ${path} is neither a regular file nor a directory`);
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => undefined);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    return;
  }
}

export function runCheck(command: string, env: NodeJS.ProcessEnv, timeoutSeconds: number): Promise<Check> {
  return new Promise((done, failed) => {
    const child = spawn(command, { shell: true, env, stdio: ["ignore", 2, 2], detached: process.platform !== "win32", windowsHide: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutSeconds * 1000);
    child.once("error", (error) => {
      clearTimeout(timer);
      failed(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      killTree(child.pid);
      done({ exitCode: timedOut ? null : code, timedOut });
    });
  });
}

export function checkEnv(base: NodeJS.ProcessEnv, spec: string, artifact: string, sha256: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, [ENV_SPEC_PATH]: spec, [ENV_ARTIFACT_PATH]: artifact, [ENV_ARTIFACT_SHA256]: sha256 };
  delete env[ENV_KEYPAIR];
  return env;
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
  const spec = resolve(command.spec);
  const specSha256 = createHash("sha256").update(await readFile(spec)).digest("hex");
  if (specSha256 !== specHash) {
    throw new JudgeRefused(`--spec ${command.spec} has sha256 ${specSha256}, but intent ${address} commits ${specHash}`);
  }
  const artifact = resolve(command.artifact);
  const sha256 = await artifactSha256(artifact);
  const first = firstDelivery(await deliveriesOf(transport, signer.address, address), sha256);
  const payTo = command.payTo ?? first?.worker;
  if (payTo === undefined) {
    throw new JudgeRefused(`nobody announced the artifact with sha256 ${sha256} for intent ${address}; pass --pay-to to pay a worker who did not announce it`);
  }
  if (first !== null && first.worker !== payTo) {
    throw new JudgeRefused(`${first.worker} announced the artifact with sha256 ${sha256} first, in ${first.signature}; it is paid, not --pay-to ${payTo}`);
  }
  const check = await runCheck(command.run, checkEnv(process.env, spec, artifact, sha256), command.timeout);
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
  };
  if (command.verdict !== undefined) {
    await writeFile(command.verdict, `${JSON.stringify(verdict, null, 2)}\n`);
  }
  return verdict;
}
