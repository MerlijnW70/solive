import {
  type Address,
  appendTransactionMessageInstructions,
  type Base64EncodedWireTransaction,
  type Blockhash,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SolanaError,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ClientEventName,
  type ClientHooks,
  createClient,
  type HookFailure,
  observedTransport,
  observerOf,
  QUIET,
  type RpcLike,
  rpcTransport,
  type Transport,
} from "../src/index.js";
import { createTestWorld, type TestWorld } from "../src/testing.js";

const NAMES: readonly ClientEventName[] = ["request", "response", "retry", "send", "confirm", "fetch"];
const NODE = "https://" + "rpc.example";
const BLOCKHASH = "11111111111111111111111111111111" as Blockhash;

type Seen = { kind: ClientEventName; event: Record<string, unknown> };

function recorder(): { seen: Seen[]; hooks: ClientHooks } {
  const seen: Seen[] = [];
  const hooks = Object.fromEntries(NAMES.map((kind) => [kind, (event: Record<string, unknown>) => void seen.push({ kind, event })])) as ClientHooks;
  return { seen, hooks };
}

const limited = (retryAfter: string) =>
  new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers({ "Retry-After": retryAfter }), message: "Too Many Requests", statusCode: 429 });

const signatureOfWire = (wire: Base64EncodedWireTransaction) => getSignatureFromTransaction(getTransactionDecoder().decode(getBase64Encoder().encode(wire)));

type Script = { status?: { err: unknown; confirmationStatus: string; slot?: bigint }; limited?: number; broken?: Error };

function node(script: Script = {}): { calls: string[]; rpc: RpcLike } {
  const calls: string[] = [];
  let limits = script.limited ?? 0;
  const answer = <T>(method: string, value: () => T) => ({
    send: async () => {
      calls.push(method);
      if (script.broken !== undefined) {
        throw script.broken;
      }
      if (limits > 0) {
        limits -= 1;
        throw limited("2");
      }
      return value();
    },
  });
  const rpc = {
    getLatestBlockhash: () => answer("getLatestBlockhash", () => ({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: 50n } })),
    sendTransaction: (wire: Base64EncodedWireTransaction) => answer("sendTransaction", () => signatureOfWire(wire)),
    getSignatureStatuses: () =>
      answer("getSignatureStatuses", () => ({ context: { slot: 9n }, value: [script.status ?? { err: null, confirmationStatus: "confirmed", slot: 7n }] })),
    getEpochInfo: () => answer("getEpochInfo", () => ({ blockHeight: 1n, absoluteSlot: 9n })),
    getTransaction: () => answer("getTransaction", () => null),
    getAccountInfo: () => answer("getAccountInfo", () => ({ value: null })),
  };
  return { calls, rpc: rpc as unknown as RpcLike };
}

const noWait = async () => undefined;

