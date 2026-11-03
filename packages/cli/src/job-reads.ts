import { AsyncLocalStorage } from "node:async_hooks";
import type { Address } from "@solana/kit";
import type { Transport } from "@intent-engine/client";
import { boundMembers, chainTime, SPEC_READ_MS, specUrlOf, stopsFrom } from "@intent-engine/client/internal";

export const REQUEST_MS = 10_000;
export const HISTORY_READ_MS = 10_000;
export const READ_BOUND_MS = SPEC_READ_MS + HISTORY_READ_MS;
export const READS_AT_ONCE = 16;
export const KEPT_JOBS = 1_024;
export const KEPT_MS = 300_000;
export const DOUBT_KEPT_MS = 120_000;
export const YOUNG_JOB_SECONDS = 300n;
export const YOUNG_DOUBT_MS = 15_000;

export type ReadVerdict = false | true | { plain: string };

export type Readable = (transport: Transport, intent: Address, signal?: AbortSignal) => Promise<ReadVerdict>;

export type JobToRead = { intent: Address; createdAt: bigint; owner: Address; specHash: Uint8Array };

export type KnownJob = { url: string | null; checked: boolean };

export type SeenSpec = { source: string; matches: boolean; sealedTo?: readonly Address[] | undefined } | null;

export class ReadStopped extends Error {}

class Kept<T> {
  readonly #entries = new Map<string, { value: T; until: number }>();
  readonly #most: number;

  constructor(most: number) {
    this.#most = most;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: string, now: number): T | undefined {
    const found = this.#entries.get(key);
    if (found !== undefined && found.until <= now) {
      this.#entries.delete(key);
      return undefined;
    }
    return found?.value;
  }

  put(key: string, value: T, until: number): void {
    this.#entries.delete(key);
    this.#entries.set(key, { value, until });
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= this.#most) {
        break;
      }
      this.#entries.delete(oldest);
    }
  }

  drop(key: string): void {
    this.#entries.delete(key);
  }

  dropWhere(match: (key: string) => boolean): void {
    for (const key of [...this.#entries.keys()]) {
      if (match(key)) {
        this.#entries.delete(key);
      }
    }
  }
}

