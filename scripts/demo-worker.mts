import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { backoff, type Cli, type Demo, type Event, type Found, type Gate, gateOf, jittered, type Log, pause, programReader, type Read, record, type Rpc, rpcOf, rpcUrlOf, textOf, wsUrlOf } from "./demo-chain.mts";
import { type Caps, collectRound, healthOf, reclaimRound, writeHealth } from "./demo-guard.mts";
import { type Ledger, readLedger, writeLedger } from "./demo-state.mts";
import { type Socket, watch } from "./demo-watch.mts";
import { demosOf, fastWork, jobsOf, type Settings, workJobs } from "./demo-work.mts";

export * from "./demo-chain.mts";
export * from "./demo-guard.mts";
export * from "./demo-state.mts";
export * from "./demo-watch.mts";
export * from "./demo-work.mts";

export const SPEC_FILE = "SPEC.md";
export const SOLUTION_FILE = "solution.mjs";
export const FAST_INTERVAL_SECS = 30;
export const WATCHED_INTERVAL_SECS = 120;
export const FULL_INTERVAL_SECS = 300;
export const COLLECT_INTERVAL_SECS = 300;
export const RECLAIM_INTERVAL_SECS = 3_600;
export const CLAIM_SECS = 900;
export const MAX_STAKE_LAMPORTS = 50_000_000;
export const MAX_AT_RISK_LAMPORTS = 150_000_000;
export const MAX_OWNER_LAMPORTS = 50_000_000;
export const MAX_REVIEW_SECS = 86_400;
export const MAX_OPEN_DELIVERIES = 30;
export const BREAKER_STRIKES = 3;
export const BREAKER_OWNER_STRIKES = 1;
export const BREAKER_WINDOW_SECS = 86_400;

