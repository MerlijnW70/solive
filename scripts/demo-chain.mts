export type Demo = { name: string; specHash: string; solution: string; workUrl: string };

export type DemoJob = {
  intent: string;
  owner: string;
  nonce: string;
  specHash: string;
  takesClaims: boolean;
  claimedBy: string | null;
  waiting: number;
  expiresAt: number;
  board?: Record<string, unknown>;
};

export type Found = { demo: Demo; job: DemoJob };

export type Rpc = (method: string, params: readonly unknown[]) => Promise<unknown>;

export type Read = (demos: readonly Demo[], now: number) => Promise<Found[]>;

export const INTENT_TAG = Uint8Array.from([247, 162, 35, 165, 254, 111, 129, 109]);
export const INTENT_SIZE = 464;
export const AT = { owner: 8, nonce: 136, expiresAt: 160, kind: 168, status: 169, specHash: 232, claims: 448 } as const;
export const CODE = { attestedResult: 4, open: 0, claimsOpen: 1 } as const;

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

export const textOf = (value: unknown): string | null => (typeof value === "string" ? value : typeof value === "number" || typeof value === "bigint" ? String(value) : null);

export function base58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) {
    value = value * 256n + BigInt(byte);
  }
  let text = "";
  for (; value > 0n; value /= 58n) {
    text = `${BASE58[Number(value % 58n)]}${text}`;
  }
  for (let at = 0; at < bytes.length && bytes[at] === 0; at += 1) {
    text = `1${text}`;
  }
  return text;
}

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

