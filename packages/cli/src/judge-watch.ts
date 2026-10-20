import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Address, Signature } from "@solana/kit";
import { getIntentDecoder, INTENT_ENGINE_PROGRAM_ADDRESS, IntentStatus } from "@intent-engine/core";
import { chainTime, type Delivery, deliveryRecord, deviceJudgeReady, isDevice, type Transport, unopenedOf } from "@intent-engine/client";
import { removeCopy } from "./artifact.js";
import { holdSignals } from "./check-process.js";
import { DeliveryUnfit, type Fetched, fetchDelivery } from "./delivery-fetch.js";
import { type InterruptSignal, JudgeInterrupted, JudgeRefused } from "./judge-errors.js";
import { escrowFor, historyRefused, judge, type JudgeCommand, judgeOpeners, pagesRead, unopenedRefusal, type Verdict } from "./judge.js";
import { messageSigner } from "./ledger-keys.js";
import type { Runtime } from "./runtime.js";

export type Stopped = "paid" | "passed" | "closed" | "ended" | InterruptSignal;

type Announced = { url: string; worker: Address; announced: Signature };

export type Watched = Announced & (Verdict | { artifactSha256: string; verdict: "fail"; reason: string });

export const SEALED_ELSEWHERE = "is sealed to other wallets than this judge, so its url cannot be read";

const earlier = (a: Delivery, b: Delivery): number => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0);

function unjudged(deliveries: readonly Delivery[], seen: ReadonlySet<string>): Delivery[] {
  return deliveries.filter(({ signature }) => !seen.has(signature)).sort(earlier);
}

const line = (value: object): string => JSON.stringify(value, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v));

async function stillOpen(transport: Transport, intent: Address): Promise<boolean> {
  const account = await transport.getAccount(intent);
  if (account === null || account.owner !== INTENT_ENGINE_PROGRAM_ADDRESS || account.data.length === 0) {
    return false;
  }
  const { status, expiresAt } = getIntentDecoder().decode(account.data);
  return status === IntentStatus.Open && expiresAt > (await chainTime(transport));
}

async function judgeDelivery(
  command: JudgeCommand,
  runtime: Runtime,
  transport: Transport,
  delivery: Delivery,
  interrupted: () => InterruptSignal | undefined,
  seen: Set<string>,
): Promise<Watched | null | "skipped"> {
  const announced: Announced = { url: delivery.url, worker: delivery.worker, announced: delivery.signature };
  const failed = (error: Error): Watched => ({ ...announced, artifactSha256: delivery.sha256, verdict: "fail", reason: error.message });
  if (delivery.url === "") {
    return failed(new DeliveryUnfit(`announcement ${delivery.signature}`, SEALED_ELSEWHERE));
  }
  let fetched: Fetched;
  try {
    fetched = await fetchDelivery(runtime.specFetch, transport, delivery, command.timeout);
  } catch (error) {
    if (error instanceof DeliveryUnfit) {
      return failed(error);
    }
    throw error;
  }
  try {
    if (interrupted() !== undefined) {
      return null;
    }
    if (seen.has(fetched.sha256)) {
      return "skipped";
    }
    seen.add(fetched.sha256);
    return { ...announced, ...(await judge({ ...command, artifact: fetched.path }, runtime, transport)) };
  } catch (error) {
    if (error instanceof JudgeRefused) {
      return failed(error);
    }
    throw error;
  } finally {
    await removeCopy(fetched.root);
  }
}

export async function watchJudge(command: JudgeCommand, interval: number, runtime: Runtime, transport: Transport, out: (text: string) => void): Promise<number> {
  const signer = await messageSigner(runtime, command.keypair);
  const keypair = await judgeOpeners(runtime, command, isDevice(signer));
  const { address, attestor, committee, specHash } = await escrowFor(transport, signer.address, command.owner, command.nonce);
  const confirm = command.confirmUrl === undefined ? undefined : runtime.transport(command.confirmUrl);
  if (isDevice(signer)) {
    await deviceJudgeReady(transport, signer.address, address).catch(historyRefused);
  }
  const specSha256 = createHash("sha256").update(await readFile(resolve(command.spec))).digest("hex");
  if (specSha256 !== specHash) {
    throw new JudgeRefused(`--spec ${command.spec} has sha256 ${specSha256}, but intent ${address} commits ${specHash}`);
  }
  const seen = new Set<string>();
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
      const record = await deliveryRecord(transport, attestor, address, command.maxPages, keypair);
      if (!record.complete) {
        throw new JudgeRefused(
          `the delivery record of intent ${address} is incomplete because the judge's history is too long to read in full or the RPC node cannot serve all of it; nothing was run or paid. ${pagesRead(record.pages)}`,
        );
      }
      const recipients = committee?.members ?? [attestor];
      const { missing } = await unopenedOf(transport, { judge: signer.address, recipients, deliveries: record.deliveries, first: null, openers: keypair, confirm }).catch(historyRefused);
      if (missing !== null) {
        throw new JudgeRefused(unopenedRefusal(missing, command.keypair, isDevice(signer)));
      }
      const fresh = unjudged(record.deliveries, seen);
      for (const first of fresh) {
        if (signals.caught() !== undefined) {
          break;
        }
        if (!(await stillOpen(transport, address))) {
          return stopped("closed");
        }
        const watched = await judgeDelivery(command, runtime, transport, first, signals.caught, seen);
        if (watched === null) {
          break;
        }
        seen.add(first.signature);
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
