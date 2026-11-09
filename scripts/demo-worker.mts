import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  backoff,
  type Cli,
  type Demo,
  type DemoJob,
  type Event,
  type Found,
  type Gate,
  gateOf,
  jittered,
  type Log,
  pause,
  programReader,
  type Read,
  record,
  type Rpc,
  rpcOf,
  rpcUrlOf,
  sentSignature,
  textOf,
  wsUrlOf,
} from "./demo-chain.mts";
import { type Caps, claimPlan, collectRound, healthOf, holdOf, type Ledger, readLedger, type Refusal, termsOf, writeHealth, writeLedger } from "./demo-guard.mts";
import { type Socket, watch } from "./demo-watch.mts";

export * from "./demo-chain.mts";
export * from "./demo-guard.mts";
export * from "./demo-watch.mts";

export type Settings = Caps & { keypair: string; wallet: string; checkpoint?: () => Promise<void> };

export const SPEC_FILE = "SPEC.md";
export const SOLUTION_FILE = "solution.mjs";
export const MAX_FAILURES = 3;
export const FAST_INTERVAL_SECS = 30;
export const WATCHED_INTERVAL_SECS = 120;
export const FULL_INTERVAL_SECS = 300;
export const COLLECT_INTERVAL_SECS = 300;
export const CLAIM_SECS = 900;
export const MAX_STAKE_LAMPORTS = 50_000_000;
export const MAX_AT_RISK_LAMPORTS = 150_000_000;
export const MAX_OWNER_LAMPORTS = 50_000_000;

export const USAGE = [
  "usage: demo-worker.mts [--once] [--help] -- <command line, such as intent-engine>",
  "It stakes only on a claim whose stake is 0, or whose review window protects an honest delivery, within the caps below; it collects every review that ends unanswered.",
  "DEMO_WORKER_KEYPAIR              the worker's devnet key file; required",
  "DEMO_WORKER_CLI                  the command line demo-worker.sh runs; default the checkout's build",
  "DEMO_WORKER_DEMOS                the folder of demo specs and solutions; required",
  "DEMO_WORKER_BASE_URL             where the work urls point; required",
  "DEMO_WORKER_STATE                the file of escrows it is done with and claims it holds; required",
  "DEMO_WORKER_HEALTH               the health file a monitor reads; required",
  "DEMO_WORKER_URL                  the cluster or node address; default devnet",
  "DEMO_WORKER_WS_URL               the node's websocket address; default derived from DEMO_WORKER_URL",
  "DEMO_WORKER_PROGRAM              the program address; default the owner of the config account",
  `DEMO_WORKER_FAST_INTERVAL        seconds between fast rounds; default ${FAST_INTERVAL_SECS}`,
  `DEMO_WORKER_WATCHED_INTERVAL     seconds between fast rounds while subscribed; default ${WATCHED_INTERVAL_SECS}`,
  `DEMO_WORKER_INTERVAL             seconds between full scans; default ${FULL_INTERVAL_SECS}`,
  `DEMO_WORKER_COLLECT_INTERVAL     seconds between collect rounds; default ${COLLECT_INTERVAL_SECS}`,
  `DEMO_WORKER_CLAIM_SECS           the longest claim it takes; default ${CLAIM_SECS}`,
  `DEMO_WORKER_MAX_STAKE_LAMPORTS   the largest stake of one claim; default ${MAX_STAKE_LAMPORTS}`,
  `DEMO_WORKER_MAX_AT_RISK_LAMPORTS the most stake it holds at risk at once; default ${MAX_AT_RISK_LAMPORTS}`,
  `DEMO_WORKER_MAX_OWNER_LAMPORTS   the most stake it holds on one owner's escrows; default ${MAX_OWNER_LAMPORTS}`,
].join("\n");

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

const boardOf = async (cli: Cli, job: DemoJob): Promise<Record<string, unknown>> => record(await cli(["claims", "show", "--owner", job.owner, "--nonce", job.nonce]));

export function heldOf(board: Record<string, unknown>): { claimedBy: string | null; waiting: number } {
  const waiting = Number(record(board["line"])["waiting"] ?? 0);
  return { claimedBy: board["state"] === "held" ? textOf(board["worker"]) : null, waiting: Number.isFinite(waiting) ? waiting : 0 };
}

