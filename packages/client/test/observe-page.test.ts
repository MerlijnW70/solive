import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { type Address, getBase58Decoder, type Signature, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attestedResult, DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import { type ClientEventName, type ClientHooks, createClient, type HookFailure, type RpcLike, rpcTransport } from "../src/index.js";
import { createTestWorld, type TestWorld } from "../src/testing.js";
import { OBSERVE_SECTION } from "./doc-sections.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const PAGE = readFileSync(`${ROOT}/docs/sdk-client.md`, "utf8");
const SECTION = OBSERVE_SECTION.exec(PAGE)?.[0] ?? "";
const BLOCKS = [...SECTION.matchAll(/^```ts\n([\s\S]*?)^```$/gm)].map((m) => m[1] ?? "");
const PRINTED = [.../\bprints ([^.]*)\./.exec(SECTION)?.[1]?.matchAll(/`([^`]+)`/g) ?? []].map((m) => m[1] ?? "");
const ENTRY = { "@intent-engine/client/testing": "../src/testing.js", "@intent-engine/client": "../src/index.js" };
const pageModule = fileURLToPath(new URL(`./.observe-page-${process.pid}.ts`, import.meta.url));
const NAMES: readonly ClientEventName[] = ["request", "response", "retry", "send", "confirm", "fetch"];
const NODE = "https://" + "rpc.example";

const CLAIMS = {
  pairs: "`request` and `response` fire for every RPC call with its `method`, an `id` the pair shares and the `attempt`; `response` adds the `ms` it took and, when it failed, the `error`.",
  retry: "`retry` fires each time the client retries a rate-limited or lagging call, with the `method`, the `attempt`, the `delay` and the `reason`.",
  send: "`send` fires when a transaction leaves the client, with its `signature`, `payer`, `instructions` count and `lastValidBlockHeight`; `confirm` fires when it confirms, fails or expires, with the `outcome`, the `slot` when known and the `ms` since `send`.",
  fetch: "`fetch` fires for every spec url the client fetches, with the url, the `status` and the `ms`.",
  throws: "A hook that throws or rejects changes nothing the client does; `hooks.error` receives each such error.",
  urls: "A url in a hook or log line shows only its scheme, host and port, and no event holds a key, a secret, a salt signature or a decrypted url.",
  debug: "`debug: true` writes one line per event to `console.debug`, and a function given as `debug` receives each line instead.",
  cli: "`createTestWorld` takes the same `hooks` and `debug`, and the CLI and MCP server take `--debug`, which writes the lines to stderr.",
};

type Seen = { kind: ClientEventName; event: Record<string, unknown> };

function recorder(): { seen: Seen[]; hooks: ClientHooks } {
  const seen: Seen[] = [];
  const hooks = Object.fromEntries(NAMES.map((kind) => [kind, (event: Record<string, unknown>) => void seen.push({ kind, event })])) as ClientHooks;
  return { seen, hooks };
}

async function transferred(world: TestWorld): Promise<Signature> {
  const [payer, to] = [await world.wallet(), await world.wallet()];
  return world.client.send([getTransferSolInstruction({ source: payer, destination: to.address, amount: 1_000n })], payer);
}

function lagging(errors: readonly Error[]): RpcLike {
  const left = [...errors];
  return {
    getAccountInfo: () => ({
      send: async () => {
        const error = left.shift();
        if (error !== undefined) {
          throw error;
        }
        return { value: null };
      },
    }),
  } as unknown as RpcLike;
}

const local = (code: string): string => Object.entries(ENTRY).reduce((text, [name, path]) => text.replaceAll(`"${name}"`, JSON.stringify(path)), code);

describe("the Observe section of the client page", () => {
  afterEach(() => {
    rmSync(pageModule, { force: true });
    vi.restoreAllMocks();
  });

  it("states exactly the claims these tests assert", () => {
    expect([...SECTION.matchAll(/^- (.+)$/gm)].map((m) => m[1])).toEqual(Object.values(CLAIMS));
  });

  it(CLAIMS.pairs, async () => {
    const { seen, hooks } = recorder();
    const client = createClient({ url: NODE, transport: rpcTransport(lagging([new Error("node down")]), async () => undefined), hooks });
    await expect(client.transport.getAccount(NODE as Address)).rejects.toThrow("node down");
    expect(seen).toEqual([
      { kind: "request", event: { id: 1, method: "getAccountInfo", attempt: 1 } },
      { kind: "response", event: { id: 1, method: "getAccountInfo", attempt: 1, ms: expect.any(Number), error: new Error("node down") } },
    ]);
  });

  it(CLAIMS.retry, async () => {
    const { seen, hooks } = recorder();
    const limited = new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers({ "Retry-After": "1" }), message: "Too Many Requests", statusCode: 429 });
    const behind = new Error("Minimum context slot has not been reached");
    const client = createClient({ url: NODE, transport: rpcTransport(lagging([limited, behind]), async () => undefined), hooks });
    expect(await client.transport.getAccount(NODE as Address)).toBeNull();
    expect(seen.filter(({ kind }) => kind === "retry").map(({ event }) => event)).toEqual([
      { method: "getAccountInfo", attempt: 1, delay: 1_000, reason: "rate-limited" },
      { method: "getAccountInfo", attempt: 2, delay: expect.any(Number), reason: "behind-min-slot" },
    ]);
  });

  it(CLAIMS.send, async () => {
    const { seen, hooks } = recorder();
    const world = await createTestWorld({ hooks });
    const signature = await transferred(world);
    const [sent, confirmed] = seen.filter(({ kind }) => kind === "send" || kind === "confirm");
    expect(sent).toMatchObject({ kind: "send", event: { signature, payer: expect.any(String), instructions: 2, lastValidBlockHeight: expect.any(BigInt) } });
    expect(confirmed).toMatchObject({ kind: "confirm", event: { signature, outcome: "confirmed", slot: expect.any(BigInt), ms: expect.any(Number) } });
  });

  it(CLAIMS.fetch, async () => {
    const heard: unknown[] = [];
    const world = await createTestWorld();
    const owner = await world.wallet();
    const specUrl = "https://" + "93.184.215.14/specs/one.md?rev=2";
    const specHash = new Uint8Array(createHash("sha256").update("spec").digest());
    const params = attestedResult({ amountIn: 1_000_000n, minResult: 1n, maxResult: 1n, attestor: owner.address, specHash, judgeFee: 0n });
    const { intent } = await world.client.createIntent({ signer: owner, inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT, params, specUrl });
    const client = createClient({ url: world.client.url, transport: world.transport, hooks: { fetch: (event) => void heard.push(event) }, fetch: async () => new Response("spec") });
    expect((await client.spec(intent))?.matches).toBe(true);
    expect(heard).toEqual([{ url: "https://93.184.215.14", status: 200, ms: expect.any(Number) }]);
  });

  it(CLAIMS.throws, async () => {
    const failures: HookFailure[] = [];
    const broken = Object.fromEntries(NAMES.map((kind) => [kind, () => Promise.reject(new Error(kind))])) as ClientHooks;
    const request = () => {
      throw new Error("request");
    };
    const world = await createTestWorld({ hooks: { ...broken, request, error: (failure) => void failures.push(failure) } });
    const signature = await transferred(world);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await world.client.status(signature)).toMatchObject({ status: "confirmed" });
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.every(({ hook, error }) => (error as Error).message === hook)).toBe(true);
  });

  it(CLAIMS.urls, async () => {
    const lines: string[] = [];
    const secretUrl = "https://" + "user:pass@node.example:8443/path?key=hidden";
    const client = createClient({ url: secretUrl, transport: rpcTransport(lagging([new Error(`refused ${secretUrl}`)]), async () => undefined), debug: (line) => void lines.push(line) });
    await expect(client.transport.getAccount(NODE as Address)).rejects.toThrow("refused");
    expect(lines.at(-1)).toMatch(/failed: Error: refused https:\/\/node\.example:8443$/);
    const world = await createTestWorld({ url: secretUrl, debug: (line) => void lines.push(line) });
    const [owner, judge, worker] = [await world.wallet(), await world.wallet(), await world.wallet()];
    const specHash = new Uint8Array(createHash("sha256").update("spec").digest());
    const params = attestedResult({ amountIn: 1_000_000n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash, judgeFee: 0n });
    const { intent } = await world.client.createIntent({ signer: owner, inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT, params });
    const sha256 = createHash("sha256").update("work").digest("hex");
    const workUrl = "https://" + "files.example/drop/work.tar?sig=w0rk";
    await world.client.announce({ worker, intent, sha256, url: workUrl });
    const first = await world.client.firstOpening({ intent, sha256, keypair: judge.keypair });
    expect(first.url).toBe(workUrl);
    await world.client.settleProof({ judge, intent, announcement: first.announcement, opening: first, result: 1n });
    const text = lines.join("\n");
    expect(text).toContain("confirm ");
    expect(text).not.toMatch(/user|pass|path|key=|hidden|drop|work\.tar|sig=|w0rk/);
    for (const { keypair } of [owner, judge, worker]) {
      expect(text).not.toContain(Buffer.from(keypair.slice(0, 32)).toString("hex"));
      expect(text).not.toContain(getBase58Decoder().decode(keypair.slice(0, 32)));
    }
  });

  it(CLAIMS.debug, async () => {
    const written: unknown[] = [];
    vi.spyOn(console, "debug").mockImplementation((line: unknown) => void written.push(line));
    const lines: string[] = [];
    const counted = recorder();
    const logged = await createTestWorld({ debug: true, hooks: counted.hooks });
    await transferred(logged);
    const given = await createTestWorld({ debug: (line) => void lines.push(line) });
    await transferred(given);
    expect(written).toHaveLength(counted.seen.length);
    expect(lines).toHaveLength(counted.seen.length);
  });

  it(CLAIMS.cli, async () => {
    const { seen, hooks } = recorder();
    const lines: string[] = [];
    await transferred(await createTestWorld({ hooks, debug: (line) => void lines.push(line) }));
    expect(seen.length).toBeGreaterThan(0);
    expect(lines).toHaveLength(seen.length);
  });

  it("runs the example, which counts RPC calls on a test world, and prints what it says", { timeout: 120_000 }, async () => {
    expect(BLOCKS).toHaveLength(1);
    const code = BLOCKS[0] ?? "";
    expect(code).toContain("createTestWorld({");
    const printed: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    });
    writeFileSync(pageModule, local(code));
    try {
      await import(pathToFileURL(pageModule).href);
    } finally {
      log.mockRestore();
    }
    expect(printed).toEqual(PRINTED);
    expect(PRINTED).toEqual(["send 7", "confirm confirmed", "true"]);
  });
});
