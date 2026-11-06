import { describe, expect, it } from "vitest";
import { IntentStatus } from "@intent-engine/core";
import { DEVNET_GENESIS_HASH } from "@intent-engine/client/internal";
import { MAX_ARTIFACT_BYTES } from "../src/artifact.js";
import { NOT_PUBLIC } from "../src/delivery-fetch.js";
import { EXIT_OK } from "../src/main.js";
import { h } from "./harness.js";
import { job, run, status, viperWatch } from "./watch-kit.js";

describe("judge --watch prints a delivery it could not fetch for good as refused, never as a fail", () => {
  const causes: readonly [string, (url: string) => void, string][] = [
    ["an answer of 404", (url) => h.specReplies.set(url, async () => new Response("gone", { status: 404 })), "answered 404"],
    ["a size over the artifact limit", (url) => h.specReplies.set(url, async () => new Response("x", { headers: { "content-length": String(MAX_ARTIFACT_BYTES + 1) } })), `is larger than ${MAX_ARTIFACT_BYTES} bytes`],
    ["a private address on a public cluster", (url) => {
      h.genesis = DEVNET_GENESIS_HASH;
      h.hosts.set(new URL(url).hostname, ["10.0.0.9"]);
    }, NOT_PUBLIC],
  ];

  it.each(causes)("%s", async (_name, arrange, reason) => {
    const j = await job();
    arrange(j.url);
    const watched = await run(viperWatch(j), { rounds: 4 });
    expect([watched.code, watched.err]).toEqual([EXIT_OK, ""]);
    expect(watched.lines).toEqual([
      expect.objectContaining({ url: j.url, artifactSha256: null, verdict: "refused", reason: `the work at ${j.url} ${reason}; it is not judged again` }),
      { stopped: "ended", intent: j.intent, judged: 0 },
    ]);
    expect(watched.lines[0]).not.toHaveProperty("retry");
    expect(status(j.intent)).toBe(IntentStatus.Open);
  }, 120_000);
});
