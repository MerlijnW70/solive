import { createHash } from "node:crypto";
import { createSignableMessage, getBase58Decoder } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { attestedResult, DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import { saltMessage } from "@intent-engine/core/internal";
import type { ClientEventName, ClientHooks } from "../src/index.js";
import { type CheckedFetch, errorText, redactUrl, redactUrls, UNPARSEABLE_URL } from "../src/internal.js";
import { createClient } from "../src/node.js";
import { createTestWorld, type TestWorld } from "../src/testing.js";

vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "93.184.215.14", family: 4 }] }));

const NAMES: readonly ClientEventName[] = ["request", "response", "retry", "send", "confirm", "fetch"];
const RPC_URL = "https://" + "reader:hunter2@rpc.example.net:8443/v1/node?api-key=k3y";
const WORK_PATH = "/deliveries/a1b2c3/work.tar";
const WORK_QUERY = "?token=t0ken";
const WORK_URL = "https://" + "files.example.org" + WORK_PATH + WORK_QUERY;
const SPEC_TEXT = "the observed spec\n";
const SPEC_URL = "https://" + "specs.example.org/jobs/observed.md?rev=r9";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const shown = (value: unknown): string =>
  JSON.stringify(value, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v instanceof Error ? errorText(v) : v));

function capture(): { output: string[]; hooks: ClientHooks; debug: (line: string) => void } {
  const output: string[] = [];
  const hooks = Object.fromEntries(NAMES.map((kind) => [kind, (event: unknown) => void output.push(`${kind} ${shown(event)}`)])) as ClientHooks;
  return { output, hooks, debug: (line) => void output.push(line) };
}

const forms = (bytes: Uint8Array): string[] => [
  Buffer.from(bytes).toString("hex"),
  Buffer.from(bytes).toString("base64"),
  Buffer.from(bytes).toString("base64url"),
  getBase58Decoder().decode(bytes),
  Array.from(bytes).join(","),
];

async function job(world: TestWorld, specUrl?: string) {
  const [owner, judge] = [await world.wallet(), await world.wallet()];
  const specHash = new Uint8Array(createHash("sha256").update(SPEC_TEXT).digest());
  const params = attestedResult({ amountIn: 1_000_000n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash, judgeFee: 0n });
  const made = await world.client.createIntent({ signer: owner, inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT, params, ...(specUrl === undefined ? {} : { specUrl }) });
  return { judge, intent: made.intent };
}

describe("what hooks and the debug log show", () => {
  it("shows a url as scheme, host and port only, the rule the multisig CLI applies to --url", () => {
    expect(redactUrl(RPC_URL)).toBe("https://rpc.example.net:8443");
    expect(redactUrl(WORK_URL)).toBe("https://files.example.org");
    expect(redactUrl("not a url")).toBe(UNPARSEABLE_URL);
    expect(redactUrls(`node ${RPC_URL} and ${WORK_URL} refused`)).toBe("node https://rpc.example.net:8443 and https://files.example.org refused");
    expect(errorText(new TypeError(`fetch ${WORK_URL}\nfailed`))).toBe("TypeError: fetch https://files.example.org failed");
  });

  it("keeps the worker's secret, the salt signature, the url's path, query and credentials and the decrypted work url out of an announce and a release", async () => {
    const { output, hooks, debug } = capture();
    const world = await createTestWorld({ url: RPC_URL, hooks, debug });
    const sha256 = sha("observed work");
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const first = await job(world);
    const worker = await world.wallet();
    await world.client.announce({ worker, secret, intent: first.intent, sha256, url: WORK_URL });
    const opened = await world.client.firstOpening({ intent: first.intent, sha256, keypair: first.judge.keypair });
    expect(opened.url).toBe(WORK_URL);
    await world.client.settleProof({ judge: first.judge, intent: first.intent, announcement: opened.announcement, opening: opened, result: 1n });
    const second = await job(world);
    const signing = await world.wallet();
    const [signed] = await signing.signMessages([createSignableMessage(saltMessage(second.intent, sha256))]);
    const saltSignature = Uint8Array.from(signed?.[signing.address] ?? []);
    expect(saltSignature).toHaveLength(64);
    await world.client.announce({ worker: signing, intent: second.intent, sha256, url: WORK_URL });
    const released = await world.client.firstOpening({ intent: second.intent, sha256, keypair: second.judge.keypair });
    expect(released.url).toBe(WORK_URL);
    await world.client.settleProof({ judge: second.judge, intent: second.intent, announcement: released.announcement, opening: released, result: 1n });
    expect(output.filter((line) => line.startsWith("confirm ")).length).toBeGreaterThanOrEqual(8);
    const forbidden = [
      ...forms(secret),
      ...forms(saltSignature),
      ...[worker, signing, first.judge, second.judge].flatMap(({ keypair }) => forms(keypair.slice(0, 32))),
      "reader",
      "hunter2",
      "/v1/node",
      "api-key",
      "k3y",
      WORK_URL,
      WORK_PATH,
      WORK_QUERY,
      "t0ken",
    ];
    const text = output.join("\n");
    for (const needle of forbidden) {
      expect(text.includes(needle), needle).toBe(false);
    }
  });

  it("fires fetch for a spec url with only its origin, the status and the duration, also when the fetch fails", async () => {
    const asked: string[] = [];
    let answer: () => Promise<Response> = async () => new Response(SPEC_TEXT);
    const fetching: CheckedFetch = async (url) => {
      asked.push(url);
      return answer();
    };
    const lines: string[] = [];
    const heard: unknown[] = [];
    const world = await createTestWorld();
    const posted = await job(world, SPEC_URL);
    const hooks = { fetch: (event: unknown) => void heard.push(event) };
    const client = createClient({ url: world.client.url, transport: world.transport, fetch: fetching, hooks, debug: (line) => void lines.push(line) });
    expect((await client.spec(posted.intent))?.matches).toBe(true);
    answer = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(client.spec(posted.intent)).rejects.toMatchObject({ name: "SpecUnreadable" });
    expect(asked).toEqual([SPEC_URL, SPEC_URL]);
    expect(heard).toEqual([
      { url: "https://specs.example.org", status: 200, ms: expect.any(Number) },
      { url: "https://specs.example.org", status: null, ms: expect.any(Number) },
    ]);
    expect(lines.filter((line) => line.startsWith("fetch "))).toEqual([
      expect.stringMatching(/^fetch https:\/\/specs\.example\.org 200 \d+ms$/),
      expect.stringMatching(/^fetch https:\/\/specs\.example\.org no response \d+ms$/),
    ]);
    expect(lines.join("\n")).not.toMatch(/observed\.md|rev=r9/);
  });
});