export const USAGE = [
  "usage: demo-worker.mts [--once] [--reset-breaker] [--help] -- <command line, such as intent-engine>",
  "It stakes only on a claim whose stake is 0, or whose review window protects an honest delivery that it can seal, within the caps below; it collects every review that ends unanswered.",
  "DEMO_WORKER_KEYPAIR                the worker's devnet key file; required",
  "DEMO_WORKER_CLI                    the command line demo-worker.sh runs; default the checkout's build",
  "DEMO_WORKER_DEMOS                  the folder of demo specs and solutions; required",
  "DEMO_WORKER_BASE_URL               where the work urls point; required",
  "DEMO_WORKER_STATE                  the file of escrows it is done with and claims it holds; required",
  "DEMO_WORKER_HEALTH                 the health file a monitor reads; required",
  "DEMO_WORKER_URL                    the cluster or node address; default devnet",
  "DEMO_WORKER_WS_URL                 the node's websocket address; default derived from DEMO_WORKER_URL",
  "DEMO_WORKER_PROGRAM                the program address; default the owner of the config account",
  `DEMO_WORKER_FAST_INTERVAL          seconds between fast rounds; default ${FAST_INTERVAL_SECS}`,
  `DEMO_WORKER_WATCHED_INTERVAL       seconds between fast rounds while subscribed; default ${WATCHED_INTERVAL_SECS}`,
  `DEMO_WORKER_INTERVAL               seconds between full scans; default ${FULL_INTERVAL_SECS}`,
  `DEMO_WORKER_COLLECT_INTERVAL       seconds between collect rounds; default ${COLLECT_INTERVAL_SECS}`,
  `DEMO_WORKER_RECLAIM_INTERVAL       seconds between reclaims of announcement rent; default ${RECLAIM_INTERVAL_SECS}`,
  `DEMO_WORKER_CLAIM_SECS             the longest claim it takes; default ${CLAIM_SECS}`,
  `DEMO_WORKER_MAX_STAKE_LAMPORTS     the largest stake of one claim; default ${MAX_STAKE_LAMPORTS}`,
  `DEMO_WORKER_MAX_AT_RISK_LAMPORTS   the most stake it holds at risk at once; default ${MAX_AT_RISK_LAMPORTS}`,
  `DEMO_WORKER_MAX_OWNER_LAMPORTS     the most stake it holds on one owner's escrows; default ${MAX_OWNER_LAMPORTS}`,
  `DEMO_WORKER_MAX_REVIEW_SECS        the longest review window it stakes on; default ${MAX_REVIEW_SECS}`,
  `DEMO_WORKER_MAX_OPEN_DELIVERIES    the most announcements whose rent is not back yet; default ${MAX_OPEN_DELIVERIES}`,
  `DEMO_WORKER_BREAKER_STRIKES        lost or failed claims in a window that stop all staked claims; default ${BREAKER_STRIKES}`,
  `DEMO_WORKER_BREAKER_OWNER_STRIKES  lost or failed claims of one owner in a window that stop its staked claims; default ${BREAKER_OWNER_STRIKES}`,
  `DEMO_WORKER_BREAKER_WINDOW         the breaker's window in seconds; default ${BREAKER_WINDOW_SECS}`,
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

export type Rounds = { fast: () => Promise<Event[]>; full: () => Promise<Event[]>; collect: () => Promise<Event[]>; watched: (found: Found) => Promise<Event[]> };

export type RoundDeps = {
  cli: Cli;
  read: Read;
  demos: readonly Demo[];
  settings: Settings;
  ledger: Ledger;
  now: () => number;
  lock: <T>(task: () => Promise<T>) => Promise<T>;
  saved: (events: Event[]) => Promise<Event[]>;
  refresh?: () => Promise<void>;
  reclaimSecs: number;
};

export function roundsOf(deps: RoundDeps): Rounds {
  const { cli, demos, settings, ledger, now, lock, saved } = deps;
  let reclaimAt = 0;
  const reclaim = async (): Promise<Event[]> => {
    if (now() < reclaimAt) {
      return [];
    }
    reclaimAt = now() + deps.reclaimSecs;
    return reclaimRound(cli, settings, ledger).catch((error: unknown) => [{ intent: settings.wallet, demo: "reclaim", action: "failed" as const, detail: `reclaiming announcement rent failed: ${messageOf(error)}` }]);
  };
  return {
    fast: async () => {
      const found = await deps.read(demos, now());
      return lock(async () => saved(await fastWork(cli, found, settings, ledger, now())));
    },
    full: async () => {
      const found = demosOf(demos, jobsOf(await cli(["jobs"])));
      return lock(async () => saved(await workJobs(cli, found, settings, ledger, now())));
    },
    collect: async () => {
      await deps.refresh?.();
      return lock(async () => saved([...(await collectRound(cli, settings, ledger, now())), ...(await reclaim())]));
    },
    watched: (found) => lock(async () => saved(await fastWork(cli, [found], settings, ledger, now()))),
  };
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

export type Timing = Caps & { fastSecs: number; fullSecs: number; watchedSecs: number; collectSecs: number; reclaimSecs: number };

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

const countOf = (env: NodeJS.ProcessEnv, name: string, fallback: number): number => {
  const raw = env[name] ?? String(fallback);
  if (!/^[1-9]\d{0,8}$/.test(raw)) {
    throw new Error(`${name} is a whole number above 0, not "${raw}"`);
  }
  return Number(raw);
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
  reclaimSecs: secondsOf(env, "DEMO_WORKER_RECLAIM_INTERVAL", RECLAIM_INTERVAL_SECS),
  claimSecs: secondsOf(env, "DEMO_WORKER_CLAIM_SECS", CLAIM_SECS),
  maxStake: lamportsOf(env, "DEMO_WORKER_MAX_STAKE_LAMPORTS", MAX_STAKE_LAMPORTS),
  maxAtRisk: lamportsOf(env, "DEMO_WORKER_MAX_AT_RISK_LAMPORTS", MAX_AT_RISK_LAMPORTS),
  maxPerOwner: lamportsOf(env, "DEMO_WORKER_MAX_OWNER_LAMPORTS", MAX_OWNER_LAMPORTS),
  maxReviewSecs: secondsOf(env, "DEMO_WORKER_MAX_REVIEW_SECS", MAX_REVIEW_SECS),
  maxOpenDeliveries: countOf(env, "DEMO_WORKER_MAX_OPEN_DELIVERIES", MAX_OPEN_DELIVERIES),
  breaker: {
    strikes: countOf(env, "DEMO_WORKER_BREAKER_STRIKES", BREAKER_STRIKES),
    ownerStrikes: countOf(env, "DEMO_WORKER_BREAKER_OWNER_STRIKES", BREAKER_OWNER_STRIKES),
    windowSecs: secondsOf(env, "DEMO_WORKER_BREAKER_WINDOW", BREAKER_WINDOW_SECS),
  },
});

export const pollEvery = (watching: () => boolean, fastMs: number, watchedMs: number): number => (watching() ? Math.max(fastMs, watchedMs) : fastMs);

export async function balanceOf(rpc: Rpc, wallet: string): Promise<bigint | null> {
  const value = textOf(record(await rpc("getBalance", [wallet, { commitment: "confirmed" }]))["value"]);
  return value !== null && /^\d+$/.test(value) ? BigInt(value) : null;
}

export async function resetBreaker(statePath: string): Promise<number> {
  const ledger = await readLedger(statePath);
  const cleared = ledger.strikes.length;
  ledger.strikes = [];
  await writeLedger(statePath, ledger);
  return cleared;
}

export async function runWorker(env: NodeJS.ProcessEnv, argv: readonly string[]): Promise<void> {
  const split = argv.indexOf("--");
  const flags = argv.slice(0, split < 0 ? argv.length : split);
  if (flags.includes("--help")) {
    console.log(USAGE);
    return;
  }
  const keypair = needed(env, "DEMO_WORKER_KEYPAIR");
  const timing = timingOf(env);
  const statePath = needed(env, "DEMO_WORKER_STATE");
  if (flags.includes("--reset-breaker")) {
    console.log(JSON.stringify({ at: new Date().toISOString(), round: "breaker", detail: `cleared ${await resetBreaker(statePath)} strikes; staked claims resume` }));
    return;
  }
  const url = env["DEMO_WORKER_URL"] ?? "devnet";
  const cli = cliOf(split < 0 ? [] : argv.slice(split + 1), url);
  const gate = gateOf();
  const rpc = rpcOf(rpcUrlOf(url), fetch, gate);
  const demos = await loadDemos(needed(env, "DEMO_WORKER_DEMOS"), needed(env, "DEMO_WORKER_BASE_URL"));
  const healthPath = needed(env, "DEMO_WORKER_HEALTH");
  const wallet = textOf(record(await cli(["balance", "--keypair", keypair]))["address"]);
  if (wallet === null) {
    throw new Error("balance printed no address for DEMO_WORKER_KEYPAIR");
  }
  const ledger = await readLedger(statePath);
  const { fastSecs, fullSecs, watchedSecs, collectSecs, reclaimSecs, ...caps } = timing;
  const settings: Settings = { ...caps, keypair, wallet, checkpoint: () => writeLedger(statePath, ledger) };
  const program = env["DEMO_WORKER_PROGRAM"] || (await programOf(cli, rpc));
  const now = () => Math.floor(Date.now() / 1000);
  let balance: bigint | null = null;
  const saved = async (events: Event[]) => {
    await writeLedger(statePath, ledger);
    await writeHealth(healthPath, healthOf(ledger, wallet, now(), balance, gate.until(), caps));
    return events;
  };
  const refresh = async () => {
    balance = (await balanceOf(rpc, wallet).catch(() => null)) ?? balance;
  };
  const rounds = roundsOf({ cli, read: programReader(rpc, program), demos, settings, ledger, now, lock: serialized(), saved, refresh, reclaimSecs });
  const log: Log = { out: (line) => console.log(line), err: (line) => console.error(line) };
  const shownCaps = { max_stake: String(caps.maxStake), max_at_risk: String(caps.maxAtRisk), max_per_owner: String(caps.maxPerOwner), max_review_secs: caps.maxReviewSecs, breaker: caps.breaker };
  console.log(JSON.stringify({ wallet, program, caps: shownCaps, demos: demos.map(({ name, specHash, workUrl }) => ({ name, spec_hash: specHash, work_url: workUrl })) }));
  if (ledger.recovered !== null) {
    const kept = ledger.recovered === "backup" ? "the last good copy is in use" : "its copy was unreadable too, so the claims it holds are read back from the chain";
    console.error(JSON.stringify({ at: new Date().toISOString(), round: "state", detail: `${statePath} was unreadable and is kept beside it; ${kept}` }));
  }
  if (flags.includes("--once")) {
    await tick("collect", rounds.collect, log);
    await tick("fast", rounds.fast, log);
    await tick("full", rounds.full, log);
    return;
  }
  const pace: Pace = { gate };
  const seen = (found: Found) => void tick("watch", () => rounds.watched(found), log);
  const Sockets = (globalThis as unknown as { WebSocket: new (url: string) => Socket }).WebSocket;
  let open = false;
  const link = { up: () => void (open = true), down: () => void (open = false) };
  const watching = watch((socketUrl) => new Sockets(socketUrl), env["DEMO_WORKER_WS_URL"] || wsUrlOf(url), program, demos, now, seen, log, pause, () => true, link);
  await Promise.all([
    watching,
    repeat("fast", rounds.fast, () => pollEvery(() => open, fastSecs * 1000, watchedSecs * 1000), log, pause, () => true, pace),
    repeat("full", rounds.full, () => fullSecs * 1000, log, pause, () => true, pace),
    repeat("collect", rounds.collect, () => collectSecs * 1000, log, pause, () => true, pace),
  ]);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runWorker(process.env, process.argv.slice(2));
}
