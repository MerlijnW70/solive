import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type Address, createKeyPairSignerFromBytes, type TransactionPartialSigner } from "@solana/kit";
import { getTransferSolInstruction, SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { formatAmount } from "@intent-engine/core";
import { findIntentPda } from "@intent-engine/core/internal";
import type { Transport } from "@intent-engine/client";
import { rentExemptFor, rentSysvar } from "@intent-engine/client/internal";
import { previewed } from "./admin-commands.js";
import { parse } from "./args.js";
import type { Command } from "./command-types.js";
import { run } from "./commands.js";
import { FlowRefused } from "./flows.js";
import type { Runtime } from "./runtime.js";
import { expandHome, newKeyFile, settingsDir } from "./wallet.js";
import { belowRent } from "./wallet-commands.js";

type JobCreate = Extract<Command, { name: "job-create" }>;

const SOL_DECIMALS = 9;
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export const BACKUP_DIR_ENV = "INTENT_ENGINE_BACKUP_DIR";
export const JOB_EXISTS = "this job already has its escrow, so nothing was sent";
export const JOB_PREVIEW = "nothing was sent; pass --yes to fund the worker key and create the escrow";

export const specEmpty = (path: string) => `--spec ${path} is empty, so no worker could deliver against it; nothing was sent`;
export const specCrlf = (path: string) =>
  `--spec ${path} has CR line ends, so its sha256 differs from the same text with LF line ends that workers and judges hash; convert it to LF and run again; nothing was sent`;
export const specChanged = (job: string, kept: string, now: string, path: string) =>
  `job ${job} pins the spec sha256 ${kept}, but --spec now hashes to ${now}; keep the spec as it was, or name a new job; nothing was sent (job file ${path})`;
export const jobFileBroken = (path: string) => `${path} is not a job file this CLI wrote; move it away or name another job; nothing was sent`;
export const backupDiffers = (backup: string, key: string) =>
  `${backup} holds another key than ${key}; a backup is never overwritten, so move it away or name another worker key; nothing was funded`;
export const backupReadBack = (backup: string) => `the backup ${backup} reads back with other bytes than the key it copies, so the key is not funded; check that folder and run again`;
export const backupNeeded = `job create backs the worker key up before funding it; pass --backup-dir <folder> or set ${BACKUP_DIR_ENV}`;

export type JobFile = {
  job: string;
  state: "creating" | "created";
  spec: string;
  spec_sha256: string;
  judge: Address;
  worker: string;
  worker_address: Address;
  worker_keypair: string;
  worker_backup: string;
  amount: string;
  nonce: string;
  intent: Address;
  fund_signature: string | null;
  escrow_signature: string | null;
  created_at: string;
};

const sha256Of = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

export const jobFilePath = (dir: string, job: string) => `${dir}/${job}.json`;

const dirOf = (runtime: Runtime, given: string | undefined, fallback: string): string => expandHome(given ?? fallback, runtime.home).replace(/[\\/]+$/, "");

async function specOf(path: string): Promise<{ bytes: Buffer; sha256: string }> {
  const bytes = await readFile(resolve(path));
  const sha256 = sha256Of(bytes);
  if (bytes.length === 0 || sha256 === EMPTY_SHA256) {
    throw new FlowRefused(specEmpty(path));
  }
  if (bytes.includes(0x0d)) {
    throw new FlowRefused(specCrlf(path));
  }
  return { bytes, sha256 };
}

async function readJob(runtime: Runtime, path: string): Promise<JobFile | null> {
  let text: string;
  try {
    text = await runtime.readText(path);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as Partial<JobFile>;
    if (typeof parsed.job === "string" && typeof parsed.spec_sha256 === "string" && typeof parsed.nonce === "string" && typeof parsed.intent === "string" && (parsed.state === "creating" || parsed.state === "created")) {
      return parsed as JobFile;
    }
  } catch {
    throw new FlowRefused(jobFileBroken(path));
  }
  throw new FlowRefused(jobFileBroken(path));
}

const readOr = async (runtime: Runtime, path: string): Promise<string | null> => runtime.readText(path).then((text) => text, () => null);

type Worker = { name: string; address: Address; keypair: string; backup: string; created: boolean; backed: boolean };

async function workerKey(runtime: Runtime, name: string, keysDir: string, backupDir: string): Promise<Worker> {
  const keypair = `${keysDir}/${name}.json`;
  const backup = `${backupDir}/${name}.json`;
  let text = await readOr(runtime, keypair);
  const created = text === null;
  if (text === null) {
    text = (await newKeyFile()).text;
    await runtime.saveText(keypair, text, true);
    text = await runtime.readText(keypair);
  }
  const address = (await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(text) as number[]))).address;
  const kept = await readOr(runtime, backup);
  if (kept !== null && sha256Of(kept) !== sha256Of(text)) {
    throw new FlowRefused(backupDiffers(backup, keypair));
  }
  if (kept === null) {
    await runtime.saveText(backup, text, true);
  }
  const back = await readOr(runtime, backup);
  if (back === null || sha256Of(back) !== sha256Of(text)) {
    throw new FlowRefused(backupReadBack(backup));
  }
  return { name, address, keypair, backup, created, backed: kept === null };
}

