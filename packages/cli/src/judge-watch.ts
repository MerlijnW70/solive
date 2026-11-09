import type { Address } from "@solana/kit";
import { IntentStatus } from "@intent-engine/core";
import { decodeIntentAccount, INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core/internal";
import { type AnnouncementView, type Transport } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { chainTime, deviceJudgeReady, isDevice } from "@intent-engine/client/internal";
import { openedBy } from "./announcement-views.js";
import { removeCopy } from "./artifact.js";
import { holdSignals } from "./check-process.js";
import { type Announced, DeliveryUnfit, DeliveryUnreadable, type Fetched, fetchDelivery } from "./delivery-fetch.js";
import { infraSkipped, type InterruptSignal, JudgeDeferred, JudgeInfraError, JudgeInterrupted, JudgeRefused, JudgeUnreadable, unreadableSkipped } from "./judge-errors.js";
import { escrowFor, historyRefused, judge, type JudgeCommand, judgeOpeners, pinnedSpec, type Verdict } from "./judge.js";
import { messageSigner } from "./ledger-keys.js";
import { rpcFailed } from "./rpc-failure.js";
import { nodeHostHeld } from "./node-judge.js";
import { checkFilesOf, runPlan } from "./run-plan.js";
import { dockerEnv, sandboxReady } from "./sandbox.js";
import { nodeMemoryRead } from "./viper.js";
import type { Runtime } from "./runtime.js";
import { escapedJson } from "./untrusted-text.js";

export type Stopped = "paid" | "passed" | "closed" | "ended" | InterruptSignal;

type Seen = { announcement: Address; seq: bigint; worker: Address; url: string | null };

type Held = { outcome?: "infra" | "deferred" };

export type Watched =
  | (Seen & Verdict)
  | (Seen & { artifactSha256: string | null; verdict: "fail"; reason: string })
  | (Seen & { artifactSha256: string | null; verdict: "refused"; reason: string })
  | (Seen & Held & { artifactSha256: string | null; verdict: "retry"; reason: string; retry: true })
  | (Seen & Held & { artifactSha256: string | null; verdict: "skipped"; reason: string });

export const INFRA_RUNS = 3;

export const UNREADABLE_TRIES = 6;

export const SEALED_ELSEWHERE = "opens with none of the keys this judge was given, so its url cannot be read";

const line = (value: object): string => escapedJson(JSON.stringify(value, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));

async function stillOpen(transport: Transport, intent: Address): Promise<boolean> {
  const account = await transport.getAccount(intent);
  if (account === null || account.owner !== INTENT_ENGINE_PROGRAM_ADDRESS || account.data.length === 0) {
    return false;
  }
  const { status, expiresAt } = decodeIntentAccount(account.data);
  return status === IntentStatus.Open && expiresAt > (await chainTime(transport));
}

const bySeq = (a: AnnouncementView, b: AnnouncementView): number => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0);

type Missed = { tries: number; due: number };

type Work = { judged: Set<string>; deferred: Set<string>; stalled: Map<Address, number>; missed: Map<Address, Missed>; round: number; stop: AbortSignal };

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function judgeAnnounced(
  command: JudgeCommand,
  runtime: Runtime,
  transport: Transport,
  delivery: Announced,
  interrupted: () => InterruptSignal | undefined,
  work: Work,
): Promise<Watched | null | "skipped" | "later"> {
  const { announcement } = delivery;
  const seen: Seen = { announcement: announcement.address, seq: announcement.seq, worker: announcement.worker, url: delivery.url };
  const refused = (error: Error, sha256: string | null): Watched => ({ ...seen, artifactSha256: sha256, verdict: "refused", reason: error.message });
  const unreadable = (error: Error, sha256: string | null): Watched => {
    const tries = (work.missed.get(announcement.address)?.tries ?? 0) + 1;
    work.missed.set(announcement.address, { tries, due: work.round + 2 ** (tries - 1) });
    return tries >= UNREADABLE_TRIES
      ? { ...seen, outcome: "deferred", artifactSha256: sha256, verdict: "skipped", reason: unreadableSkipped(tries, error.message) }
      : { ...seen, outcome: "deferred", artifactSha256: sha256, verdict: "retry", reason: error.message, retry: true };
  };
  let fetched: Fetched;
  try {
    fetched = await fetchDelivery(runtime.specFetch, transport, delivery, command.timeout, runtime.lookup);
  } catch (error) {
    if (error instanceof DeliveryUnfit) {
      return refused(error, null);
    }
    if (error instanceof DeliveryUnreadable) {
      return unreadable(error, null);
    }
    throw error;
  }
  try {
    if (interrupted() !== undefined) {
      return null;
    }
    if (work.judged.has(fetched.sha256)) {
      return "skipped";
    }
    if (work.deferred.has(fetched.sha256)) {
      return "later";
    }
    const verdict = await judge({ ...command, artifact: fetched.path }, runtime, transport, work.stop, true);
    work.judged.add(fetched.sha256);
    return { ...seen, ...verdict };
  } catch (error) {
    if (error instanceof JudgeInfraError) {
      const runs = (work.stalled.get(announcement.address) ?? 0) + 1;
      work.stalled.set(announcement.address, runs);
      if (runs >= INFRA_RUNS) {
        return { ...seen, outcome: "infra", artifactSha256: fetched.sha256, verdict: "skipped", reason: infraSkipped(runs, error.message) };
      }
      work.deferred.add(fetched.sha256);
      return { ...seen, outcome: "infra", artifactSha256: fetched.sha256, verdict: "retry", reason: error.message, retry: true };
    }
    if (error instanceof JudgeUnreadable) {
      work.deferred.add(fetched.sha256);
      return unreadable(error, fetched.sha256);
    }
    if (error instanceof JudgeDeferred || rpcFailed(error)) {
      work.deferred.add(fetched.sha256);
      return { ...seen, outcome: "deferred", artifactSha256: fetched.sha256, verdict: "retry", reason: reasonOf(error), retry: true };
    }
    if (error instanceof JudgeRefused) {
      work.judged.add(fetched.sha256);
      return { ...seen, artifactSha256: fetched.sha256, verdict: "refused", reason: error.message };
    }
    throw error;
  } finally {
    await removeCopy(fetched.root);
  }
}