async function claim(cli: Cli, demo: Demo, job: DemoJob, settings: Settings, ledger: Ledger, now: number): Promise<Event | Refusal> {
  if (job.claimedBy !== null || job.waiting > 0) {
    return { reason: "another worker holds or waits for its claim", final: false };
  }
  const board = job.board ?? (await boardOf(cli, job));
  const plan = claimPlan(termsOf(board), job.owner, job.expiresAt, now, settings, [...ledger.holds.values()]);
  if ("reason" in plan) {
    return plan;
  }
  const taken = await cli(["claims", "take", "--keypair", settings.keypair, "--owner", job.owner, "--nonce", job.nonce, "--secs", String(plan.secs), "--yes"]);
  const signature = sentSignature(taken, "claims take");
  if (plan.terms.stake > 0n) {
    ledger.holds.set(job.intent, holdOf(demo.name, job, plan.terms, now + plan.secs));
    await settings.checkpoint?.();
  }
  return { intent: job.intent, demo: demo.name, action: "claimed", detail: signature };
}

async function adopt(cli: Cli, demo: Demo, job: DemoJob, ledger: Ledger): Promise<void> {
  if (ledger.holds.has(job.intent)) {
    return;
  }
  const board = job.board ?? (await boardOf(cli, job));
  const terms = termsOf(board);
  if (terms.stake > 0n) {
    ledger.holds.set(job.intent, holdOf(demo.name, job, terms, Number(textOf(board["until"]) ?? 0)));
  }
}

const unprotectedWhy = (preview: Record<string, unknown>): string => {
  const summary = Array.isArray(preview["summary"]) ? preview["summary"] : [];
  const line = summary.find((each): each is string => typeof each === "string" && each.startsWith("Unprotected: "));
  return line === undefined ? "the preview did not say it is protected" : line.slice("Unprotected: ".length, 400);
};

async function deliver(cli: Cli, demo: Demo, job: DemoJob, settings: Settings, ledger: Ledger, now: number): Promise<Event> {
  const args = ["deliver", "--keypair", settings.keypair, "--intent", job.intent, "--artifact", demo.solution, "--work-url", demo.workUrl];
  const hold = ledger.holds.get(job.intent);
  if (hold !== undefined && !hold.delivered) {
    const preview = record(await cli(args));
    if (textOf(preview["seq"]) === null && preview["protected"] !== true) {
      const dropped = await cli(["claims", "drop", "--keypair", settings.keypair, "--owner", job.owner, "--nonce", job.nonce, "--yes"]);
      ledger.holds.delete(job.intent);
      return { intent: job.intent, demo: demo.name, action: "dropped", detail: `its delivery would arm no review (${unprotectedWhy(preview)}), so the worker gave the claim back with its stake: ${sentSignature(dropped, "claims drop")}` };
    }
  }
  const shown = record(await cli([...args, "--yes"]));
  const detail = shown["sent"] === true ? sentSignature(shown, "deliver") : (textOf(shown["next"]) ?? "already announced");
  if (hold !== undefined) {
    hold.delivered = true;
    const until = textOf(shown["review_until"]);
    hold.reviewUntil = shown["protected"] === true && until !== null ? Number(until) : null;
  }
  ledger.lastDelivery = { at: now, intent: job.intent };
  return { intent: job.intent, demo: demo.name, action: "delivered", detail };
}

