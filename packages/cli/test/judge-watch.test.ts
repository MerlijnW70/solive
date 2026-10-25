import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, KeyPairSigner } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, IntentStatus, Kind } from "@intent-engine/core";
import { announcementCommitment, getIntentDecoder } from "@intent-engine/core/internal";
import { type AnnouncementView, type SpecFetch, type Transport } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { DEVNET_GENESIS_HASH, loadAnnouncement, PLAIN_HTTP_ON_PUBLIC } from "@intent-engine/client/internal";
import { MAX_ARTIFACT_BYTES } from "../src/artifact.js";
import { DeliveryUnfit, FETCHED_NAME, fetchDelivery, fetchedName } from "../src/delivery-fetch.js";
import { NOT_SENT } from "../src/flows.js";
import { JUDGE_WATCH_INTERVAL, WATCH_TAKES_NO_ARTIFACT } from "../src/job-args.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, main, nodeRuntime } from "../src/main.js";
import type { Runtime } from "../src/runtime.js";
import { announced, keyed } from "./announce.js";
import { balance, cli, h, NOW, runtime, setNow, transport, type World, world } from "./harness.js";

const CASES = '{"cases": [{"args": [""], "expected": 0}, {"args": ["one two"], "expected": 2}]}';
const SPEC = `# Count words\n\n\`\`\`judge-cases\n${CASES}\n\`\`\`\n`;
const CORRECT = "export default function count(text) { const words = text.match(/\\S+/g); return words === null ? 0 : words.length; }\n";
const WRONG = "export default function count(text) { return text.split(' ').length; }\n";

const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");

type Job = { w: World; judge: KeyPairSigner; intent: Address; spec: string };

async function job(): Promise<Job> {
  const w = await world();
  const judge = await keyed("judge.json");
  const dir = await mkdtemp(join(tmpdir(), "judge-watch-"));
  const spec = join(dir, "spec.md");
  await writeFile(spec, SPEC);
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: new Uint8Array(createHash("sha256").update(SPEC).digest()), judgeFee: 0n } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({
    signer: w.owner,
    params,
    inputMint: w.inputMint,
    outputMint: w.outputMint,
    nonce: 0n,
    expiresAt: NOW + 3_600n,
  });
  return { w, judge, intent, spec };
}

type Made = { url: string; announcement: Address; seq: bigint; salt: string };

let urls = 0;

async function announce(j: Job, worker: KeyPairSigner, module: string, served: string = module, through: Transport = transport): Promise<Made> {
  urls += 1;
  const url = ["https://work.example.org", String(urls), "count.mjs"].join("/");
  h.specPages.set(url, new TextEncoder().encode(served));
  const made = await announced(j.intent, worker, sha(module), url, through);
  return { url, announcement: made.announcement, seq: made.seq, salt: made.salt };
}

const judging = (j: Job, ...more: string[]) => ["judge", "--keypair", "judge.json", "--owner", j.w.owner.address, "--nonce", "0", "--spec", j.spec, "--sandbox", "viper", "--watch", ...more];

type Watch = { rounds?: number; slept?: (round: number) => Promise<void> | void; fetching?: () => void; through?: Transport };

async function watch(j: Job, argv: string[], { rounds = 3, slept, fetching, through }: Watch = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const base = { ...runtime({ "judge.json": j.judge }), ...(through === undefined ? {} : { transport: () => through }) };
  const sleeps: number[] = [];
  const fetched: string[] = [];
  const rt: Runtime = {
    ...base,
    specFetch: async (url, init) => {
      fetched.push(url);
      fetching?.();
      return base.specFetch(url, init);
    },
    sleep: async (seconds, stop) => {
      sleeps.push(seconds);
      await slept?.(sleeps.length);
      return sleeps.length < rounds && stop?.aborted !== true;
    },
  };
  const code = await main(argv, rt, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, err: err.join("\n"), lines: out.map((o) => JSON.parse(o) as Record<string, unknown>), sleeps, fetched };
}

const status = (intent: Address) => {
  const account = h.svm.getAccount(intent);
  return account.exists ? getIntentDecoder().decode(account.data).status : undefined;
};

const paidTo = async (j: Job, worker: Address) => balance(await findAssociatedTokenAddress({ owner: worker, mint: j.w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }));

const quietly = async <T>(run: () => Promise<T>): Promise<T> => {
  const others = process.listeners("SIGINT");
  process.removeAllListeners("SIGINT");
  try {
    return await run();
  } finally {
    for (const listener of others) {
      process.on("SIGINT", listener);
    }
  }
};

