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
};

export type Settings = { keypair: string; wallet: string; maxStake: bigint; claimSecs: number };

export type Ledger = { done: Set<string>; failures: Map<string, number>; noted: Set<string> };

export type Action = "claimed" | "delivered" | "skipped" | "failed" | "gave-up";

export type Event = { intent: string; demo: string; action: Action; detail?: string };

export const SPEC_FILE = "SPEC.md";
export const SOLUTION_FILE = "solution.mjs";
export const MAX_FAILURES = 3;
export const CLAIM_MARGIN_SECS = 60;
export const MIN_CLAIM_SECS = 120;

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

async function claim(cli: Cli, demo: Demo, job: DemoJob, settings: Settings, now: number): Promise<Event | string> {
  if (job.claimedBy !== null || job.waiting > 0) {
    return "another worker holds or waits for its claim";
  }
  const board = record(await cli(["claims", "show", "--owner", job.owner, "--nonce", job.nonce]));
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

export async function demoRound(cli: Cli, demos: readonly Demo[], settings: Settings, ledger: Ledger, now: number): Promise<Event[]> {
  const byHash = new Map(demos.map((demo) => [demo.specHash, demo]));
  const events: Event[] = [];
  for (const job of jobsOf(await cli(["jobs"]))) {
    const demo = byHash.get(job.specHash);
    if (demo === undefined || ledger.done.has(job.intent)) {
      continue;
    }
    try {
      events.push(...(await work(cli, demo, job, settings, ledger, now)));
    } catch (error) {
      const failures = (ledger.failures.get(job.intent) ?? 0) + 1;
      ledger.failures.set(job.intent, failures);
      const gaveUp = failures >= MAX_FAILURES;
      if (gaveUp) {
        ledger.done.add(job.intent);
      }
      events.push({ intent: job.intent, demo: demo.name, action: gaveUp ? "gave-up" : "failed", detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return events;
}

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

export async function runWorker(env: NodeJS.ProcessEnv, argv: readonly string[]): Promise<void> {
  const split = argv.indexOf("--");
  const once = argv.slice(0, split < 0 ? argv.length : split).includes("--once");
  const keypair = needed(env, "DEMO_WORKER_KEYPAIR");
  const cli = cliOf(split < 0 ? [] : argv.slice(split + 1), env["DEMO_WORKER_URL"] ?? "devnet");
  const demos = await loadDemos(needed(env, "DEMO_WORKER_DEMOS"), needed(env, "DEMO_WORKER_BASE_URL"));
  const statePath = needed(env, "DEMO_WORKER_STATE");
  const wallet = textOf(record(await cli(["balance", "--keypair", keypair]))["address"]);
  if (wallet === null) {
    throw new Error("balance printed no address for DEMO_WORKER_KEYPAIR");
  }
  const settings: Settings = {
    keypair,
    wallet,
    maxStake: BigInt(env["DEMO_WORKER_MAX_STAKE_LAMPORTS"] ?? "50000000"),
    claimSecs: Number(env["DEMO_WORKER_CLAIM_SECS"] ?? "900"),
  };
  const interval = Number(env["DEMO_WORKER_INTERVAL"] ?? "30") * 1000;
  const ledger = await readLedger(statePath);
  console.log(JSON.stringify({ wallet, demos: demos.map(({ name, specHash, workUrl }) => ({ name, spec_hash: specHash, work_url: workUrl })) }));
  for (;;) {
    try {
      for (const event of await demoRound(cli, demos, settings, ledger, Math.floor(Date.now() / 1000))) {
        console.log(JSON.stringify(event));
      }
      await writeLedger(statePath, ledger);
    } catch (error) {
      console.error(JSON.stringify({ round: "failed", detail: error instanceof Error ? error.message : String(error) }));
    }
    if (once) {
      return;
    }
    await pause(interval);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runWorker(process.env, process.argv.slice(2));
}
