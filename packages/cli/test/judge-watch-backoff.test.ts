import { describe, expect, it } from "vitest";
import { IntentStatus } from "@intent-engine/core";
import { type Lookup, type Transport } from "@intent-engine/client";
import { DEVNET_GENESIS_HASH } from "@intent-engine/client/internal";
import { DeliveryUnfit, DeliveryUnreadable, fetchBytes, fetchDelivery, NOT_PUBLIC, UNRESOLVED } from "../src/delivery-fetch.js";
import { lastingSpecFailure, SPEC_NOT_PUBLIC } from "../src/fetch-failure.js";
import { unreadableSkipped } from "../src/judge-errors.js";
import { UNREADABLE_TRIES } from "../src/judge-watch.js";
import { EXIT_OK } from "../src/main.js";
import { h, transport, world } from "./harness.js";
import { CORRECT, job, quietly, run, sha, SPEC_URL, status, viperWatch } from "./watch-kit.js";

const BACKOFF_ROUNDS = [0, 1, 3, 7, 15, 31];

const GENERATOR = "export default function generate(seed, count) { const out = []; for (let i = 0; i < count; i += 1) { out.push([seed.slice(i, i + 3)]); } return out; }";
const CHECKER = "export default (args, answer) => { const words = args[0].match(/\\S+/g); return answer === (words === null ? 0 : words.length); };";
const DRAW_SPEC = `# Count words\n\n\`\`\`judge-cases\n${JSON.stringify({ cases: [{ args: [""], expected: 0 }, { args: ["one two"], expected: 2 }], draw: { count: 4, generator: GENERATOR, checker: CHECKER, k: 3 } })}\n\`\`\`\n`;

describe("judge --watch backs off from hosts that keep failing", () => {
  it("fetches work that keeps answering 503 on rounds further apart each time, then reports it and stops fetching it", async () => {
    const j = await job();
    h.specReplies.set(j.url, async () => new Response("busy", { status: 503 }));
    const watched = await run(viperWatch(j), { rounds: 40 });
    const reason = `the work at ${j.url} answered 503; it is fetched again later`;
    expect([watched.code, watched.err]).toEqual([EXIT_OK, ""]);
    expect(watched.roundsOf(j.url)).toEqual(BACKOFF_ROUNDS);
    expect(watched.lines).toEqual([
      expect.objectContaining({ url: j.url, artifactSha256: null, verdict: "retry", retry: true, reason }),
      expect.objectContaining({ url: j.url, artifactSha256: null, verdict: "skipped", reason: unreadableSkipped(UNREADABLE_TRIES, reason) }),
      { stopped: "ended", intent: j.intent, judged: 0 },
    ]);
    expect(UNREADABLE_TRIES).toBe(BACKOFF_ROUNDS.length);
    expect(status(j.intent)).toBe(IntentStatus.Open);
  }, 120_000);

  it("downloads the work again only on the same growing rounds while its spec url stays unreadable, then reports it", async () => {
    const j = await job({ specUrl: SPEC_URL });
    h.specReplies.set(SPEC_URL, async () => {
      throw new TypeError("fetch failed");
    });
    const watched = await run(viperWatch(j), { rounds: 40 });
    expect([watched.code, watched.err]).toEqual([EXIT_OK, ""]);
    expect(watched.roundsOf(j.url)).toEqual(BACKOFF_ROUNDS);
    expect(watched.lines).toEqual([
      expect.objectContaining({ artifactSha256: sha(CORRECT), verdict: "retry", retry: true, reason: expect.stringContaining(`who the job ${j.intent} invites cannot be checked`) }),
      expect.objectContaining({ artifactSha256: sha(CORRECT), verdict: "skipped", reason: expect.stringContaining(`could not be read ${UNREADABLE_TRIES} times`) }),
      { stopped: "ended", intent: j.intent, judged: 0 },
    ]);
  }, 120_000);

  it("fails at once, and never downloads the work again, when the spec url answers 404 or names a private address", async () => {
    const gone = await job({ specUrl: SPEC_URL });
    h.specReplies.set(SPEC_URL, async () => new Response("gone", { status: 404 }));
    const missing = await run(viperWatch(gone), { rounds: 5 });
    expect(missing.roundsOf(gone.url)).toEqual([0]);
    expect(missing.roundsOf(SPEC_URL)).toEqual([0]);
    expect(missing.lines).toEqual([
      expect.objectContaining({ artifactSha256: sha(CORRECT), verdict: "fail", reason: expect.stringContaining(`${SPEC_URL} answered 404`) }),
      { stopped: "ended", intent: gone.intent, judged: 1 },
    ]);
    const inside = await job({ specUrl: SPEC_URL });
    h.genesis = DEVNET_GENESIS_HASH;
    h.hosts.set(new URL(SPEC_URL).hostname, ["10.0.0.9"]);
    const private_ = await run(viperWatch(inside), { rounds: 5 });
    expect(private_.roundsOf(inside.url)).toEqual([0]);
    expect(private_.roundsOf(SPEC_URL)).toEqual([]);
    expect(private_.lines).toEqual([expect.objectContaining({ verdict: "fail", reason: expect.stringContaining(SPEC_NOT_PUBLIC) }), { stopped: "ended", intent: inside.intent, judged: 1 }]);
  }, 120_000);

  it("keeps a spec host that does not resolve temporary", async () => {
    const j = await job({ specUrl: SPEC_URL });
    h.genesis = DEVNET_GENESIS_HASH;
    h.hosts.set(new URL(SPEC_URL).hostname, []);
    const watched = await run(viperWatch(j), { rounds: 3 });
    expect(watched.roundsOf(j.url)).toEqual([0, 1]);
    expect(watched.lines).toEqual([expect.objectContaining({ verdict: "retry", retry: true, reason: expect.stringContaining(SPEC_NOT_PUBLIC) }), { stopped: "ended", intent: j.intent, judged: 0 }]);
  }, 120_000);
});

