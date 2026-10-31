import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { type FakeDocument, type FakeElement, parse } from "./dom.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
export const PUBLIC = join(ROOT, "services", "live", "public");
export const read = (path: string): string => readFileSync(join(PUBLIC, path), "utf8");
export const NOW = Date.parse("2026-10-31T06:00:00.000Z");

type Timer = { id: number; at: number; fn: () => void; every: number | null };
type Answer = { ok: boolean; status: number; body: unknown } | "hang" | "reject";
export type Call = { url: string; signal: AbortSignal; init: Record<string, unknown> };

export type Page = {
  doc: FakeDocument;
  calls: Call[];
  copied: string[];
  clock: { now: number };
  answer: (next: Answer) => void;
  advance: (ms: number) => Promise<void>;
  settle: () => Promise<void>;
  byId: (id: string) => FakeElement;
  text: (id: string) => string;
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

export async function openPage(first: Answer): Promise<Page> {
  const doc = parse(read("index.html"));
  const clock = { now: NOW };
  const timers: Timer[] = [];
  const calls: Call[] = [];
  const copied: string[] = [];
  let next: Answer = first;
  let seq = 0;
  const add = (fn: () => void, ms: number, every: boolean): number => {
    seq += 1;
    timers.push({ id: seq, at: clock.now + Math.max(0, ms), fn, every: every ? ms : null });
    return seq;
  };
  const clear = (id: number | null): void => {
    const i = timers.findIndex((t) => t.id === id);
    if (i >= 0) timers.splice(i, 1);
  };
  const fetch = (url: string, init: Record<string, unknown>): Promise<unknown> => {
    const signal = init["signal"] as AbortSignal;
    calls.push({ url, signal, init });
    const answer = next;
    if (answer === "reject") return Promise.reject(new Error("offline"));
    if (answer === "hang") {
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    return Promise.resolve({ ok: answer.ok, status: answer.status, json: async () => structuredClone(answer.body) });
  };
  const date = new Proxy(Date, { get: (target, key, receiver) => (key === "now" ? () => clock.now : Reflect.get(target, key, receiver)) });
  const context = createContext({
    document: doc,
    fetch,
    AbortController,
    Date: date,
    setTimeout: (fn: () => void, ms: number) => add(fn, ms, false),
    clearTimeout: clear,
    setInterval: (fn: () => void, ms: number) => add(fn, ms, true),
    clearInterval: clear,
    navigator: { clipboard: { writeText: async (text: string) => { copied.push(text); } } },
    console,
  });
  runInContext(read("live.js"), context, { filename: "live.js" });
  await flush();
  const advance = async (ms: number): Promise<void> => {
    const end = clock.now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      clock.now = Math.max(clock.now, due.at);
      if (due.every === null) clear(due.id);
      else due.at += due.every;
      due.fn();
      await flush();
    }
    clock.now = end;
    await flush();
  };
  const byId = (id: string): FakeElement => {
    const el = doc.getElementById(id);
    if (!el) throw new Error("no element #" + id);
    return el;
  };
  return {
    doc,
    calls,
    copied,
    clock,
    answer: (value) => { next = value; },
    advance,
    settle: flush,
    byId,
    text: (id) => byId(id).textContent.replace(/\s+/g, " ").trim(),
  };
}

export const ok = (body: unknown): Answer => ({ ok: true, status: 200, body });

export function anchors(doc: FakeDocument): FakeElement[] {
  return doc.documentElement.querySelectorAll("a");
}
