import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { type Address, getBase58Decoder, type KeyPairSigner, type Signature } from "@solana/kit";
import { decodeParams, IntentStatus, Kind, type ManifestEntry, manifestSha256 } from "@intent-engine/core";
import { chainTime, createClient, deliveryRecord, firstDelivery, loadIntent, SIGNATURE_PAGE, type Transport } from "@intent-engine/client";
import type { Command } from "./args.js";
import { NOT_SENT } from "./flows.js";
import type { Runtime } from "./commands.js";

export const SKIPPED = new Set([".git", "node_modules", "target"]);
export const ENV_SPEC_PATH = "SPEC_PATH";
export const ENV_ARTIFACT_PATH = "ARTIFACT_PATH";
export const ENV_ARTIFACT_SHA256 = "ARTIFACT_SHA256";
export const SPEC_COPY = "SPEC.md";
export const CLEANUP_RETRIES = 5;
const SESSION_ROUNDS = 10;
const STARTED_FIELD = 19;
const SCAN_MS = 250;
const ROUND_PAUSE_MS = 10;
const FORCED_EXIT_MS = 200;
export const CHECK_ENV = ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR", "LANG", "TERM"] as const;

export class JudgeRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "JudgeRefused";
  }
}

export class JudgeInterrupted extends Error {
  readonly exitCode: number;

  constructor(signal: InterruptSignal, reason?: string) {
    super(reason ?? `the check was interrupted by ${signal}; nothing was paid and no verdict was written`);
    this.name = "JudgeInterrupted";
    this.exitCode = SIGNAL_EXIT[signal];
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

export const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143 } as const;

export type InterruptSignal = keyof typeof SIGNAL_EXIT;

export type Check = { exitCode: number | null; timedOut: boolean; interrupted?: InterruptSignal; escaped?: number[] };

export type CheckOptions = { cwd?: string };

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

const quietly = (pid: number) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
};

export type Running = { pid: number; parent: number; group: number; session: number; started: number; zombie: boolean };

export type Recorded = { started: Map<number, number>; leaders: Map<number, number> };

function parseStat(pid: number, line: string): Running {
  const fields = line.slice(line.lastIndexOf(")") + 2).split(" ");
  const [state, parent, group, session] = fields;
  return { pid, parent: Number(parent), group: Number(group), session: Number(session), started: Number(fields[STARTED_FIELD]), zombie: state === "Z" };
}