async function work(cli: Cli, demo: Demo, job: DemoJob, settings: Settings, ledger: Ledger, now: number): Promise<Event[]> {
  const events: Event[] = [];
  const mine = job.claimedBy === settings.wallet || ledger.holds.has(job.intent);
  if (job.takesClaims && !mine) {
    const claimed = await claim(cli, demo, job, settings, ledger, now);
    if ("reason" in claimed) {
      if (claimed.final) {
        ledger.done.add(job.intent);
      }
      if (ledger.noted.has(job.intent)) {
        return [];
      }
      ledger.noted.add(job.intent);
      return [{ intent: job.intent, demo: demo.name, action: "skipped", detail: claimed.reason }];
    }
    events.push(claimed);
  } else if (job.takesClaims) {
    await adopt(cli, demo, job, ledger);
  }
  events.push(await deliver(cli, demo, job, settings, ledger, now));
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
  return { intent: job.intent, demo: demo.name, action: gaveUp ? "gave-up" : "failed", detail: messageOf(error) };
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

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function tick(path: string, round: () => Promise<Event[]>, log: Log, at: () => Date = () => new Date(), seen: (error: unknown) => void = () => undefined): Promise<boolean> {
  try {
    for (const event of await round()) {
      log.out(JSON.stringify({ at: at().toISOString(), ...event }));
    }
    return true;
  } catch (error) {
    seen(error);
    log.err(JSON.stringify({ at: at().toISOString(), round: "failed", path, detail: messageOf(error) }));
    return false;
  }
}

export const busy = (error: unknown): boolean => /\b429\b|too many requests/i.test(messageOf(error));

export type Pace = { gate?: Gate; random?: () => number; clock?: () => number };

export async function repeat(path: string, round: () => Promise<Event[]>, every: () => number, log: Log, wait: (ms: number) => Promise<unknown> = pause, more: () => boolean = () => true, pace: Pace = {}): Promise<void> {
  const clock = pace.clock ?? Date.now;
  for (let failures = 0; more(); ) {
    let crowded = false;
    failures = (await tick(path, round, log, undefined, (error) => void (crowded = busy(error)))) ? 0 : failures + 1;
    const own = failures === 0 ? every() : jittered(backoff(every(), failures), pace.random ?? Math.random);
    if (crowded) {
      pace.gate?.hold(own);
    }
    await wait(Math.max(own, (pace.gate?.until() ?? 0) - clock()));
  }
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

export type Timing = { fastSecs: number; fullSecs: number; watchedSecs: number; collectSecs: number; claimSecs: number; maxStake: bigint; maxAtRisk: bigint; maxPerOwner: bigint };

const secondsOf = (env: NodeJS.ProcessEnv, name: string, fallback: number): number => {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = /^\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : Number.NaN;
  if (!(Number.isFinite(value) && value > 0)) {
    throw new Error(`${name} is a number of seconds above 0, not "${raw}"`);
  }
  return value;
};

const lamportsOf = (env: NodeJS.ProcessEnv, name: string, fallback: number): bigint => {
  const raw = env[name] ?? String(fallback);
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} is a whole number of lamports, not "${raw}"`);
  }
  return BigInt(raw);
};

export const timingOf = (env: NodeJS.ProcessEnv): Timing => ({
  fastSecs: secondsOf(env, "DEMO_WORKER_FAST_INTERVAL", FAST_INTERVAL_SECS),
  fullSecs: secondsOf(env, "DEMO_WORKER_INTERVAL", FULL_INTERVAL_SECS),
  watchedSecs: secondsOf(env, "DEMO_WORKER_WATCHED_INTERVAL", WATCHED_INTERVAL_SECS),
  collectSecs: secondsOf(env, "DEMO_WORKER_COLLECT_INTERVAL", COLLECT_INTERVAL_SECS),
  claimSecs: secondsOf(env, "DEMO_WORKER_CLAIM_SECS", CLAIM_SECS),
  maxStake: lamportsOf(env, "DEMO_WORKER_MAX_STAKE_LAMPORTS", MAX_STAKE_LAMPORTS),
  maxAtRisk: lamportsOf(env, "DEMO_WORKER_MAX_AT_RISK_LAMPORTS", MAX_AT_RISK_LAMPORTS),
  maxPerOwner: lamportsOf(env, "DEMO_WORKER_MAX_OWNER_LAMPORTS", MAX_OWNER_LAMPORTS),
});

export const pollEvery = (watching: () => boolean, fastMs: number, watchedMs: number): number => (watching() ? Math.max(fastMs, watchedMs) : fastMs);

export async function balanceOf(rpc: Rpc, wallet: string): Promise<bigint | null> {
  const value = textOf(record(await rpc("getBalance", [wallet, { commitment: "confirmed" }]))["value"]);
  return value !== null && /^\d+$/.test(value) ? BigInt(value) : null;
}

export async function runWorker(env: NodeJS.ProcessEnv, argv: readonly string[]): Promise<void> {
  const split = argv.indexOf("--");
  const flags = argv.slice(0, split < 0 ? argv.length : split);
  if (flags.includes("--help")) {
    console.log(USAGE);
    return;
  }
  const once = flags.includes("--once");
  const keypair = needed(env, "DEMO_WORKER_KEYPAIR");
  const timing = timingOf(env);
  const url = env["DEMO_WORKER_URL"] ?? "devnet";
  const cli = cliOf(split < 0 ? [] : argv.slice(split + 1), url);
  const gate = gateOf();
  const rpc = rpcOf(rpcUrlOf(url), fetch, gate);
  const demos = await loadDemos(needed(env, "DEMO_WORKER_DEMOS"), needed(env, "DEMO_WORKER_BASE_URL"));
  const statePath = needed(env, "DEMO_WORKER_STATE");
  const healthPath = needed(env, "DEMO_WORKER_HEALTH");
  const wallet = textOf(record(await cli(["balance", "--keypair", keypair]))["address"]);
  if (wallet === null) {
    throw new Error("balance printed no address for DEMO_WORKER_KEYPAIR");
  }
  const ledger = await readLedger(statePath);
  const caps = { maxStake: timing.maxStake, maxAtRisk: timing.maxAtRisk, maxPerOwner: timing.maxPerOwner, claimSecs: timing.claimSecs };
  const settings: Settings = { ...caps, keypair, wallet, checkpoint: () => writeLedger(statePath, ledger) };
  const program = env["DEMO_WORKER_PROGRAM"] || (await programOf(cli, rpc));
  const read = programReader(rpc, program);
  const lock = serialized();
  const now = () => Math.floor(Date.now() / 1000);
  let balance: bigint | null = null;
  const saved = async (events: Event[]) => {
    await writeLedger(statePath, ledger);
    await writeHealth(healthPath, healthOf(ledger, wallet, now(), balance, gate.until()));
    return events;
  };
  const fast = () => lock(async () => saved(await fastRound(cli, read, demos, settings, ledger, now())));
  const full = async () => {
    const found = demosOf(demos, jobsOf(await cli(["jobs"])));
    return lock(async () => saved(await workJobs(cli, found, settings, ledger, now())));
  };
  const collect = async () => {
    balance = (await balanceOf(rpc, wallet).catch(() => null)) ?? balance;
    return lock(async () => saved(await collectRound(cli, settings, ledger, now())));
  };
  const log: Log = { out: (line) => console.log(line), err: (line) => console.error(line) };
  const shownCaps = { max_stake: String(caps.maxStake), max_at_risk: String(caps.maxAtRisk), max_per_owner: String(caps.maxPerOwner) };
  console.log(JSON.stringify({ wallet, program, caps: shownCaps, demos: demos.map(({ name, specHash, workUrl }) => ({ name, spec_hash: specHash, work_url: workUrl })) }));
  if (once) {
    await tick("collect", collect, log);
    await tick("fast", fast, log);
    await tick("full", full, log);
    return;
  }
  const pace: Pace = { gate };
  const seen = (found: Found) => void tick("watch", () => lock(async () => saved(await fastWork(cli, [found], settings, ledger, now()))), log);
  const Sockets = (globalThis as unknown as { WebSocket: new (url: string) => Socket }).WebSocket;
  let open = false;
  const link = { up: () => void (open = true), down: () => void (open = false) };
  const watching = watch((socketUrl) => new Sockets(socketUrl), env["DEMO_WORKER_WS_URL"] || wsUrlOf(url), program, demos, now, seen, log, pause, () => true, link);
  await Promise.all([
    watching,
    repeat("fast", fast, () => pollEvery(() => open, timing.fastSecs * 1000, timing.watchedSecs * 1000), log, pause, () => true, pace),
    repeat("full", full, () => timing.fullSecs * 1000, log, pause, () => true, pace),
    repeat("collect", collect, () => timing.collectSecs * 1000, log, pause, () => true, pace),
  ]);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runWorker(process.env, process.argv.slice(2));
}