describe("judge --watch on Ctrl-C while it waits for a beacon block", () => {
  it("stops the wait at once and sends nothing", async () => {
    await quietly(async () => {
      const j = await job({ specText: DRAW_SPEC });
      h.through = { ...transport, finalizedBlock: async () => null } as Transport;
      const watched = await run(viperWatch(j), {
        rounds: 50,
        asleep: (slept) => {
          if (slept === 1) {
            process.emit("SIGINT", "SIGINT");
          }
        },
      });
      expect(watched.code).toBe(130);
      expect(watched.slept).toBe(1);
      expect(watched.lines).toEqual([{ stopped: "SIGINT", intent: j.intent, judged: 0 }]);
      expect(status(j.intent)).toBe(IntentStatus.Open);
    });
  }, 120_000);
});

describe("a host name that does not resolve", () => {
  it("is temporary for work, while one that resolves to a private address stays final", async () => {
    await world();
    h.genesis = DEVNET_GENESIS_HASH;
    const url = "https://" + "work.example.org/x";
    const delivery = { announcement: { address: url, intent: url, worker: url, commitment: new Uint8Array(32) } as never, salt: "00".repeat(16), url };
    const get = async () => new Response(CORRECT);
    const failing: Lookup = async () => {
      throw new Error("getaddrinfo EAI_AGAIN work.example.org");
    };
    const empty: Lookup = async () => [];
    const inside: Lookup = async () => ["10.0.0.9"];
    for (const lookup of [failing, empty]) {
      expect(await fetchBytes(get, transport, url, lookup)).toStrictEqual({ problem: UNRESOLVED, temporary: true });
      await expect(fetchDelivery(get, transport, delivery, 5, lookup)).rejects.toThrow(new DeliveryUnreadable(url, UNRESOLVED));
    }
    expect(await fetchBytes(get, transport, url, inside)).toStrictEqual({ problem: NOT_PUBLIC });
    await expect(fetchDelivery(get, transport, delivery, 5, inside)).rejects.toBeInstanceOf(DeliveryUnfit);
  });

  it("is temporary for a spec url, and only a resolved private address, a 4xx or a fixed refusal is final", async () => {
    const at = (url: string, reason: string) => `the spec at ${url} ${reason}`;
    const url = "https://" + "specs.example.org/s.md";
    const failing: Lookup = async () => {
      throw new Error("ENOTFOUND");
    };
    const inside: Lookup = async () => ["192.168.1.4"];
    const outside: Lookup = async () => ["93.184.216.34"];
    const cases: [string, Lookup, boolean][] = [
      [at(url, SPEC_NOT_PUBLIC), inside, true],
      [at(url, SPEC_NOT_PUBLIC), failing, false],
      [at(url, SPEC_NOT_PUBLIC), outside, false],
      [at(url, "answered 404"), failing, true],
      [at(url, "answered 503"), failing, false],
      [at(url, "answered 429"), failing, false],
      [at(url, "is not a url"), failing, true],
      [at(`${url}?answered 404`, "could not be fetched (fetch failed)"), failing, false],
      [at(`${url}?is not a url`, "could not be fetched (fetch failed)"), failing, false],
      ["its spec url could not be fetched (boom)", failing, false],
    ];
    for (const [message, lookup, lasting] of cases) {
      expect(await lastingSpecFailure(message, lookup), message).toBe(lasting);
    }
  });
});