function statOf(pid: number): Running | null {
  try {
    return parseStat(pid, readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

async function processTable(): Promise<Running[] | null> {
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return null;
  }
  const found = await Promise.all(
    entries
      .filter((entry) => /^\d+$/.test(entry))
      .map(async (entry): Promise<Running | null> => {
        try {
          return parseStat(Number(entry), await readFile(`/proc/${entry}/stat`, "utf8"));
        } catch {
          return null;
        }
      }),
  );
  return found.filter((running) => running !== null);
}

export function claim(table: readonly Running[], recorded: Recorded): Running[] {
  const byPid = new Map(table.map((running) => [running.pid, running]));
  for (const records of [recorded.started, recorded.leaders]) {
    for (const [pid, started] of records) {
      if ((byPid.get(pid)?.started ?? started) !== started) {
        records.delete(pid);
      }
    }
  }
  const leads = (leader: number) => {
    const started = recorded.started.get(leader);
    return started !== undefined && byPid.get(leader)?.started === started;
  };
  const owned = new Set<number>();
  const inSession = (running: Running) => {
    if (owned.has(running.session)) {
      return true;
    }
    const started = recorded.leaders.get(running.session);
    return started !== undefined && !byPid.has(running.session) && running.started >= started;
  };
  let grew = true;
  while (grew) {
    grew = false;
    for (const running of table) {
      if (running.pid !== process.pid && !owned.has(running.pid) && (leads(running.pid) || owned.has(running.parent) || inSession(running) || leads(running.group))) {
        owned.add(running.pid);
        grew = true;
      }
    }
  }
  const claimed = table.filter((running) => owned.has(running.pid));
  for (const running of claimed) {
    recorded.started.set(running.pid, running.started);
    if (running.pid === running.session) {
      recorded.leaders.set(running.pid, running.started);
    }
  }
  return claimed;
}

function pkillSession(session: number): Promise<void> {
  return new Promise((done) => {
    const killer = spawn("pkill", ["-KILL", "-s", String(session)], { stdio: "ignore" });
    killer.once("error", () => done());
    killer.once("exit", () => done());
  });
}

function listed(command: string, args: readonly string[]): Promise<number[] | null> {
  return new Promise((done) => {
    const lister = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    lister.stdout.setEncoding("utf8");
    lister.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    lister.once("error", () => done(null));
    lister.once("close", (code) => {
      done(code === 0 || code === 1 ? out.split(/\s+/).filter((field) => /^\d+$/.test(field)).map(Number) : null);
    });
  });
}

async function sessionMembers(session: number): Promise<number[]> {
  const found = (await listed("pgrep", ["-s", String(session)])) ?? (await listed("ps", ["-o", "pid=", "-g", String(session)])) ?? [];
  return [...new Set(found)].filter((pid) => pid !== process.pid && pid !== session);
}

type Watch = { pid: number; started: number | null; recorded: Recorded; alive: boolean; marker: string | undefined; cwd: string | undefined };

const living = (running: Running) => !running.zombie;

async function marked(running: Running, watch: Watch): Promise<boolean> {
  if (watch.marker !== undefined) {
    try {
      if ((await readFile(`/proc/${running.pid}/environ`, "utf8")).split("\0").includes(watch.marker)) {
        return true;
      }
    } catch {
      return false;
    }
  }
  if (watch.cwd !== undefined) {
    try {
      const at = await readlink(`/proc/${running.pid}/cwd`);
      return at === watch.cwd || at.startsWith(`${watch.cwd}/`);
    } catch {
      return false;
    }
  }
  return false;
}

export const leftRunning = (pids: readonly number[]): string =>
  `warning: the check left processes running that the judge could not tie to it, so it did not kill them: ${pids.join(", ")}; stop them by hand`;

export const stillRunning = (pids: readonly number[]): string =>
  `warning: processes started by the check were still running after ${SESSION_ROUNDS} kill rounds: ${pids.join(", ")}; stop them by hand`;

async function escapedFrom(table: readonly Running[], owned: readonly Running[], watch: Watch): Promise<number[]> {
  const { started } = watch;
  if (started === null) {
    return [];
  }
  const ours = new Set(owned.map((running) => running.pid));
  const candidates = table.filter((running) => living(running) && running.pid !== process.pid && !ours.has(running.pid) && running.started >= started);
  const found = await Promise.all(candidates.map(async (running) => ((await marked(running, watch)) ? running.pid : null)));
  return found.filter((pid) => pid !== null);
}

const warn = (text: string) => {
  process.stderr.write(`${text}\n`);
};

async function sweep(watch: Watch, report: boolean): Promise<number[]> {
  for (let round = 0; round <= SESSION_ROUNDS; round++) {
    const table = await processTable();
    if (table === null || watch.started === null) {
      if (watch.alive) {
        quietly(-watch.pid);
        await pkillSession(watch.pid);
        return [];
      }
      if (!report) {
        return [];
      }
      const left = await sessionMembers(watch.pid);
      if (left.length > 0) {
        warn(leftRunning(left));
      }
      return left;
    }
    const owned = claim(table, watch.recorded);
    const live = owned.filter(living);
    if (live.length === 0 || round === SESSION_ROUNDS) {
      if (live.length > 0) {
        warn(stillRunning(live.map((running) => running.pid)));
      }
      if (!report) {
        return [];
      }
      const escaped = await escapedFrom(table, owned, watch);
      if (escaped.length > 0) {
        warn(leftRunning(escaped));
      }
      return escaped;
    }
    live.forEach((running) => quietly(running.pid));
    await new Promise((wake) => setTimeout(wake, round * ROUND_PAUSE_MS));
  }
  return [];
}

function taskkill(pid: number): Promise<void> {
  return new Promise((done) => {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.once("error", () => done());
    killer.once("exit", () => done());
  });
}

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
    const windows = process.platform === "win32";
    const seed = child.pid === undefined || windows ? null : statOf(child.pid);
    const watch: Watch = {
      pid: child.pid ?? 0,
      started: seed?.started ?? null,
      recorded: {
        started: new Map(seed === null ? [] : [[seed.pid, seed.started]]),
        leaders: new Map(seed === null || seed.pid !== seed.session ? [] : [[seed.pid, seed.started]]),
      },
      alive: true,
      marker: env[ENV_SPEC_PATH] === undefined ? undefined : `${ENV_SPEC_PATH}=${env[ENV_SPEC_PATH]}`,
      cwd: options.cwd === undefined ? undefined : resolve(options.cwd),
    };
    let scanning: Promise<void> = Promise.resolve();
    let scanTimer: NodeJS.Timeout | undefined;
    const scan = () => {
      scanning = processTable().then((table) => {
        if (table !== null && watch.alive) {
          claim(table, watch.recorded);
        }
      });
      void scanning.finally(() => {
        if (watch.alive) {
          scanTimer = setTimeout(scan, SCAN_MS);
          scanTimer.unref();
        }
      });
    };
    if (seed !== null) {
      scan();
    }
    const stopScanning = () => {
      watch.alive = false;
      clearTimeout(scanTimer);
    };
    const kill = (): Promise<void> => {
      if (child.pid === undefined) {
        return Promise.resolve();
      }
      if (windows) {
        return taskkill(child.pid);
      }
      return scanning.then(() => sweep(watch, false)).then(() => undefined);
    };
    let timedOut = false;
    let interrupted: InterruptSignal | undefined;
    let killing: Promise<void> = Promise.resolve();
    const handlers = (Object.keys(SIGNAL_EXIT) as InterruptSignal[]).map((signal) => {
      const handler = () => {
        interrupted ??= signal;
        killing = kill();
      };
      process.on(signal, handler);
      return [signal, handler] as const;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killing = kill();
    }, timeoutSeconds * 1000);
    const settle = () => {
      for (const [signal, handler] of handlers) {
        process.removeListener(signal, handler);
      }
    };
    child.once("error", (error) => {
      clearTimeout(timer);
      void killing.finally(() => {
        stopScanning();
        settle();
        failed(error);
      });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      void killing.finally(async () => {
        stopScanning();
        let escaped: number[] = [];
        if (!windows && child.pid !== undefined) {
          await scanning.catch(() => undefined);
          escaped = await sweep(watch, true).catch(() => []);
        }
        settle();
        done({
          exitCode: timedOut || interrupted !== undefined ? null : code,
          timedOut,
          ...(interrupted === undefined ? {} : { interrupted }),
          ...(escaped.length === 0 ? {} : { escaped }),
        });
      });
    });
  });
}

