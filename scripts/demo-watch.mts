import { backoff, type Demo, MAX_BACKOFF_MS, type Found, foundIn, jittered, type Log, record, subscription } from "./demo-chain.mts";

export const WATCH_RETRY_MS = 1_000;
export const KEEPALIVE_MS = 10_000;
export const STABLE_MS = 30_000;
export const KEEPALIVE_ID = 0;
export const KEEPALIVE = JSON.stringify({ jsonrpc: "2.0", id: KEEPALIVE_ID, method: "getVersion" });

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

export type WatchOptions = { keepAliveMs?: number; stableMs?: number; up?: () => void; down?: () => void; random?: () => number };

export function watchOnce(open: (url: string) => Socket, url: string, program: string, demos: readonly Demo[], now: () => number, seen: (found: Found) => void, options: WatchOptions = {}): Promise<string> {
  return new Promise((done) => {
    let reason = "the subscription closed";
    let closing = false;
    let socket: Socket;
    try {
      socket = open(url);
    } catch (error) {
      done(error instanceof Error ? error.message : String(error));
      return;
    }
    const timers: { stop: () => void }[] = [];
    const shut = () => {
      if (!closing) {
        closing = true;
        socket.close();
      }
    };
    socket.addEventListener("open", () => {
      demos.forEach((demo, at) => socket.send(JSON.stringify({ jsonrpc: "2.0", id: at + 1, method: "programSubscribe", params: subscription(program, demo) })));
      const beat = setInterval(() => {
        try {
          socket.send(KEEPALIVE);
        } catch {
          shut();
        }
      }, options.keepAliveMs ?? KEEPALIVE_MS);
      const stable = setTimeout(() => options.up?.(), options.stableMs ?? STABLE_MS);
      beat.unref();
      stable.unref();
      timers.push({ stop: () => (clearInterval(beat), clearTimeout(stable)) });
    });
    socket.addEventListener("message", (event) => {
      const message = jsonOf(event.data);
      if (record(message)["id"] === KEEPALIVE_ID) {
        return;
      }
      if (record(message)["error"] !== undefined) {
        reason = `programSubscribe failed: ${JSON.stringify(record(message)["error"]).slice(0, 500)}`;
        shut();
        return;
      }
      notified(message, demos, now()).forEach(seen);
    });
    socket.addEventListener("error", shut);
    socket.addEventListener("close", () => {
      timers.forEach((timer) => timer.stop());
      done(reason);
    });
  });
}

export async function watch(open: (url: string) => Socket, url: string, program: string, demos: readonly Demo[], now: () => number, seen: (found: Found) => void, log: Log, wait: (ms: number) => Promise<unknown>, more: () => boolean = () => true, options: WatchOptions = {}): Promise<void> {
  let told: string | null = null;
  const up = () => {
    if (told !== null) {
      told = null;
      log.out(JSON.stringify({ at: new Date().toISOString(), round: "recovered", path: "watch", detail: "the subscription is open again" }));
    }
    options.up?.();
  };
  for (let failures = 0; more(); ) {
    const opened = Date.now();
    const reason = await watchOnce(open, url, program, demos, now, seen, { ...options, up });
    failures = Date.now() - opened > MAX_BACKOFF_MS ? 0 : failures + 1;
    options.down?.();
    if (reason !== told) {
      told = reason;
      log.err(JSON.stringify({ at: new Date().toISOString(), round: "failed", path: "watch", detail: reason }));
    }
    await wait(jittered(backoff(WATCH_RETRY_MS, failures), options.random ?? Math.random));
  }
}
