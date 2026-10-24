import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Address } from "@solana/kit";
import { getIntentDecoder, INTENT_ENGINE_PROGRAM_ADDRESS, IntentStatus } from "@intent-engine/core";
import { type AnnouncementView, chainTime, createClient, deviceJudgeReady, isDevice, type Transport } from "@intent-engine/client";
import { openedBy } from "./announcement-views.js";
import { removeCopy } from "./artifact.js";
import { holdSignals } from "./check-process.js";
import { type Announced, DeliveryUnfit, type Fetched, fetchDelivery } from "./delivery-fetch.js";
import { type InterruptSignal, JudgeInterrupted, JudgeRefused } from "./judge-errors.js";
import { escrowFor, historyRefused, judge, type JudgeCommand, judgeOpeners, type Verdict } from "./judge.js";
import { messageSigner } from "./ledger-keys.js";
import type { Runtime } from "./runtime.js";

export type Stopped = "paid" | "passed" | "closed" | "ended" | InterruptSignal;

type Seen = { announcement: Address; seq: bigint; worker: Address; url: string | null };

export type Watched = Seen & (Verdict | { artifactSha256: string | null; verdict: "fail"; reason: string });

export const SEALED_ELSEWHERE = "opens with none of the keys this judge was given, so its url cannot be read";

const line = (value: object): string => JSON.stringify(value, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v));

async function stillOpen(transport: Transport, intent: Address): Promise<boolean> {
  const account = await transport.getAccount(intent);
  if (account === null || account.owner !== INTENT_ENGINE_PROGRAM_ADDRESS || account.data.length === 0) {
    return false;
  }
  const { status, expiresAt } = getIntentDecoder().decode(account.data);
  return status === IntentStatus.Open && expiresAt > (await chainTime(transport));
}

const bySeq = (a: AnnouncementView, b: AnnouncementView): number => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0);

async function judgeAnnounced(
  command: JudgeCommand,
  runtime: Runtime,
  transport: Transport,
  delivery: Announced,
  interrupted: () => InterruptSignal | undefined,
  judgedWork: Set<string>,
): Promise<Watched | null | "skipped"> {
  const { announcement } = delivery;
  const seen: Seen = { announcement: announcement.address, seq: announcement.seq, worker: announcement.worker, url: delivery.url };
  const failed = (error: Error, sha256: string | null): Watched => ({ ...seen, artifactSha256: sha256, verdict: "fail", reason: error.message });
  let fetched: Fetched;
  try {
    fetched = await fetchDelivery(runtime.specFetch, transport, delivery, command.timeout);
  } catch (error) {
    if (error instanceof DeliveryUnfit) {
      return failed(error, null);
    }
    throw error;
  }
  try {
    if (interrupted() !== undefined) {
      return null;
    }
    if (judgedWork.has(fetched.sha256)) {
      return "skipped";
    }
    judgedWork.add(fetched.sha256);
    return { ...seen, ...(await judge({ ...command, artifact: fetched.path }, runtime, transport)) };
  } catch (error) {
    if (error instanceof JudgeRefused) {
      return failed(error, fetched.sha256);
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
  const specSha256 = createHash("sha256").update(await readFile(resolve(command.spec))).digest("hex");
  if (specSha256 !== specHash) {
    throw new JudgeRefused(`--spec ${command.spec} has sha256 ${specSha256}, but intent ${address} commits ${specHash}`);
  }
  const client = createClient({ url: command.url, transport });
  const seen = new Set<Address>();
  const judgedWork = new Set<string>();
  let judged = 0;
  const signals = holdSignals();
  const stop = new AbortController();
  signals.listen(() => stop.abort());
  const stopped = (why: Stopped): number => {
    out(line({ stopped: why, intent: address, judged }));
    return 0;
  };
  try {
    for (;;) {
      const caught = signals.caught();
      if (caught !== undefined) {
        return stopped(caught);
      }
      if (!(await stillOpen(transport, address))) {
        return stopped("closed");
      }
      const fresh = (await client.announcementsTo(attestor)).filter((a) => a.intent === address && a.state === "announced" && !seen.has(a.address)).sort(bySeq);
      const opened = await openedBy(fresh, keypair);
      for (const announcement of fresh) {
        if (signals.caught() !== undefined) {
          break;
        }
        if (!(await stillOpen(transport, address))) {
          return stopped("closed");
        }
        const found = opened.find((one) => one.announcement.address === announcement.address);
        let watched: Watched | null | "skipped";
        if (found === undefined || found.url === null) {
          const { address: at, seq, worker } = announcement;
          watched = { announcement: at, seq, worker, url: null, artifactSha256: null, verdict: "fail", reason: `the announcement ${at} ${SEALED_ELSEWHERE}` };
        } else {
          watched = await judgeAnnounced(command, runtime, transport, { announcement, salt: found.salt, url: found.url }, signals.caught, judgedWork);
        }
        if (watched === null) {
          break;
        }
        seen.add(announcement.address);
        if (watched === "skipped") {
          continue;
        }
        judged += 1;
        out(line(watched));
        if (watched.verdict === "pass") {
          return stopped("signature" in watched && watched.signature !== null ? "paid" : "passed");
        }
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
