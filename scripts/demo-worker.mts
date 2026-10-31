import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Demo = { name: string; specHash: string; solution: string; workUrl: string };

export type Cli = (args: readonly string[]) => Promise<unknown>;

export type DemoJob = {
  intent: string;
  owner: string;
  nonce: string;
  specHash: string;
  takesClaims: boolean;
  claimedBy: string | null;
  waiting: number;
  expiresAt: number;
  board?: Record<string, unknown>;
};

export type Found = { demo: Demo; job: DemoJob };

export type Rpc = (method: string, params: readonly unknown[]) => Promise<unknown>;

export type Read = (demos: readonly Demo[], now: number) => Promise<Found[]>;

export type Settings = { keypair: string; wallet: string; maxStake: bigint; claimSecs: number };

export type Ledger = { done: Set<string>; failures: Map<string, number>; noted: Set<string> };

export type Action = "claimed" | "delivered" | "skipped" | "failed" | "gave-up";

export type Event = { intent: string; demo: string; action: Action; detail?: string };

export type Log = { out: (line: string) => void; err: (line: string) => void };

export const SPEC_FILE = "SPEC.md";
export const SOLUTION_FILE = "solution.mjs";
export const MAX_FAILURES = 3;
export const CLAIM_MARGIN_SECS = 60;
export const MIN_CLAIM_SECS = 120;
export const FAST_INTERVAL_SECS = 15;
export const WATCH_RETRY_MS = 1_000;
export const FULL_INTERVAL_SECS = 300;
export const MAX_BACKOFF_MS = 60_000;
export const RPC_TIMEOUT_MS = 15_000;

export const CLUSTERS: Readonly<Record<string, string>> = {
  localnet: "http://127.0.0.1:8899",
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
};

export const INTENT_TAG = Uint8Array.from([247, 162, 35, 165, 254, 111, 129, 109]);
export const INTENT_SIZE = 464;
export const AT = { owner: 8, nonce: 136, expiresAt: 160, kind: 168, status: 169, specHash: 232, claims: 448 } as const;
export const CODE = { attestedResult: 4, open: 0, claimsOpen: 1 } as const;

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export async function loadDemos(dir: string, baseUrl: string): Promise<Demo[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  return Promise.all(
    names.map(async (name) => {
      const solution = join(dir, name, SOLUTION_FILE);
      await readFile(solution);
      return { name, specHash: sha256(await readFile(join(dir, name, SPEC_FILE))), solution, workUrl: `${baseUrl}/${name}/${SOLUTION_FILE}` };
    }),
  );
}

export const emptyLedger = (done: Iterable<string> = []): Ledger => ({ done: new Set(done), failures: new Map(), noted: new Set() });

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

const textOf = (value: unknown): string | null => (typeof value === "string" ? value : typeof value === "number" || typeof value === "bigint" ? String(value) : null);

function jobOf(value: unknown): DemoJob | null {
  const job = record(value);
  const [intent, owner, nonce, specHash, expiresAt] = ["intent", "owner", "nonce", "specHash", "expiresAt"].map((key) => textOf(job[key]));
  if (intent == null || owner == null || nonce == null || specHash == null || expiresAt == null) {
    return null;
  }
  const claimedBy = textOf(job["claimed_by"]);
  const waiting = Number(job["waiting"] ?? 0);
  return {
    intent,
    owner,
    nonce,
    specHash: specHash.toLowerCase(),
    takesClaims: job["takes_claims"] === true,
    claimedBy,
    waiting: Number.isFinite(waiting) ? waiting : 0,
    expiresAt: Number(expiresAt),
  };
}

export const jobsOf = (listed: unknown): DemoJob[] => {
  const jobs = record(listed)["jobs"];
  return Array.isArray(jobs) ? jobs.map(jobOf).filter((job): job is DemoJob => job !== null) : [];
};

const sentSignature = (output: unknown, what: string): string => {
  const shown = record(output);
  const signature = textOf(shown["signature"]);
  if (shown["sent"] !== true || signature === null) {
    throw new Error(`${what} sent nothing: ${textOf(shown["next"]) ?? JSON.stringify(output)}`);
  }
  return signature;
};

const boardOf = async (cli: Cli, job: DemoJob): Promise<Record<string, unknown>> => record(await cli(["claims", "show", "--owner", job.owner, "--nonce", job.nonce]));