type SignalListener = (signal: InterruptSignal) => void;

type HeldSignals = { caught(): InterruptSignal | undefined; listen(listener: SignalListener): void; release(): void };

function holdSignals(): HeldSignals {
  let caught: InterruptSignal | undefined;
  let listener: SignalListener | undefined;
  const handlers = (Object.keys(SIGNAL_EXIT) as InterruptSignal[]).map((signal) => {
    const handler = () => {
      caught ??= signal;
      listener?.(signal);
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  return {
    caught: () => caught,
    listen: (next) => {
      listener = next;
    },
    release: () => {
      for (const [signal, handler] of handlers) {
        process.removeListener(signal, handler);
      }
    },
  };
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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

export const pagesRead = (pages: number): string =>
  `It read ${pages} ${pages === 1 ? "page" : "pages"} of ${SIGNATURE_PAGE} signatures; a higher --max-pages reads further, but does not help when the RPC node's ledger does not reach back to the escrow's creation or the node cannot page signatures or report its first available slot`;

export const resultOutside = (result: bigint, intent: Address, min: bigint, max: bigint): string =>
  `--result ${result} lies outside the results intent ${intent} accepts, ${min} to ${max}; nothing was run or paid`;

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
  return { address, specHash: hex(params.specHash), minResult: params.minResult, maxResult: params.maxResult };
}

export async function judge(command: JudgeCommand, runtime: Runtime, transport: Transport): Promise<Verdict> {
  if (command.verdict !== undefined) {
    await rm(command.verdict, { force: true });
  }
  const signer = await runtime.loadSigner(command.keypair);
  const { address, specHash, minResult, maxResult } = await escrowFor(transport, signer.address, command.owner, command.nonce);
  const result = command.result ?? minResult;
  if (result < minResult || result > maxResult) {
    throw new JudgeRefused(resultOutside(result, address, minResult, maxResult));
  }
  const specBytes = await readFile(resolve(command.spec));
  const specSha256 = createHash("sha256").update(specBytes).digest("hex");
  if (specSha256 !== specHash) {
    throw new JudgeRefused(`--spec ${command.spec} has sha256 ${specSha256}, but intent ${address} commits ${specHash}`);
  }
  const artifact = resolve(command.artifact);
  const read = await readArtifact(artifact);
  const sha256 = read.sha256;
  const record = await deliveryRecord(transport, signer.address, address, command.maxPages);
  if (!record.complete) {
    throw new JudgeRefused(
      `the delivery record is incomplete because the judge's history is too long to read in full or the RPC node cannot serve all of it, so the earliest announcer of the artifact with sha256 ${sha256} for intent ${address} cannot be known; nothing was run or paid. ${pagesRead(record.pages)}`,
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
  const signals = holdSignals();
  try {
    return await checkAndSettle(command, transport, signer, signals, { address, specHash, sha256, payTo, result, read, specBytes });
  } finally {
    signals.release();
  }
}

export const notSent = (signal: InterruptSignal): string =>
  `the check passed, but ${signal} arrived before the release was sent; nothing was paid and no verdict was written`;

export const mayHaveLanded = (signal: InterruptSignal, address: Address, signature: Signature | undefined): string =>
  `the check passed and the release was sent${signature === undefined ? "" : ` in ${signature}`}; a second ${signal} stopped the judge before the send was confirmed, so the release may have landed. Read intent ${address} before judging it again; no verdict was written`;

type Release = { address: Address; payTo: Address; result: bigint; sha256: string };

function sendRelease(command: JudgeCommand, transport: Transport, signer: KeyPairSigner, signals: HeldSignals, release: Release): Promise<Signature> {
  return new Promise((done, failed) => {
    let sent = false;
    let signature: Signature | undefined;
    let after = 0;
    const signTransactions: KeyPairSigner["signTransactions"] = async (transactions, config) => {
      const caught = signals.caught();
      if (caught !== undefined) {
        throw new JudgeInterrupted(caught, notSent(caught));
      }
      sent = true;
      const signed = await signer.signTransactions(transactions, config);
      const own = signed[0]?.[signer.address];
      signature = own === undefined ? signature : (getBase58Decoder().decode(own) as Signature);
      return signed;
    };
    signals.listen((signal) => {
      if (!sent) {
        failed(new JudgeInterrupted(signal, notSent(signal)));
        return;
      }
      after += 1;
      if (after > 1) {
        failed(new JudgeInterrupted(signal, mayHaveLanded(signal, release.address, signature)));
        setTimeout(() => process.exit(SIGNAL_EXIT[signal]), FORCED_EXIT_MS).unref();
      }
    });
    createClient({ url: command.url, transport })
      .settleProof({
        judge: Object.freeze({ ...signer, signTransactions }),
        owner: command.owner,
        nonce: command.nonce,
        payTo: release.payTo,
        result: release.result,
        deliveredSha256: release.sha256,
      })
      .then((confirmed) => {
        signals.listen(() => undefined);
        done(confirmed);
      }, failed);
  });
}

type Judged = { address: Address; specHash: string; sha256: string; payTo: Address; result: bigint; read: Artifact; specBytes: Uint8Array };

async function checkAndSettle(
  command: JudgeCommand,
  transport: Transport,
  signer: KeyPairSigner,
  signals: HeldSignals,
  { address, specHash, sha256, payTo, result, read, specBytes }: Judged,
): Promise<Verdict> {
  const copy = await copyOf(read, specBytes);
  let check: Check = { exitCode: null, timedOut: false };
  let cleanup: string | undefined;
  try {
    if (signals.caught() === undefined) {
      check = await runCheck(command.run, checkEnv(process.env, copy.spec, copy.path, sha256), command.timeout, { cwd: copy.root });
    }
  } finally {
    cleanup = await removeCopy(copy.root);
  }
  const interrupted = check.interrupted ?? signals.caught();
  if (interrupted !== undefined) {
    throw new JudgeInterrupted(interrupted);
  }
  const passed = check.exitCode === 0;
  let signature: Signature | null = null;
  if (passed && command.yes) {
    try {
      signature = await sendRelease(command, transport, signer, signals, { address, payTo, result, sha256 });
    } catch (error) {
      if (error instanceof JudgeInterrupted) {
        throw error;
      }
      const during = signals.caught();
      if (during !== undefined) {
        throw new JudgeInterrupted(
          during,
          `the check passed and ${during} arrived while the release was being sent; the send failed, but the release may have landed: ${reasonOf(error)}. Read intent ${address} before judging it again; no verdict was written`,
        );
      }
      throw error;
    }
  }
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
  const during = signals.caught();
  if (signature !== null && during !== undefined) {
    throw new JudgeInterrupted(
      during,
      `the check passed and ${during} arrived while the release was being sent; it was sent in ${signature}${command.verdict !== undefined ? ` and the verdict was written to ${command.verdict}` : ""}`,
    );
  }
  return verdict;
}