describe("intent-engine judge --watch", () => {
  it("judges a failing delivery, then a passing one announced later, pays the passing worker and exits 0", async () => {
    const j = await job();
    const [first, second] = [await keyed(), await keyed()];
    const wrong = await announce(j, first, WRONG);
    const watched = await watch(j, judging(j, "--yes"), {
      slept: async (round) => {
        if (round === 1) {
          await announce(j, second, CORRECT);
        }
      },
    });
    expect([watched.code, watched.err]).toEqual([EXIT_OK, ""]);
    expect(watched.sleeps).toEqual([JUDGE_WATCH_INTERVAL]);
    expect(watched.lines).toEqual([
      expect.objectContaining({ url: wrong.url, worker: first.address, announcement: wrong.announcement, seq: "1", artifactSha256: sha(WRONG), verdict: "fail", signature: null }),
      expect.objectContaining({ worker: second.address, artifactSha256: sha(CORRECT), verdict: "pass", payTo: second.address, signature: expect.any(String) }),
      { stopped: "paid", intent: j.intent, judged: 2 },
    ]);
    expect(await paidTo(j, second.address)).toBeGreaterThan(0n);
    expect(await paidTo(j, first.address)).toBe(-1n);
    expect(status(j.intent)).toBe(IntentStatus.Filled);
  }, 60_000);

  it("judges deliveries in announcement order", async () => {
    const j = await job();
    const [early, late] = [await keyed(), await keyed()];
    await announce(j, early, WRONG);
    await announce(j, late, CORRECT);
    const watched = await watch(j, judging(j, "--yes"));
    expect(watched.lines.map((l) => l["worker"] ?? l["stopped"])).toEqual([early.address, late.address, "paid"]);
  }, 60_000);

  it("judges each announced hash once, however often it is announced or how many passes run", async () => {
    const j = await job();
    const [worker, copier] = [await keyed(), await keyed()];
    const { url } = await announce(j, worker, WRONG);
    const { url: copied } = await announce(j, copier, WRONG);
    const watched = await watch(j, judging(j, "--yes", "--interval", "5"), { rounds: 4 });
    expect(watched.code).toBe(EXIT_OK);
    expect(watched.sleeps).toEqual([5, 5, 5, 5]);
    expect(watched.fetched).toEqual([url, copied]);
    expect(watched.lines).toEqual([expect.objectContaining({ worker: worker.address, verdict: "fail" }), { stopped: "ended", intent: j.intent, judged: 1 }]);
    expect(status(j.intent)).toBe(IntentStatus.Open);
  }, 60_000);

  it("exits 0 when the escrow closes while it watches", async () => {
    const j = await job();
    await announce(j, await keyed(), WRONG);
    const watched = await watch(j, judging(j, "--yes"), {
      rounds: 10,
      slept: () => setNow(NOW + 7_200n),
    });
    expect([watched.code, watched.err]).toEqual([EXIT_OK, ""]);
    expect(watched.sleeps).toHaveLength(1);
    expect(watched.lines.at(-1)).toEqual({ stopped: "closed", intent: j.intent, judged: 1 });
  }, 60_000);

  it("previews a passing delivery without --yes, sends nothing and exits 0", async () => {
    const j = await job();
    const worker = await keyed();
    await announce(j, worker, CORRECT);
    const watched = await watch(j, judging(j));
    expect([watched.code, watched.err]).toEqual([EXIT_OK, ""]);
    expect(watched.lines).toEqual([
      expect.objectContaining({ verdict: "pass", payTo: worker.address, signature: null, simulated: { ok: true, units_consumed: expect.any(Number) }, next: NOT_SENT }),
      { stopped: "passed", intent: j.intent, judged: 1 },
    ]);
    expect(status(j.intent)).toBe(IntentStatus.Open);
    expect(await paidTo(j, worker.address)).toBe(-1n);
  }, 60_000);

  it("fails work whose bytes the announcement's commitment does not bind, never runs it and never fetches it again", async () => {
    const j = await job();
    const worker = await keyed();
    const made = await announce(j, worker, CORRECT, WRONG);
    const watched = await watch(j, judging(j, "--yes"));
    expect(watched.fetched).toEqual([made.url]);
    const view = (await loadAnnouncement(transport, made.announcement)) as AnnouncementView;
    expect(watched.lines[0]).toEqual({
      url: made.url,
      worker: worker.address,
      announcement: made.announcement,
      seq: "1",
      artifactSha256: null,
      verdict: "fail",
      reason: `the work at ${made.url} has sha256 ${sha(WRONG)}, which the commitment ${Buffer.from(view.commitment).toString("hex")} of ${worker.address} does not bind; it is not judged again`,
    });
    expect(status(j.intent)).toBe(IntentStatus.Open);
  }, 60_000);

  it("stops cleanly on Ctrl-C while it waits or fetches, and judges nothing after it", async () => {
    await quietly(async () => {
      const j = await job();
      await announce(j, await keyed(), WRONG);
      const waiting = await watch(j, judging(j, "--yes"), { rounds: 10, slept: () => void process.emit("SIGINT", "SIGINT") });
      expect([waiting.code, waiting.err]).toEqual([EXIT_OK, ""]);
      expect(waiting.sleeps).toHaveLength(1);
      expect(waiting.lines.at(-1)).toEqual({ stopped: "SIGINT", intent: j.intent, judged: 1 });
      const k = await job();
      await announce(k, await keyed(), CORRECT);
      const fetching = await watch(k, judging(k, "--yes"), { fetching: () => void process.emit("SIGINT", "SIGINT") });
      expect([fetching.code, fetching.lines]).toEqual([EXIT_OK, [{ stopped: "SIGINT", intent: k.intent, judged: 0 }]]);
      expect(fetching.sleeps).toEqual([]);
      expect(status(k.intent)).toBe(IntentStatus.Open);
    });
  }, 60_000);

  it("prints its stop line and exits with the signal's code when Ctrl-C arrives while it pays", async () => {
    await quietly(async () => {
      const j = await job();
      await announce(j, await keyed(), CORRECT);
      h.through = {
        ...transport,
        send: async (ixs, payer) => {
          const signature = await transport.send(ixs, payer);
          process.emit("SIGINT", "SIGINT");
          return signature;
        },
      };
      const watched = await watch(j, judging(j, "--yes"));
      expect(watched.code).toBe(130);
      expect(watched.err).toContain("SIGINT arrived while the release was being sent; it was sent in");
      expect(watched.lines).toEqual([{ stopped: "SIGINT", intent: j.intent, judged: 0 }]);
      expect(status(j.intent)).toBe(IntentStatus.Filled);
    });
  }, 60_000);

  it("refuses before watching when the spec does not match", async () => {
    const j = await job();
    await writeFile(j.spec, "# another spec\n");
    const mismatched = await watch(j, judging(j, "--yes"));
    expect([mismatched.code, mismatched.lines, mismatched.fetched]).toEqual([EXIT_FAILED, [], []]);
    expect(mismatched.err).toContain(`but intent ${j.intent} commits ${sha(SPEC)}`);
  });

  it("finds an announcement made after it started from accounts, settles it once, and reads no transaction history for it", async () => {
    const j = await job();
    const worker = await keyed();
    const reads: (Address | undefined)[] = [];
    const accountsOnly: Transport = {
      ...transport,
      engineTransactions: async (limit, of) => {
        reads.push(of);
        if (of !== j.intent) {
          throw new Error(`history read of ${of ?? "the program"}`);
        }
        return transport.engineTransactions(limit, of);
      },
    };
    let made: Made | undefined;
    const watched = await watch(j, judging(j, "--yes"), {
      rounds: 5,
      through: accountsOnly,
      slept: async (round) => {
        if (round === 1) {
          made = await announce(j, worker, CORRECT, CORRECT, accountsOnly);
        }
      },
    });
    expect([watched.code, watched.err]).toEqual([EXIT_OK, ""]);
    expect(watched.lines).toEqual([
      expect.objectContaining({ announcement: made?.announcement, worker: worker.address, verdict: "pass", payTo: worker.address, signature: expect.any(String) }),
      { stopped: "paid", intent: j.intent, judged: 1 },
    ]);
    expect(watched.sleeps).toEqual([JUDGE_WATCH_INTERVAL]);
    expect(reads.every((of) => of === j.intent)).toBe(true);
    expect((await loadAnnouncement(transport, made?.announcement as Address))?.state).toBe("paid");
    expect(status(j.intent)).toBe(IntentStatus.Filled);
    expect(await paidTo(j, worker.address)).toBeGreaterThan(0n);
  }, 60_000);

  it("takes no --artifact, and --interval only with --watch", async () => {
    const j = await job();
    const withArtifact = await cli([...judging(j), "--artifact", j.spec], { "judge.json": j.judge });
    expect(withArtifact.code).toBe(EXIT_USAGE);
    expect(withArtifact.err).toContain(WATCH_TAKES_NO_ARTIFACT);
    const once = judging(j).filter((arg) => arg !== "--watch");
    const interval = await cli([...once, "--artifact", j.spec, "--interval", "5"], { "judge.json": j.judge });
    expect(interval.code).toBe(EXIT_USAGE);
    expect(interval.err).toContain("--interval needs --watch");
  });
});