async function funding(transport: Transport, hirer: TransactionPartialSigner, worker: Address, target: bigint, yes: boolean): Promise<{ signature?: string; [field: string]: unknown }> {
  const held = (await transport.getAccount(worker))?.lamports ?? 0n;
  const sol = (lamports: bigint) => formatAmount(lamports, SOL_DECIMALS);
  if (held >= target) {
    return { holds: sol(held), sent: false, summary: [`Funds: nothing; ${worker} already holds ${sol(held)} SOL, at least the ${sol(target)} SOL asked`] };
  }
  const account = await transport.getAccount(worker);
  if (account !== null && account.owner !== SYSTEM_PROGRAM_ADDRESS) {
    throw new FlowRefused(`${worker} is not a wallet account, so it cannot be funded; nothing was sent`);
  }
  const lamports = target - held;
  if (account === null) {
    const least = rentExemptFor(await rentSysvar(transport), 0);
    if (lamports < least) {
      throw new FlowRefused(belowRent(worker, least));
    }
  }
  const instruction = getTransferSolInstruction({ source: hirer, destination: worker, amount: lamports });
  const summary = [`Funds: sends ${sol(lamports)} SOL from ${hirer.address} to the worker key ${worker}, so it holds ${sol(target)} SOL; the sender pays the network fee`];
  return (await previewed(transport, [instruction], hirer, { holds: sol(held), sends: sol(lamports), summary }, yes)) as { signature?: string };
}

function escrowArgv(command: JobCreate, judge: Address, sha256: string, nonce: string | undefined, yes: boolean): string[] {
  return [
    "create",
    "attested",
    "--url",
    command.url,
    "--keypair",
    command.keypair,
    "--input-mint",
    "SOL",
    "--output-mint",
    "TEST",
    "--units",
    "tokens",
    "--amount-in",
    command.amount,
    "--min-result",
    "1",
    "--max-result",
    "1",
    "--attestor",
    judge,
    "--spec-hash",
    sha256,
    "--spec-file",
    command.spec,
    "--expires-in",
    command.expiresIn,
    ...(command.noPublishSpec ? ["--no-publish-spec"] : []),
    ...(nonce === undefined ? [] : ["--nonce", nonce]),
    ...(yes ? ["--yes"] : []),
  ];
}

const escrowRun = async (command: JobCreate, runtime: Runtime, judge: Address, sha256: string, nonce: string | undefined, yes: boolean) =>
  (await run({ ...parse(escrowArgv(command, judge, sha256, nonce, yes), {}), priority: command.priority } as Command, runtime)) as Record<string, unknown>;

const intentAt = async (owner: Address, nonce: bigint): Promise<Address> => (await findIntentPda({ owner, nonce }))[0];

const existing = (path: string, job: JobFile) => ({ ...job, job_file: path, existing: true, sent: false, next: JOB_EXISTS });

export async function jobCreate(command: JobCreate, runtime: Runtime, transport: Transport): Promise<object> {
  const jobsDir = dirOf(runtime, command.jobsDir, `${settingsDir(runtime.home)}/jobs`);
  const keysDir = dirOf(runtime, command.keysDir, `${settingsDir(runtime.home)}/job-keys`);
  const backupGiven = command.backupDir ?? runtime.env[BACKUP_DIR_ENV];
  if (backupGiven === undefined || backupGiven === "") {
    throw new FlowRefused(backupNeeded);
  }
  const backupDir = dirOf(runtime, backupGiven, backupGiven);
  const spec = await specOf(command.spec);
  const path = jobFilePath(jobsDir, command.job);
  const kept = await readJob(runtime, path);
  if (kept !== null && kept.spec_sha256 !== spec.sha256) {
    throw new FlowRefused(specChanged(command.job, kept.spec_sha256, spec.sha256, path));
  }
  const hirer = await runtime.loadSigner(command.keypair);
  if (kept !== null && kept.state === "created") {
    return existing(path, kept);
  }
  if (kept !== null && (await transport.getAccount(kept.intent)) !== null) {
    const done: JobFile = { ...kept, state: "created" };
    await runtime.saveText(path, `${JSON.stringify(done, null, 2)}\n`, false);
    return existing(path, done);
  }
  const worker = await workerKey(runtime, command.workerKey, keysDir, backupDir);
  const shownWorker = { name: worker.name, address: worker.address, keypair: worker.keypair, backup: worker.backup, created: worker.created, backed_up: true };
  const fund = await funding(transport, hirer, worker.address, command.fund, command.yes);
  if (!command.yes) {
    const escrow = await escrowRun(command, runtime, hirer.address, spec.sha256, kept?.nonce, false);
    return { job: command.job, job_file: path, spec: command.spec, spec_sha256: spec.sha256, judge: hirer.address, worker: shownWorker, fund, escrow, sent: false, next: JOB_PREVIEW };
  }
  const nonce = kept?.nonce ?? String((await escrowRun(command, runtime, hirer.address, spec.sha256, undefined, false))["nonce"]);
  const pending: JobFile = {
    job: command.job,
    state: "creating",
    spec: command.spec,
    spec_sha256: spec.sha256,
    judge: hirer.address,
    worker: worker.name,
    worker_address: worker.address,
    worker_keypair: worker.keypair,
    worker_backup: worker.backup,
    amount: command.amount,
    nonce,
    intent: await intentAt(hirer.address, BigInt(nonce)),
    fund_signature: fund.signature ?? null,
    escrow_signature: null,
    created_at: new Date(Number(runtime.now()) * 1000).toISOString(),
  };
  await runtime.saveText(path, `${JSON.stringify(pending, null, 2)}\n`, false);
  const escrow = await escrowRun(command, runtime, hirer.address, spec.sha256, nonce, true);
  const done: JobFile = { ...pending, state: "created", escrow_signature: typeof escrow["signature"] === "string" ? escrow["signature"] : null };
  await runtime.saveText(path, `${JSON.stringify(done, null, 2)}\n`, false);
  return { job: command.job, job_file: path, spec: command.spec, spec_sha256: spec.sha256, judge: hirer.address, worker: shownWorker, fund, escrow, intent: done.intent, nonce, sent: true };
}