export function intentJob(intent: string, data: Uint8Array, now: number): DemoJob | null {
  if (data.length !== INTENT_SIZE || !INTENT_TAG.every((byte, at) => data[at] === byte) || data[AT.kind] !== CODE.attestedResult || data[AT.status] !== CODE.open) {
    return null;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const expiresAt = Number(view.getBigInt64(AT.expiresAt, true));
  const owner = base58(data.subarray(AT.owner, AT.owner + 32));
  const specHash = Buffer.from(data.subarray(AT.specHash, AT.specHash + 32)).toString("hex");
  const nonce = view.getBigUint64(AT.nonce, true).toString();
  return expiresAt <= now ? null : { intent, owner, nonce, specHash, takesClaims: data[AT.claims] === CODE.claimsOpen, claimedBy: null, waiting: 0, expiresAt };
}

export const demoFilters = (specHash: string): object[] => [
  { dataSize: INTENT_SIZE },
  { memcmp: { offset: 0, bytes: base64(INTENT_TAG), encoding: "base64" } },
  { memcmp: { offset: AT.kind, bytes: base64(Uint8Array.from([CODE.attestedResult, CODE.open])), encoding: "base64" } },
  { memcmp: { offset: AT.specHash, bytes: base64(Buffer.from(specHash, "hex")), encoding: "base64" } },
];

function accountsOf(listed: unknown): { intent: string; data: Uint8Array }[] {
  if (!Array.isArray(listed)) {
    throw new Error(`getProgramAccounts answered no list: ${JSON.stringify(listed ?? null).slice(0, 200)}`);
  }
  return listed.flatMap((entry) => {
    const intent = textOf(record(entry)["pubkey"]);
    const data = record(record(entry)["account"])["data"];
    const encoded = Array.isArray(data) && data[1] === "base64" ? textOf(data[0]) : null;
    return intent === null || encoded === null ? [] : [{ intent, data: new Uint8Array(Buffer.from(encoded, "base64")) }];
  });
}

export const foundIn = (demo: Demo, listed: unknown, now: number): Found[] =>
  accountsOf(listed).flatMap(({ intent, data }) => {
    const job = intentJob(intent, data, now);
    return job === null || job.specHash !== demo.specHash ? [] : [{ demo, job }];
  });

export const subscription = (program: string, demo: Demo) => [program, { encoding: "base64", commitment: "confirmed", filters: demoFilters(demo.specHash) }];

export function programReader(rpc: Rpc, program: string): Read {
  return async (demos, now) => {
    const found: Found[] = [];
    for (const demo of demos) {
      found.push(...foundIn(demo, await rpc("getProgramAccounts", subscription(program, demo)), now));
    }
    return found;
  };
}

export type Cli = (args: readonly string[]) => Promise<unknown>;

export type Action = "claimed" | "delivered" | "skipped" | "failed" | "gave-up" | "dropped" | "collected" | "ended" | "lost" | "reclaimed";

export type Event = { intent: string; demo: string; action: Action; detail?: string };

export type Log = { out: (line: string) => void; err: (line: string) => void };

export const sentSignature = (output: unknown, what: string): string => {
  const shown = record(output);
  const signature = textOf(shown["signature"]);
  if (shown["sent"] !== true || signature === null) {
    throw new Error(`${what} sent nothing: ${textOf(shown["next"]) ?? JSON.stringify(output)}`);
  }
  return signature;
};

export const MAX_BACKOFF_MS = 60_000;
export const JITTER = 0.5;

export const backoff = (every: number, failures: number): number => Math.max(every, Math.min(every * 2 ** Math.min(failures, 16), MAX_BACKOFF_MS));

export const jittered = (ms: number, random: () => number): number => Math.round(ms * (1 + JITTER * Math.min(Math.max(random(), 0), 1)));

export const CLUSTERS: Readonly<Record<string, string>> = {
  localnet: "http://127.0.0.1:8899",
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
};

export const rpcUrlOf = (url: string): string => CLUSTERS[url] ?? url;

export function wsUrlOf(url: string): string {
  const parsed = new URL(rpcUrlOf(url));
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  if (parsed.port !== "") {
    parsed.port = String(Number(parsed.port) + 1);
  }
  return parsed.toString();
}

export const RPC_TIMEOUT_MS = 15_000;
export const BUSY_HOLD_MS = 30_000;
export const MAX_RETRY_AFTER_MS = 600_000;

export type Gate = { wait: () => Promise<void>; hold: (ms: number) => void; until: () => number };

export const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

export function gateOf(clock: () => number = Date.now, sleep: (ms: number) => Promise<unknown> = pause): Gate {
  let until = 0;
  return {
    until: () => until,
    hold: (ms) => {
      until = Math.max(until, clock() + Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS));
    },
    wait: async () => {
      for (let left = until - clock(); left > 0; left = until - clock()) {
        await sleep(left);
      }
    },
  };
}

const HTTP_DATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

export function retryAfterMs(header: string | null, nowMs: number): number | null {
  const raw = header?.trim() ?? "";
  if (/^\d+$/.test(raw)) {
    return Math.min(Number(raw) * 1000, MAX_RETRY_AFTER_MS);
  }
  const at = HTTP_DATE.test(raw) ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(at) ? Math.min(Math.max(at - nowMs, 0), MAX_RETRY_AFTER_MS) : null;
}

export function rpcOf(url: string, fetcher: typeof fetch = fetch, gate: Gate = gateOf(), clock: () => number = Date.now): Rpc {
  let id = 0;
  return async (method, params) => {
    await gate.wait();
    id += 1;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const response = await fetcher(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
    if (response.status === 429) {
      const asked = retryAfterMs(response.headers?.get("retry-after") ?? null, clock());
      gate.hold(asked ?? BUSY_HOLD_MS);
      throw new Error(`${method} failed: the node answered 429; this worker waits ${Math.ceil((asked ?? BUSY_HOLD_MS) / 1000)} seconds${asked === null ? "" : ", as its Retry-After asks"}`);
    }
    if (!response.ok) {
      throw new Error(`${method} failed: the node answered ${response.status}`);
    }
    const answer = record(await response.json());
    if (answer["error"] !== undefined) {
      throw new Error(`${method} failed: ${JSON.stringify(answer["error"]).slice(0, 500)}`);
    }
    return answer["result"];
  };
}