const SALT = new Uint8Array(16).fill(0xab);

async function delivery(url: string, sha256: string): Promise<{ announcement: AnnouncementView; salt: string; url: string }> {
  const intent = "SysvarRent111111111111111111111111111111111" as Address;
  const worker = "SysvarC1ock11111111111111111111111111111111" as Address;
  const commitment = await announcementCommitment(intent, worker, { delivered: Uint8Array.from(Buffer.from(sha256, "hex")), salt: SALT });
  const announcement = { address: intent, intent, worker, commitment } as unknown as AnnouncementView;
  return { announcement, salt: Buffer.from(SALT).toString("hex"), url };
}

const serving = (response: () => Response | Promise<Response>): SpecFetch => async () => response();

describe("fetching a delivery to judge", () => {
  it("writes work that matches its announced hash to a fresh private file named after the url", async () => {
    await world();
    const bytes = new TextEncoder().encode(CORRECT);
    const fetched = await fetchDelivery(serving(() => new Response(bytes)), transport, await delivery("https://a.example/x/count.mjs", sha(bytes)), 5);
    expect(fetched.path).toBe(join(fetched.root, "count.mjs"));
    expect(await readFile(fetched.path, "utf8")).toBe(CORRECT);
    if (process.platform !== "win32") {
      expect((await stat(fetched.path)).mode & 0o777).toBe(0o600);
    }
    await rm(fetched.root, { recursive: true });
    for (const [url, name] of [
      ["https://a.example/", FETCHED_NAME],
      ["https://a.example/..", FETCHED_NAME],
      ["https://a.example/.hidden", FETCHED_NAME],
      ["https://a.example/a%2Fb", FETCHED_NAME],
      ["https://a.example/w.patch?x=1", "w.patch"],
    ] as const) {
      expect(fetchedName(new URL(url)), url).toBe(name);
    }
  });

  it("refuses work it cannot fetch, that is too large or that a public cluster may not fetch over plain http", async () => {
    await world();
    const hash = sha("x");
    const big = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(MAX_ARTIFACT_BYTES / 4 + 1));
      },
    });
    for (const [url, get, reason] of [
      ["not a url", serving(() => new Response("x")), "is not a url"],
      ["ftp://a.example/x", serving(() => new Response("x")), "is not an http or https url"],
      ["https://a.example/x", serving(() => new Response("gone", { status: 404 })), "answered 404"],
      ["https://a.example/x", serving(() => new Response("x", { headers: { "content-length": String(MAX_ARTIFACT_BYTES + 1) } })), `is larger than ${MAX_ARTIFACT_BYTES} bytes`],
      ["https://a.example/x", serving(() => new Response(big)), `is larger than ${MAX_ARTIFACT_BYTES} bytes`],
      ["https://a.example/x", serving(() => Promise.reject(new TypeError("fetch failed"))), "could not be fetched: fetch failed"],
    ] as const) {
      await expect(fetchDelivery(get, transport, await delivery(url, hash), 5), url).rejects.toThrow(new DeliveryUnfit(url, reason));
    }
    h.genesis = DEVNET_GENESIS_HASH;
    await expect(fetchDelivery(serving(() => new Response("x")), transport, await delivery("http://a.example/x", hash), 5)).rejects.toThrow(
      new DeliveryUnfit("http://a.example/x", PLAIN_HTTP_ON_PUBLIC),
    );
  });
});

describe("the process clock", () => {
  it("sleeps until its time is up, or stops early and says so when told to", async () => {
    const rt = nodeRuntime();
    expect(await rt.sleep(0.01)).toBe(true);
    const stopped = new AbortController();
    stopped.abort();
    expect(await rt.sleep(3_600, stopped.signal)).toBe(false);
    const later = new AbortController();
    const waiting = rt.sleep(3_600, later.signal);
    later.abort();
    expect(await waiting).toBe(false);
  });
});