export function heldOf(board: Record<string, unknown>): { claimedBy: string | null; waiting: number } {
  const waiting = Number(record(board["line"])["waiting"] ?? 0);
  return { claimedBy: board["state"] === "held" ? textOf(board["worker"]) : null, waiting: Number.isFinite(waiting) ? waiting : 0 };
}

async function claim(cli: Cli, demo: Demo, job: DemoJob, settings: Settings, now: number): Promise<Event | string> {
  if (job.claimedBy !== null || job.waiting > 0) {
    return "another worker holds or waits for its claim";
  }
  const board = job.board ?? (await boardOf(cli, job));
  const stake = BigInt(textOf(board["stake"]) ?? "0");
  if (stake > settings.maxStake) {
    return `its claim stake of ${stake} lamports is above this worker's cap of ${settings.maxStake}`;
  }
  const secs = Math.min(Number(board["max_secs"] ?? 0), settings.claimSecs, job.expiresAt - now - CLAIM_MARGIN_SECS);
  if (!(secs >= MIN_CLAIM_SECS)) {
    return "the escrow ends too soon, or lets a claim last too briefly, to claim it";
  }
  const taken = await cli(["claims", "take", "--keypair", settings.keypair, "--owner", job.owner, "--nonce", job.nonce, "--secs", String(Math.floor(secs)), "--yes"]);
  return { intent: job.intent, demo: demo.name, action: "claimed", detail: sentSignature(taken, "claims take") };
}

async function deliver(cli: Cli, demo: Demo, job: DemoJob, settings: Settings): Promise<Event> {
  const shown = record(await cli(["deliver", "--keypair", settings.keypair, "--intent", job.intent, "--artifact", demo.solution, "--work-url", demo.workUrl, "--yes"]));
  const detail = shown["sent"] === true ? sentSignature(shown, "deliver") : (textOf(shown["next"]) ?? "already announced");
  return { intent: job.intent, demo: demo.name, action: "delivered", detail };
}

async function work(cli: Cli, demo: Demo, job: DemoJob, settings: Settings, ledger: Ledger, now: number): Promise<Event[]> {
  const events: Event[] = [];
  if (job.takesClaims && job.claimedBy !== settings.wallet) {
    const claimed = await claim(cli, demo, job, settings, now);
    if (typeof claimed === "string") {
      if (ledger.noted.has(job.intent)) {
        return [];
      }
      ledger.noted.add(job.intent);
      return [{ intent: job.intent, demo: demo.name, action: "skipped", detail: claimed }];
    }
    events.push(claimed);
  }
  events.push(await deliver(cli, demo, job, settings));
  ledger.done.add(job.intent);
  return events;
}

function failed(demo: Demo, job: DemoJob, ledger: Ledger, error: unknown): Event {
  const failures = (ledger.failures.get(job.intent) ?? 0) + 1;
  ledger.failures.set(job.intent, failures);
  const gaveUp = failures >= MAX_FAILURES;
  if (gaveUp) {
    ledger.done.add(job.intent);
  }
  return { intent: job.intent, demo: demo.name, action: gaveUp ? "gave-up" : "failed", detail: error instanceof Error ? error.message : String(error) };
}

export function demosOf(demos: readonly Demo[], jobs: readonly DemoJob[]): Found[] {
  const byHash = new Map(demos.map((demo) => [demo.specHash, demo]));
  return jobs.flatMap((job) => {
    const demo = byHash.get(job.specHash);
    return demo === undefined ? [] : [{ demo, job }];
  });
}

export async function workJobs(cli: Cli, found: readonly Found[], settings: Settings, ledger: Ledger, now: number): Promise<Event[]> {
  const events: Event[] = [];
  for (const { demo, job } of found) {
    if (ledger.done.has(job.intent)) {
      continue;
    }
    try {
      events.push(...(await work(cli, demo, job, settings, ledger, now)));
    } catch (error) {
      events.push(failed(demo, job, ledger, error));
    }
  }
  return events;
}

export async function demoRound(cli: Cli, demos: readonly Demo[], settings: Settings, ledger: Ledger, now: number): Promise<Event[]> {
  return workJobs(cli, demosOf(demos, jobsOf(await cli(["jobs"]))), settings, ledger, now);
}