export async function watchJudge(command: JudgeCommand, interval: number, runtime: Runtime, transport: Transport, out: (text: string) => void): Promise<number> {
  const signer = await messageSigner(runtime, command.keypair);
  const keypair = await judgeOpeners(runtime, command, isDevice(signer));
  const { address, attestor, specHash } = await escrowFor(transport, signer.address, command.owner, command.nonce);
  if (isDevice(signer)) {
    await deviceJudgeReady(transport, signer.address, address).catch(historyRefused);
  }
  const specBytes = await pinnedSpec(command.spec, address, specHash);
  const plan = runPlan(specBytes, command);
  if (plan.pinned !== undefined) {
    await checkFilesOf(command.check, plan);
  }
  const node = plan.sandbox.kind === "viper" ? plan.sandbox.node : undefined;
  const pinned = node === undefined ? undefined : nodeMemoryRead(specBytes).memory;
  if (node !== undefined) {
    await sandboxReady(plan.sandbox, dockerEnv(process.env));
    await nodeHostHeld(node, pinned, command.timeout);
  }
  const client = createClient({ url: command.url, transport });
  const seen = new Set<Address>();
  const judgedWork = new Set<string>();
  const stalled = new Map<Address, number>();
  const missed = new Map<Address, Missed>();
  let rounds = 0;
  const told = new Map<Address, string>();
  let judged = 0;
  const signals = holdSignals();
  const stop = new AbortController();
  signals.listen((signal) => stop.abort(signal));
  const stopped = (why: Stopped): number => {
    out(line({ stopped: why, intent: address, judged }));
    return 0;
  };
  const round = async (): Promise<Stopped | undefined> => {
    if (!(await stillOpen(transport, address))) {
      return "closed";
    }
    const fresh = (await client.announcementsTo(attestor)).announcements.filter((a) => a.intent === address && a.state === "announced" && !seen.has(a.address)).sort(bySeq);
    const opened = await openedBy(fresh, keypair);
    const work: Work = { judged: judgedWork, deferred: new Set<string>(), stalled, missed, round: rounds, stop: stop.signal };
    rounds += 1;
    for (const announcement of fresh) {
      if (signals.caught() !== undefined) {
        break;
      }
      if (!(await stillOpen(transport, address))) {
        return "closed";
      }
      if ((missed.get(announcement.address)?.due ?? 0) > work.round) {
        continue;
      }
      const found = opened.find((one) => one.announcement.address === announcement.address);
      let watched: Watched | null | "skipped" | "later";
      if (found === undefined || found.url === null) {
        const { address: at, seq, worker } = announcement;
        watched = { announcement: at, seq, worker, url: null, artifactSha256: null, verdict: "refused", reason: `the announcement ${at} ${SEALED_ELSEWHERE}` };
      } else {
        watched = await judgeAnnounced(command, runtime, transport, { announcement, salt: found.salt, url: found.url }, signals.caught, work);
      }
      if (watched === null) {
        break;
      }
      if (watched === "later") {
        continue;
      }
      if (watched !== "skipped" && "retry" in watched) {
        if (told.get(announcement.address) !== watched.reason) {
          told.set(announcement.address, watched.reason);
          out(line(watched));
        }
        continue;
      }
      seen.add(announcement.address);
      told.delete(announcement.address);
      if (watched === "skipped") {
        continue;
      }
      if (watched.verdict === "skipped" || watched.verdict === "refused") {
        out(line(watched));
        continue;
      }
      judged += 1;
      out(line(watched));
      if (watched.verdict === "pass") {
        return "signature" in watched && watched.signature !== null ? "paid" : "passed";
      }
    }
    return undefined;
  };
  let failing: string | undefined;
  try {
    for (;;) {
      const caught = signals.caught();
      if (caught !== undefined) {
        return stopped(caught);
      }
      let ended: Stopped | undefined;
      try {
        ended = await round();
        failing = undefined;
      } catch (error) {
        if (!rpcFailed(error)) {
          throw error;
        }
        if (failing !== reasonOf(error)) {
          failing = reasonOf(error);
          out(line({ intent: address, outcome: "deferred", reason: failing, retry: true }));
        }
      }
      if (ended !== undefined) {
        return stopped(ended);
      }
      if (signals.caught() === undefined && !(await runtime.sleep(interval, stop.signal))) {
        return stopped(signals.caught() ?? "ended");
      }
    }
  } catch (error) {
    if (error instanceof JudgeInterrupted) {
      stopped(signals.caught() ?? "SIGINT");
    }
    throw error;
  } finally {
    signals.release();
  }
}