async function transfer(world: TestWorld) {
  const payer = await world.wallet();
  const to = await world.wallet();
  return { payer, instruction: getTransferSolInstruction({ source: payer, destination: to.address, amount: 1_000n }) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function pairsHold(seen: readonly Seen[]): void {
  const requests = seen.filter(({ kind }) => kind === "request").map(({ event }) => event);
  const responses = seen.filter(({ kind }) => kind === "response").map(({ event }) => event);
  expect(new Set(requests.map(({ id }) => id)).size).toBe(requests.length);
  expect(responses.map(({ id }) => id).sort()).toEqual(requests.map(({ id }) => id).sort());
  for (const response of responses) {
    const at = seen.findIndex(({ kind, event }) => kind === "response" && event === response);
    const asked = seen.findIndex(({ kind, event }) => kind === "request" && event["id"] === response["id"]);
    expect(asked).toBeLessThan(at);
    expect(seen[asked]?.event).toMatchObject({ method: response["method"], attempt: response["attempt"] });
    expect(typeof response["ms"]).toBe("number");
  }
}

describe("client hooks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hears request and response pairs, then the send, then its confirm, with matching ids and signatures, on a test world", async () => {
    const { seen, hooks } = recorder();
    const world = await createTestWorld({ hooks });
    const { payer, instruction } = await transfer(world);
    const signature = await world.client.send([instruction], payer);
    const kinds = seen.map(({ kind }) => kind);
    const sent = kinds.indexOf("send");
    const confirmed = kinds.indexOf("confirm");
    expect(kinds.filter((kind) => kind === "send")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "confirm")).toHaveLength(1);
    expect(seen.slice(0, sent).filter(({ kind }) => kind === "response").length).toBeGreaterThan(0);
    expect(confirmed).toBeGreaterThan(sent);
    pairsHold(seen);
    expect(seen[sent]?.event).toMatchObject({ signature, payer: payer.address, instructions: 2 });
    expect(typeof seen[sent]?.event["lastValidBlockHeight"]).toBe("bigint");
    expect(seen[confirmed]?.event).toMatchObject({ signature, outcome: "confirmed", slot: world.svm.getClock().slot });
    expect(seen[confirmed]?.event["ms"]).toBeGreaterThanOrEqual(0);
  });

  it("hears an rpc transport's calls by method, its send and its confirm with the slot the node gave", async () => {
    const { seen, hooks } = recorder();
    const { calls, rpc } = node();
    const client = createClient({ url: NODE, transport: rpcTransport(rpc, noWait), hooks });
    const payer = await generateKeyPairSigner();
    const signature = await client.transport.send([getTransferSolInstruction({ source: payer, destination: payer.address, amount: 1n })], payer);
    expect(seen.map(({ kind, event }) => `${kind} ${String(event["method"] ?? event["outcome"] ?? "")}`.trim())).toEqual([
      "request getLatestBlockhash",
      "response getLatestBlockhash",
      "send",
      "request sendTransaction",
      "response sendTransaction",
      "request getSignatureStatuses",
      "response getSignatureStatuses",
      "confirm confirmed",
    ]);
    expect(calls).toEqual(["getLatestBlockhash", "sendTransaction", "getSignatureStatuses"]);
    expect(seen[2]?.event).toEqual({ signature, payer: payer.address, instructions: 1, lastValidBlockHeight: 50n });
    expect(seen[7]?.event).toMatchObject({ signature, outcome: "confirmed", slot: 7n });
  });

  it("reports a transaction that failed on chain as failed, after reading why", async () => {
    const { seen, hooks } = recorder();
    const { rpc } = node({ status: { err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed" } });
    const client = createClient({ url: NODE, transport: rpcTransport(rpc, noWait), hooks });
    const payer = await generateKeyPairSigner();
    await expect(client.transport.send([getTransferSolInstruction({ source: payer, destination: payer.address, amount: 1n })], payer)).rejects.toMatchObject({
      code: "failed-on-chain",
    });
    expect(seen.some(({ kind, event }) => kind === "request" && event["method"] === "getTransaction")).toBe(true);
    expect(seen.at(-1)).toMatchObject({ kind: "confirm", event: { outcome: "failed" } });
  });

  it("reports a test world transaction whose blockhash expired as expired", async () => {
    const { seen, hooks } = recorder();
    const world = await createTestWorld({ hooks });
    const { payer, instruction } = await transfer(world);
    const latest = await world.client.transport.latestBlockhash();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
      (m) => appendTransactionMessageInstructions([instruction], m),
    );
    const wire = getBase64EncodedWireTransaction(await signTransactionMessageWithSigners(message));
    world.svm.expireBlockhash();
    await expect(world.client.transport.sendWire(wire, latest)).rejects.toMatchObject({ code: "blockhash-expired" });
    expect(seen.filter(({ kind }) => kind === "send" || kind === "confirm").map(({ kind, event }) => [kind, event["outcome"] ?? event["lastValidBlockHeight"]])).toEqual([
      ["send", latest.lastValidBlockHeight],
      ["confirm", "expired"],
    ]);
  });

  it("fires retry with its delay when a rate-limited call is retried, before the call succeeds", async () => {
    const { seen, hooks } = recorder();
    const waits: number[] = [];
    const { calls, rpc } = node({ limited: 1 });
    const client = createClient({ url: NODE, transport: rpcTransport(rpc, async (ms) => void waits.push(ms)), hooks });
    expect(await client.transport.getAccount(BLOCKHASH as string as Address)).toBeNull();
    expect(seen.map(({ kind }) => kind)).toEqual(["request", "response", "retry", "request", "response"]);
    expect(seen[0]?.event).toEqual({ id: 1, method: "getAccountInfo", attempt: 1 });
    expect(seen[1]?.event).toMatchObject({ id: 1, method: "getAccountInfo", attempt: 1, error: { context: { statusCode: 429 } } });
    expect(seen[2]?.event).toEqual({ method: "getAccountInfo", attempt: 1, delay: 2_000, reason: "rate-limited" });
    expect(seen[3]?.event).toEqual({ id: 2, method: "getAccountInfo", attempt: 2 });
    expect(seen[4]?.event).not.toHaveProperty("error");
    expect(waits).toEqual([2_000]);
    expect(calls).toEqual(["getAccountInfo", "getAccountInfo"]);
  });

  it("lands the same transaction when every hook throws or rejects, and hands each error to hooks.error", async () => {
    const thrown: unknown[] = [];
    const heard: HookFailure[] = [];
    const hooks = Object.fromEntries(
      NAMES.map((kind, i) => [
        kind,
        () => {
          const error = new Error(`${kind} hook broke`);
          thrown.push(error);
          if (i % 2 === 0) {
            throw error;
          }
          return Promise.reject(error);
        },
      ]),
    ) as ClientHooks;
    const world = await createTestWorld({
      hooks: {
        ...hooks,
        error: (failure) => {
          heard.push(failure);
          throw new Error("the error hook broke too");
        },
      },
    });
    const { payer, instruction } = await transfer(world);
    const signature = await world.client.send([instruction], payer);
    await settle();
    expect(await world.client.status(signature)).toMatchObject({ status: "confirmed" });
    expect(thrown.length).toBeGreaterThan(4);
    expect(heard).toHaveLength(thrown.length);
    expect(new Set(heard.map(({ error }) => error))).toEqual(new Set(thrown));
    for (const { hook, error } of heard) {
      expect((error as Error).message).toBe(`${hook} hook broke`);
    }
    expect(new Set(heard.map(({ hook }) => hook))).toEqual(new Set(["request", "response", "send", "confirm"]));
  });

  it("gives a debug writer that throws to hooks.error and goes on", async () => {
    const heard: HookFailure[] = [];
    const broke = new Error("the log is full");
    const world = await createTestWorld({
      debug: () => {
        throw broke;
      },
      hooks: { error: (failure) => void heard.push(failure) },
    });
    const { payer, instruction } = await transfer(world);
    await world.client.send([instruction], payer);
    expect(heard.length).toBeGreaterThan(0);
    expect(heard.every(({ hook, error }) => hook === "debug" && error === broke)).toBe(true);
  });

  it("writes one console.debug line per event with debug: true, and none by default", async () => {
    const lines: unknown[][] = [];
    const spied = vi.spyOn(console, "debug").mockImplementation((...args: unknown[]) => void lines.push(args));
    const quiet = await createTestWorld();
    const first = await transfer(quiet);
    await quiet.client.send([first.instruction], first.payer);
    expect(lines).toEqual([]);
    const { seen, hooks } = recorder();
    const world = await createTestWorld({ debug: true, hooks });
    const { payer, instruction } = await transfer(world);
    const signature = await world.client.send([instruction], payer);
    spied.mockRestore();
    expect(lines).toHaveLength(seen.length);
    expect(lines.every((args) => args.length === 1 && typeof args[0] === "string" && !args[0].includes("\n"))).toBe(true);
    const text = lines.map(([line]) => String(line));
    expect(text[0]).toBe("request #1 latestBlockhash attempt 1");
    expect(text).toContain(`send ${signature} payer ${payer.address} instructions 2 lastValidBlockHeight ${String(seen.find(({ kind }) => kind === "send")?.event["lastValidBlockHeight"])}`);
    expect(text.some((line) => line.startsWith(`confirm ${signature} confirmed slot `))).toBe(true);
  });

  it("hands a debug function the same lines, and shows only the origin of a url inside an error", async () => {
    const lines: string[] = [];
    const { rpc } = node({ broken: new Error("refused by " + "https://" + "user:pass@rpc.example:8443/secret/path?key=1") });
    const client = createClient({ url: NODE, transport: rpcTransport(rpc, noWait), debug: (line) => void lines.push(line) });
    await expect(client.transport.getAccount(BLOCKHASH as string as Address)).rejects.toThrow("refused");
    expect(lines).toEqual([
      "request #1 getAccountInfo attempt 1",
      expect.stringMatching(/^response #1 getAccountInfo attempt 1 \d+ms failed: Error: refused by https:\/\/rpc\.example:8443$/),
    ]);
  });

  it("makes the same calls in the same order with and without hooks, and keeps a given transport as it is when none are given", async () => {
    const quiet = node();
    const heard = node();
    const payer = await generateKeyPairSigner();
    const ix = getTransferSolInstruction({ source: payer, destination: payer.address, amount: 1n });
    const transport = rpcTransport(quiet.rpc, noWait);
    expect(createClient({ url: NODE, transport }).transport).toBe(transport);
    expect(createClient({ url: NODE, transport, hooks: {} }).transport).toBe(transport);
    expect(observerOf()).toBe(QUIET);
    await createClient({ url: NODE, transport }).transport.send([ix], payer);
    await createClient({ url: NODE, transport: rpcTransport(heard.rpc, noWait), hooks: recorder().hooks }).transport.send([ix], payer);
    expect(heard.calls).toEqual(quiet.calls);
    expect(quiet.calls.length).toBeGreaterThan(2);
  });

  it("observes a transport of the app's own by its members, and adds a client's hooks to a transport observed already", async () => {
    const { seen, hooks } = recorder();
    const own: Transport = { ...rpcTransport(node().rpc, noWait) };
    await createClient({ url: NODE, transport: own, hooks }).transport.getAccount(BLOCKHASH as string as Address);
    expect(seen.map(({ kind, event }) => `${kind} ${String(event["method"])}`)).toEqual(["request getAccount", "response getAccount"]);
    const lines: string[] = [];
    const logged = observedTransport(rpcTransport(node().rpc, noWait), observerOf({}, (line) => void lines.push(line)));
    const both = recorder();
    await createClient({ url: NODE, transport: logged, hooks: both.hooks }).transport.getAccount(BLOCKHASH as string as Address);
    expect(lines).toHaveLength(2);
    expect(both.seen.map(({ kind, event }) => `${kind} ${String(event["method"])}`)).toEqual(["request getAccountInfo", "response getAccountInfo"]);
  });
});