export const untouched = (ledger: Ledger, intent: string): boolean => !ledger.done.has(intent) && !ledger.noted.has(intent);

export async function fastRound(cli: Cli, read: Read, demos: readonly Demo[], settings: Settings, ledger: Ledger, now: number): Promise<Event[]> {
  return fastWork(cli, await read(demos, now), settings, ledger, now);
}

export async function fastWork(cli: Cli, found: readonly Found[], settings: Settings, ledger: Ledger, now: number): Promise<Event[]> {
  const events: Event[] = [];
  for (const { demo, job } of found.filter((each) => untouched(ledger, each.job.intent))) {
    try {
      const board = job.takesClaims ? await boardOf(cli, job) : undefined;
      const seen = board === undefined ? job : { ...job, ...heldOf(board), board };
      events.push(...(await work(cli, demo, seen, settings, ledger, now)));
    } catch (error) {
      events.push(failed(demo, job, ledger, error));
    }
  }
  return events;
}

export function base58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) {
    value = value * 256n + BigInt(byte);
  }
  let text = "";
  for (; value > 0n; value /= 58n) {
    text = `${BASE58[Number(value % 58n)]}${text}`;
  }
  for (let at = 0; at < bytes.length && bytes[at] === 0; at += 1) {
    text = `1${text}`;
  }
  return text;
}

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

