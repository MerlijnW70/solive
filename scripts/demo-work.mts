import { type Cli, type Demo, type DemoJob, type Event, type Found, type Read, record, sentSignature, textOf } from "./demo-chain.mts";
import { type Caps, claimPlan, holdOf, type Refusal, strike, termsOf } from "./demo-guard.mts";
import type { Ledger } from "./demo-state.mts";

export type Settings = Caps & { keypair: string; wallet: string; checkpoint?: () => Promise<void> };

export const MAX_FAILURES = 3;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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

const deliverArgs = (demo: Demo, job: DemoJob, settings: Settings): string[] => ["deliver", "--keypair", settings.keypair, "--intent", job.intent, "--artifact", demo.solution, "--work-url", demo.workUrl];

const dropArgs = (job: { owner: string; nonce: string }, settings: Settings): string[] => ["claims", "drop", "--keypair", settings.keypair, "--owner", job.owner, "--nonce", job.nonce, "--yes"];

export const transient = (error: unknown): boolean => /\b(408|425|429|5\d\d)\b|too many requests|timed? ?out|ECONN|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up/i.test(messageOf(error));

async function sealable(cli: Cli, demo: Demo, job: DemoJob, settings: Settings): Promise<Refusal | null> {
  try {
    await cli(deliverArgs(demo, job, settings));
    return null;
  } catch (error) {
    if (transient(error)) {
      throw error;
    }
    return { reason: `a delivery to it cannot even be previewed, so no claim was staked on it: ${messageOf(error).slice(0, 400)}`, final: true };
  }
}

async function claim(cli: Cli, demo: Demo, job: DemoJob, settings: Settings, ledger: Ledger, now: number): Promise<Event | Refusal> {
  if (job.claimedBy !== null || job.waiting > 0) {
    return { reason: "another worker holds or waits for its claim", final: false };
  }
  const board = job.board ?? (await boardOf(cli, job));
  const plan = claimPlan(termsOf(board), job.owner, job.expiresAt, now, settings, [...ledger.holds.values()], ledger.strikes);
  if ("reason" in plan) {
    return plan;
  }
  if (plan.terms.stake > 0n) {
    const refused = await sealable(cli, demo, job, settings);
    if (refused !== null) {
      return refused;
    }
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
  const args = deliverArgs(demo, job, settings);
  const hold = ledger.holds.get(job.intent);
  if (hold !== undefined && !hold.delivered) {
    const preview = record(await cli(args));
    if (textOf(preview["seq"]) === null && preview["protected"] !== true) {
      const dropped = sentSignature(await cli(dropArgs(job, settings)), "claims drop");
      ledger.holds.delete(job.intent);
      strike(ledger, job.owner, now, "unprotected", 0n, settings.breaker);
      return { intent: job.intent, demo: demo.name, action: "dropped", detail: `its delivery would arm no review (${unprotectedWhy(preview)}), so the worker gave the claim back with its stake: ${dropped}` };
    }
  }
  const shown = record(await cli([...args, "--yes"]));
  const detail = shown["sent"] === true ? sentSignature(shown, "deliver") : (textOf(shown["next"]) ?? "already announced");
  if (shown["sent"] === true) {
    ledger.openDeliveries += 1;
  }
  if (hold !== undefined) {
    hold.delivered = true;
    const until = textOf(shown["review_until"]);
    hold.reviewUntil = shown["protected"] === true && until !== null ? Number(until) : null;
  }
  ledger.lastDelivery = { at: now, intent: job.intent };
  return { intent: job.intent, demo: demo.name, action: "delivered", detail };
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

async function giveBack(cli: Cli, demo: Demo, job: DemoJob, settings: Settings, ledger: Ledger, now: number, error: unknown): Promise<Event[]> {
  const hold = ledger.holds.get(job.intent);
  if (hold === undefined || hold.delivered) {
    return [failed(demo, job, ledger, error)];
  }
  try {
    const dropped = sentSignature(await cli(dropArgs(job, settings)), "claims drop");
    ledger.holds.delete(job.intent);
    ledger.done.add(job.intent);
    strike(ledger, job.owner, now, "failed", 0n, settings.breaker);
    await settings.checkpoint?.();
    return [{ intent: job.intent, demo: demo.name, action: "dropped", detail: `its delivery failed (${messageOf(error).slice(0, 400)}), so the worker gave the claim back with its stake at once: ${dropped}` }];
  } catch (dropError) {
    return [failed(demo, job, ledger, new Error(`${messageOf(error)}; giving the claim back failed too: ${messageOf(dropError)}`))];
  }
}

const skipped = (demo: Demo, job: DemoJob, ledger: Ledger, refusal: Refusal): Event[] => {
  if (refusal.final) {
    ledger.done.add(job.intent);
  }
  if (ledger.noted.has(job.intent)) {
    return [];
  }
  ledger.noted.add(job.intent);
  return [{ intent: job.intent, demo: demo.name, action: "skipped", detail: refusal.reason }];
};

async function work(cli: Cli, demo: Demo, job: DemoJob, settings: Settings, ledger: Ledger, now: number): Promise<Event[]> {
  const events: Event[] = [];
  const mine = job.claimedBy === settings.wallet || ledger.holds.has(job.intent);
  if (!mine && ledger.openDeliveries >= settings.maxOpenDeliveries) {
    return skipped(demo, job, ledger, { reason: `this worker already has ${ledger.openDeliveries} announcements whose rent is not back yet, its cap of ${settings.maxOpenDeliveries}`, final: false });
  }
  if (job.takesClaims && !mine) {
    const claimed = await claim(cli, demo, job, settings, ledger, now);
    if ("reason" in claimed) {
      return skipped(demo, job, ledger, claimed);
    }
    events.push(claimed);
  } else if (job.takesClaims) {
    await adopt(cli, demo, job, ledger);
  }
  try {
    events.push(await deliver(cli, demo, job, settings, ledger, now));
  } catch (error) {
    events.push(...(await giveBack(cli, demo, job, settings, ledger, now, error)));
    return events;
  }
  ledger.done.add(job.intent);
  return events;
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

export async function fastRound(cli: Cli, read: Read, demos: readonly Demo[], settings: Settings, ledger: Ledger, now: number): Promise<Event[]> {
  return fastWork(cli, await read(demos, now), settings, ledger, now);
}