function settledBefore<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new ReadStopped("the read ran past its bound or was closed"));
    if (signal.aborted) {
      stop();
    }
    signal.addEventListener("abort", stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

const closings = new AsyncLocalStorage<AbortSignal>();

stopsFrom(() => closings.getStore());

type Asking = { began: () => void; ended: () => void };

function guarded(transport: Transport, signal: AbortSignal, closing: AbortSignal, requestBound: () => AbortSignal, asking: Asking): Transport {
  const members = boundMembers(transport) as unknown as Record<PropertyKey, unknown>;
  for (const key of Reflect.ownKeys(members)) {
    const member = members[key];
    if (typeof member !== "function") {
      continue;
    }
    members[key] = (...args: unknown[]): unknown => {
      if (signal.aborted) {
        return Promise.reject(new ReadStopped("the read ran past its bound or was closed"));
      }
      const answer: unknown = closings.run(closing, () => member(...args));
      if (!(answer instanceof Promise)) {
        return answer;
      }
      const limit = requestBound();
      let open = true;
      const ended = () => {
        if (open) {
          open = false;
          limit.removeEventListener("abort", ended);
          asking.ended();
        }
      };
      asking.began();
      limit.addEventListener("abort", ended, { once: true });
      answer.then(ended, ended);
      return settledBefore(AbortSignal.any([signal, limit]), answer);
    };
  }
  return members as unknown as Transport;
}

export type JobReadsOptions = {
  now?: () => number;
  bound?: () => AbortSignal;
  requestBound?: () => AbortSignal;
  most?: number;
  kept?: number;
};

const keyOf = (job: JobToRead): string => `${job.intent} ${job.createdAt} ${Buffer.from(job.specHash).toString("hex")}`;

export class JobReads {
  readonly #urls: Kept<string>;
  readonly #verdicts: Kept<false | { plain: string }>;
  readonly #flights = new Map<string, Promise<unknown>>();
  readonly #closing = new AbortController();
  readonly #now: () => number;
  readonly #bound: () => AbortSignal;
  readonly #requestBound: () => AbortSignal;
  readonly #most: number;
  #busy = 0;

  constructor({
    now = Date.now,
    bound = () => AbortSignal.timeout(READ_BOUND_MS),
    requestBound = () => AbortSignal.timeout(REQUEST_MS),
    most = READS_AT_ONCE,
    kept = KEPT_JOBS,
  }: JobReadsOptions = {}) {
    this.#urls = new Kept(kept);
    this.#verdicts = new Kept(kept);
    this.#now = now;
    this.#bound = bound;
    this.#requestBound = requestBound;
    this.#most = most;
  }

  get busy(): number {
    return this.#busy;
  }

  get running(): number {
    return this.#flights.size;
  }

  get keptJobs(): number {
    return Math.max(this.#urls.size, this.#verdicts.size);
  }

  close(): void {
    this.#closing.abort();
  }

  #settled(job: JobToRead, chainNow: bigint | null): boolean {
    return (chainNow ?? BigInt(Math.floor(this.#now() / 1000))) - job.createdAt > YOUNG_JOB_SECONDS;
  }

  async #urlRead(key: string, reach: Transport, job: JobToRead, signal: AbortSignal): Promise<void> {
    const url = await specUrlOf(reach, job.intent, job.createdAt, job.owner);
    if (!signal.aborted && url !== null) {
      this.#urls.put(key, url, this.#now() + KEPT_MS);
    }
  }

  #flight(key: string, transport: Transport, work: (reach: Transport, signal: AbortSignal) => Promise<void>): void {
    if (this.#flights.has(key) || this.#busy >= this.#most || this.#closing.signal.aborted) {
      return;
    }
    this.#busy++;
    const signal = AbortSignal.any([this.#bound(), this.#closing.signal]);
    let asking = 0;
    let over = false;
    const freed = () => {
      if (over && asking === 0) {
        over = false;
        this.#busy--;
      }
    };
    const reach = guarded(transport, signal, this.#closing.signal, this.#requestBound, {
      began: () => asking++,
      ended: () => {
        asking--;
        freed();
      },
    });
    const flight = settledBefore(signal, (async () => work(reach, signal))()).finally(() => {
      this.#flights.delete(key);
      over = true;
      freed();
    });
    this.#flights.set(key, flight);
    flight.catch(() => undefined);
  }

  pending(job: JobToRead, all: boolean): Promise<unknown> | undefined {
    return this.#flights.get(`${all ? "url" : "spec"} ${keyOf(job)}`)?.catch(() => undefined);
  }

  known(job: JobToRead, all: boolean): KnownJob | null {
    const key = keyOf(job);
    const now = this.#now();
    const verdict = this.#verdicts.get(key, now);
    if (verdict === false) {
      return all ? { url: this.#urls.get(key, now) ?? null, checked: false } : null;
    }
    return verdict === undefined ? { url: this.#urls.get(key, now) ?? null, checked: false } : { url: verdict.plain, checked: true };
  }

  start(transport: Transport, job: JobToRead, all: boolean, readable: Readable): void {
    const key = keyOf(job);
    const now = this.#now();
    if (all) {
      if (this.#urls.get(key, now) === undefined && this.#verdicts.get(key, now) === undefined) {
        this.#flight(`url ${key}`, transport, async (reach, signal) => {
          await this.#urlRead(key, reach, job, signal);
        });
      }
      return;
    }
    if (this.#verdicts.get(key, now) !== undefined) {
      return;
    }
    this.#flight(`spec ${key}`, transport, async (reach, signal) => {
      if (this.#urls.get(key, this.#now()) === undefined) {
        await this.#urlRead(key, reach, job, signal);
      }
      const verdict = await readable(reach, job.intent, signal);
      if (verdict === false) {
        const chainNow = await chainTime(reach).catch(() => null);
        if (!signal.aborted) {
          this.#verdicts.put(key, false, this.#now() + (this.#settled(job, chainNow) ? DOUBT_KEPT_MS : YOUNG_DOUBT_MS));
        }
        return;
      }
      if (signal.aborted) {
        return;
      }
      if (verdict === true) {
        this.#verdicts.drop(key);
        return;
      }
      this.#verdicts.put(key, verdict, this.#now() + KEPT_MS);
      this.#urls.put(key, verdict.plain, this.#now() + KEPT_MS);
    });
  }

  saw(intent: Address, spec: SeenSpec): void {
    const plain = spec !== null && (spec.source === "memo" || spec.source === "cache") && spec.matches && spec.sealedTo === undefined;
    if (!plain) {
      this.#verdicts.dropWhere((key) => key.startsWith(`${intent} `));
    }
  }
}