export function intentJob(intent: string, data: Uint8Array, now: number): DemoJob | null {
  if (data.length !== INTENT_SIZE || !INTENT_TAG.every((byte, at) => data[at] === byte) || data[AT.kind] !== CODE.attestedResult || data[AT.status] !== CODE.open) {
    return null;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const expiresAt = Number(view.getBigInt64(AT.expiresAt, true));
  const owner = base58(data.subarray(AT.owner, AT.owner + 32));
  const specHash = Buffer.from(data.subarray(AT.specHash, AT.specHash + 32)).toString("hex");
  const nonce = view.getBigUint64(AT.nonce, true).toString();
  return expiresAt <= now ? null : { intent, owner, nonce, specHash, takesClaims: data[AT.claims] === CODE.claimsOpen, claimedBy: null, waiting: 0, expiresAt };
}

export const demoFilters = (specHash: string): object[] => [
  { dataSize: INTENT_SIZE },
  { memcmp: { offset: 0, bytes: base64(INTENT_TAG), encoding: "base64" } },
  { memcmp: { offset: AT.kind, bytes: base64(Uint8Array.from([CODE.attestedResult, CODE.open])), encoding: "base64" } },
  { memcmp: { offset: AT.specHash, bytes: base64(Buffer.from(specHash, "hex")), encoding: "base64" } },
];

function accountsOf(listed: unknown): { intent: string; data: Uint8Array }[] {
  if (!Array.isArray(listed)) {
    throw new Error(`getProgramAccounts answered no list: ${JSON.stringify(listed ?? null).slice(0, 200)}`);
  }
  return listed.flatMap((entry) => {
    const intent = textOf(record(entry)["pubkey"]);
    const data = record(record(entry)["account"])["data"];
    const encoded = Array.isArray(data) && data[1] === "base64" ? textOf(data[0]) : null;
    return intent === null || encoded === null ? [] : [{ intent, data: new Uint8Array(Buffer.from(encoded, "base64")) }];
  });
}

const foundIn = (demo: Demo, listed: unknown, now: number): Found[] =>
  accountsOf(listed).flatMap(({ intent, data }) => {
    const job = intentJob(intent, data, now);
    return job === null || job.specHash !== demo.specHash ? [] : [{ demo, job }];
  });

const subscription = (program: string, demo: Demo) => [program, { encoding: "base64", commitment: "confirmed", filters: demoFilters(demo.specHash) }];

export function programReader(rpc: Rpc, program: string): Read {
  return async (demos, now) => {
    const listed = await Promise.all(demos.map((demo) => rpc("getProgramAccounts", subscription(program, demo))));
    return demos.flatMap((demo, at) => foundIn(demo, listed[at], now));
  };
}

export type Socket = {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "close" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
};

export function notified(message: unknown, demos: readonly Demo[], now: number): Found[] {
  const value = record(record(record(message)["params"])["result"])["value"];
  return record(message)["method"] === "programNotification" ? demos.flatMap((demo) => foundIn(demo, [value], now)) : [];
}

function jsonOf(text: unknown): unknown {
  try {
    return JSON.parse(String(text));
  } catch {
    return null;
  }
}

export function watchOnce(open: (url: string) => Socket, url: string, program: string, demos: readonly Demo[], now: () => number, seen: (found: Found) => void): Promise<string> {
  return new Promise((done) => {
    let reason = "the subscription closed";
    let socket: Socket;
    try {
      socket = open(url);
    } catch (error) {
      done(error instanceof Error ? error.message : String(error));
      return;
    }
    socket.addEventListener("open", () => demos.forEach((demo, at) => socket.send(JSON.stringify({ jsonrpc: "2.0", id: at + 1, method: "programSubscribe", params: subscription(program, demo) }))));
    socket.addEventListener("message", (event) => {
      const message = jsonOf(event.data);
      if (record(message)["error"] !== undefined) {
        reason = `programSubscribe failed: ${JSON.stringify(record(message)["error"]).slice(0, 500)}`;
        socket.close();
        return;
      }
      notified(message, demos, now()).forEach(seen);
    });
    socket.addEventListener("error", () => socket.close());
    socket.addEventListener("close", () => done(reason));
  });
}

export async function watch(open: (url: string) => Socket, url: string, program: string, demos: readonly Demo[], now: () => number, seen: (found: Found) => void, log: Log, wait: (ms: number) => Promise<unknown>, more: () => boolean = () => true): Promise<void> {
  for (let failures = 0; more(); ) {
    const opened = Date.now();
    const reason = await watchOnce(open, url, program, demos, now, seen);
    failures = Date.now() - opened > MAX_BACKOFF_MS ? 0 : failures + 1;
    log.err(JSON.stringify({ at: new Date().toISOString(), round: "failed", path: "watch", detail: reason }));
    await wait(backoff(WATCH_RETRY_MS, failures));
  }
}

export const rpcUrlOf = (url: string): string => CLUSTERS[url] ?? url;

export function wsUrlOf(url: string): string {
  const parsed = new URL(rpcUrlOf(url));
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  if (parsed.port !== "") {
    parsed.port = String(Number(parsed.port) + 1);
  }
  return parsed.toString();
}

export function rpcOf(url: string, fetcher: typeof fetch = fetch): Rpc {
  let id = 0;
  return async (method, params) => {
    id += 1;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const response = await fetcher(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
    if (!response.ok) {
      throw new Error(`${method} failed: the node answered ${response.status}`);
    }
    const answer = record(await response.json());
    if (answer["error"] !== undefined) {
      throw new Error(`${method} failed: ${JSON.stringify(answer["error"]).slice(0, 500)}`);
    }
    return answer["result"];
  };
}

export async function programOf(cli: Cli, rpc: Rpc): Promise<string> {
  const config = textOf(record(await cli(["show", "config"]))["address"]);
  const owner = config === null ? null : textOf(record(record(await rpc("getAccountInfo", [config, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]))["value"])["owner"]);
  if (owner === null) {
    throw new Error(`show config named no config account that the node holds: ${config}`);
  }
  return owner;
}

export function serialized(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return function queued<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

export async function tick(path: string, round: () => Promise<Event[]>, log: Log, at: () => Date = () => new Date()): Promise<boolean> {
  try {
    for (const event of await round()) {
      log.out(JSON.stringify({ at: at().toISOString(), ...event }));
    }
    return true;
  } catch (error) {
    log.err(JSON.stringify({ at: at().toISOString(), round: "failed", path, detail: error instanceof Error ? error.message : String(error) }));
    return false;
  }
}

export const backoff = (every: number, failures: number): number => Math.max(every, Math.min(every * 2 ** Math.min(failures, 16), MAX_BACKOFF_MS));

export async function readLedger(path: string): Promise<Ledger> {
  try {
    const done = record(JSON.parse(await readFile(path, "utf8")))["done"];
    return emptyLedger(Array.isArray(done) ? done.filter((intent): intent is string => typeof intent === "string") : []);
  } catch (error) {
    if (record(error)["code"] === "ENOENT") {
      return emptyLedger();
    }
    throw error;
  }
}

export async function writeLedger(path: string, ledger: Ledger): Promise<void> {
  await writeFile(`${path}.tmp`, `${JSON.stringify({ done: [...ledger.done] })}\n`);
  await rename(`${path}.tmp`, path);
}

export function cliOf(command: readonly string[], url: string): Cli {
  const [file, ...prefix] = command;
  if (file === undefined) {
    throw new Error("name the command line after --, such as -- intent-engine");
  }
  return (args) =>
    new Promise((done, failed) => {
      execFile(file, [...prefix, ...args, "--url", url], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error !== null) {
          failed(new Error(`${args.slice(0, 2).join(" ")} failed: ${(stdout.trim() || stderr.trim() || error.message).slice(0, 2000)}`));
          return;
        }
        try {
          done(JSON.parse(stdout));
        } catch {
          failed(new Error(`${args.slice(0, 2).join(" ")} printed no JSON`));
        }
      });
    });
}

const needed = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new Error(`set ${name}`);
  }
  return value;
};

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function repeat(path: string, round: () => Promise<Event[]>, every: number, log: Log): Promise<never> {
  for (let failures = 0; ; ) {
    failures = (await tick(path, round, log)) ? 0 : failures + 1;
    await pause(backoff(every, failures));
  }
}

export async function runWorker(env: NodeJS.ProcessEnv, argv: readonly string[]): Promise<void> {
  const split = argv.indexOf("--");
  const once = argv.slice(0, split < 0 ? argv.length : split).includes("--once");
  const keypair = needed(env, "DEMO_WORKER_KEYPAIR");
  const url = env["DEMO_WORKER_URL"] ?? "devnet";
  const cli = cliOf(split < 0 ? [] : argv.slice(split + 1), url);
  const rpc = rpcOf(rpcUrlOf(url));
  const demos = await loadDemos(needed(env, "DEMO_WORKER_DEMOS"), needed(env, "DEMO_WORKER_BASE_URL"));
  const statePath = needed(env, "DEMO_WORKER_STATE");
  const wallet = textOf(record(await cli(["balance", "--keypair", keypair]))["address"]);
  if (wallet === null) {
    throw new Error("balance printed no address for DEMO_WORKER_KEYPAIR");
  }
  const settings: Settings = { keypair, wallet, maxStake: BigInt(env["DEMO_WORKER_MAX_STAKE_LAMPORTS"] ?? "50000000"), claimSecs: Number(env["DEMO_WORKER_CLAIM_SECS"] ?? "900") };
  const program = env["DEMO_WORKER_PROGRAM"] || (await programOf(cli, rpc));
  const read = programReader(rpc, program);
  const ledger = await readLedger(statePath);
  const lock = serialized();
  const now = () => Math.floor(Date.now() / 1000);
  const saved = (events: Event[]) => writeLedger(statePath, ledger).then(() => events);
  const fast = () => lock(async () => saved(await fastRound(cli, read, demos, settings, ledger, now())));
  const full = async () => {
    const found = demosOf(demos, jobsOf(await cli(["jobs"])));
    return lock(async () => saved(await workJobs(cli, found, settings, ledger, now())));
  };
  const log: Log = { out: (line) => console.log(line), err: (line) => console.error(line) };
  console.log(JSON.stringify({ wallet, program, demos: demos.map(({ name, specHash, workUrl }) => ({ name, spec_hash: specHash, work_url: workUrl })) }));
  if (once) {
    await tick("fast", fast, log);
    await tick("full", full, log);
    return;
  }
  const fastEvery = Number(env["DEMO_WORKER_FAST_INTERVAL"] ?? String(FAST_INTERVAL_SECS)) * 1000;
  const fullEvery = Number(env["DEMO_WORKER_INTERVAL"] ?? String(FULL_INTERVAL_SECS)) * 1000;
  const seen = (found: Found) => void tick("watch", () => lock(async () => saved(await fastWork(cli, [found], settings, ledger, now()))), log);
  const Sockets = (globalThis as unknown as { WebSocket: new (url: string) => Socket }).WebSocket;
  const watching = watch((socketUrl) => new Sockets(socketUrl), env["DEMO_WORKER_WS_URL"] || wsUrlOf(url), program, demos, now, seen, log, pause);
  await Promise.all([watching, repeat("fast", fast, fastEvery, log), repeat("full", full, fullEvery, log)]);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runWorker(process.env, process.argv.slice(2));
}
