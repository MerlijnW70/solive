import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type Address, generateKeyPairSigner, lamports, none, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import { commitmentOf, type EngineTransaction, saltCheckOf, type Transport } from "@intent-engine/client";
import { tool } from "../src/agent/names.js";
import { refusalText } from "../src/agent/problems.js";
import { poll } from "../src/agent/wallet/wait.js";
import { notEarliest, WALLET_NOTICE } from "../src/agent/wallet.js";
import { escrowFor } from "../src/judge.js";
import { EXIT_OK, nodeRuntime } from "../src/main.js";
import { saltFor, sealedDelivery } from "./announce.js";
import { cli, creation, h, transport, world } from "./harness.js";

type Json = Record<string, unknown> & { [key: string]: any };

const URL_OF_WORK = "https://" + "example.org/work";
const URL_OF_COPY = "https://" + "example.org/copy";

const tooMany = () => new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers(), message: "Too Many Requests", statusCode: 429 });

const node = { limits: 0, after: [] as { sleeps: number; act: () => void }[] };

function throttling(inner: Transport): Transport {
  return Object.fromEntries(
    Object.entries(inner).map(([name, member]) => [
      name,
      typeof member !== "function"
        ? member
        : async (...args: unknown[]) => {
            for (let next = node.after[0]; next !== undefined && h.sleeps.length >= next.sleeps; next = node.after[0]) {
              node.after.shift();
              next.act();
            }
            if (node.limits > 0) {
              node.limits -= 1;
              throw tooMany();
            }
            return (member as (...a: unknown[]) => unknown).apply(inner, args);
          },
    ]),
  ) as unknown as Transport;
}

function preset(at: Address): void {
  const space = BigInt(getMintSize());
  h.svm.setAccount({
    address: at,
    data: Uint8Array.from(getMintEncoder().encode({ mintAuthority: none(), supply: 0n, decimals: 9, isInitialized: true, freezeAuthority: none() })),
    executable: false,
    lamports: lamports(h.svm.minimumBalanceForRentExemption(space)),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space,
  });
}

async function connect(): Promise<Client> {
  h.served.length = 0;
  h.through = throttling(transport);
  const started = await cli(["mcp", "--url", "devnet", "--wallet", "--all-tools"], {});
  expect([started.code, started.err]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
  const [near, far] = InMemoryTransport.createLinkedPair();
  await h.served[0]?.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

async function call(client: Client, name: string, args: object = {}) {
  const result = await client.callTool({ name: tool(name), arguments: args as Record<string, unknown> });
  const [content] = result.content as { type: string; text: string }[];
  return { error: result.isError === true, value: result.structuredContent as Json, text: content?.text ?? "" };
}

async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const { error, value } = await call(client, name, args);
  expect(error, JSON.stringify(value)).toBe(false);
  return value;
}

async function setUp() {
  await world();
  h.files.clear();
  preset(NATIVE_MINT);
  preset(DEVNET_TEST_MINT);
  node.limits = 0;
  node.after = [];
  const client = await connect();
  const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
  h.watched.push(wallet);
  h.engineLog = [];
  h.rounds = 10;
  const escrow = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: wallet, spec_hash: "6a".repeat(32), send: true });
  return { client, wallet, intent: escrow["intent"] as Address, nonce: escrow["nonce"] as string };
}

const announced = async (intent: Address, judge: Address, signature: string, slot: bigint, blockTime: bigint | null, url: string, worker: Address): Promise<EngineTransaction> => ({
  signature,
  slot,
  blockTime,
  failed: false,
  emitted: [],
  memos: [await sealedDelivery(intent, worker, "e5".repeat(32), url, [judge])],
  feePayer: worker,
});

afterEach(() => {
  node.limits = 0;
  node.after = [];
});

describe("the order of announcements", () => {
  it("lists the earlier of two announcements of the same work first, with both slots and block times, though the node returns the later first", async () => {
    const { client, wallet, intent, nonce } = await setUp();
    const worker = (await generateKeyPairSigner()).address;
    const copier = (await generateKeyPairSigner()).address;
    const work = "e5".repeat(32);
    h.engineLog = [
      await announced(intent, wallet, "later", 12n, 1_700_000_012n, URL_OF_COPY, copier),
      await announced(intent, wallet, "earlier", 11n, null, URL_OF_WORK, worker),
      creation(intent),
    ];
    const check = saltCheckOf(saltFor(intent));
    const listed = await ok(client, "wallet_check_delivery", { intent });
    expect(listed["deliveries"]).toEqual([
      { worker, commitment: commitmentOf(intent, worker, saltFor(intent), work), check, signature: "earlier", slot: "11", url: URL_OF_WORK },
      { worker: copier, commitment: commitmentOf(intent, copier, saltFor(intent), work), check, signature: "later", slot: "12", block_time: "1700000012", url: URL_OF_COPY },
    ]);
    const release = { owner: wallet, nonce, delivered_sha256: work };
    expect((await call(client, "wallet_attest", { ...release, pay_to: copier })).value).toMatchObject({ code: "NotEarliestAnnouncer", hint: notEarliest(worker, work) });
    expect(await ok(client, "wallet_attest", { ...release, pay_to: (listed["deliveries"] as Json[])[0]?.["worker"] })).toMatchObject({ sent: false });
  });

  it("orders announcements in the same slot by signature, as a release does", async () => {
    const { client, wallet, intent } = await setUp();
    const one = (await generateKeyPairSigner()).address;
    const two = (await generateKeyPairSigner()).address;
    h.engineLog = [await announced(intent, wallet, "b-second", 4n, null, URL_OF_WORK, two), await announced(intent, wallet, "a-first", 4n, null, URL_OF_WORK, one), creation(intent)];
    const listed = await ok(client, "check_delivery", { intent });
    expect((listed["deliveries"] as Json[]).map(({ signature, slot }) => [signature, slot])).toEqual([
      ["a-first", "4"],
      ["b-second", "4"],
    ]);
  });
});

describe("waiting for a new announcement", () => {
  it("returns as soon as an announcement newer than those already listed lands", async () => {
    const { client, wallet, intent } = await setUp();
    const worker = (await generateKeyPairSigner()).address;
    const first = await announced(intent, wallet, "first", 5n, null, URL_OF_WORK, worker);
    const second = await announced(intent, wallet, "second", 8n, null, URL_OF_COPY, worker);
    h.engineLog = [first, creation(intent)];
    node.after = [{ sleeps: 2, act: () => (h.engineLog = [second, first, creation(intent)]) }];
    const listed = await ok(client, "wallet_check_delivery", { intent, wait: 10 });
    expect((listed["deliveries"] as Json[]).map(({ signature }) => signature)).toEqual(["first", "second"]);
    expect(h.sleeps).toEqual([1, 1]);
  });

  it("returns the list when the time is up with nothing new, and refuses a wait out of bounds", async () => {
    const { client, wallet, intent } = await setUp();
    const worker = (await generateKeyPairSigner()).address;
    h.engineLog = [await announced(intent, wallet, "first", 5n, null, URL_OF_WORK, worker), creation(intent)];
    const listed = await ok(client, "wallet_check_delivery", { intent, wait: 3 });
    expect((listed["deliveries"] as Json[]).map(({ signature }) => signature)).toEqual(["first"]);
    expect(h.sleeps).toEqual([1, 1, 1]);
    for (const wait of [0, 41]) {
      expect((await call(client, "wallet_check_delivery", { intent, wait })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "wait" }] });
    }
  });
});

describe("waiting through rate limiting", () => {
  it("keeps waiting for a new announcement after the node rate-limits a read once", async () => {
    const { client, wallet, intent } = await setUp();
    const worker = (await generateKeyPairSigner()).address;
    const first = await announced(intent, wallet, "first", 5n, null, URL_OF_WORK, worker);
    const landed = await announced(intent, wallet, "landed", 9n, null, URL_OF_COPY, worker);
    h.engineLog = [first, creation(intent)];
    node.after = [
      { sleeps: 1, act: () => (node.limits = 1) },
      { sleeps: 2, act: () => (h.engineLog = [landed, first, creation(intent)]) },
    ];
    const listed = await ok(client, "wallet_check_delivery", { intent, wait: 10 });
    expect((listed["deliveries"] as Json[]).map(({ signature }) => signature)).toEqual(["first", "landed"]);
    expect([node.limits, h.sleeps]).toEqual([0, [1, 1]]);
  });

  it("returns a receipt when the wait runs out after the node rate-limits it once", async () => {
    const { client, wallet, nonce } = await setUp();
    node.limits = 1;
    const receipt = await ok(client, "wallet_receipt", { owner: wallet, nonce, wait: 2 });
    expect(receipt).toMatchObject({ intent: expect.any(String), released: false, next: expect.stringContaining("again with wait") });
    expect([node.limits, h.sleeps]).toEqual([0, [1, 1]]);
  });

  it("keeps the last answer when a later read is rate limited, and refuses only when no read was ever answered", async () => {
    const clock = { now: () => 0n, sleep: async () => true };
    let reads = 0;
    expect(
      await poll(clock, 3, async () => {
        reads += 1;
        if (reads === 2) {
          throw tooMany();
        }
        return reads === 3;
      }),
    ).toBe(2);
    await expect(poll(clock, 2, async () => Promise.reject(tooMany()))).rejects.toThrow("429");
    await expect(poll(clock, 2, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  });
});

describe("the text of an InvalidInput refusal", () => {
  it("names each wrong field and its message, while the structured content stays as it was", async () => {
    const { client, wallet, intent } = await setUp();
    const refused = await call(client, "wallet_attest", { intent, pay_to: wallet });
    expect(refused.error).toBe(true);
    expect(refused.value).toEqual({
      code: "InvalidInput",
      retryable: false,
      hint: "fix the listed fields and call again",
      issues: [
        { path: "intent", message: "is not a known field" },
        { path: "owner", message: "is required" },
        { path: "nonce", message: "is required" },
      ],
    });
    expect(refused.text).toBe("InvalidInput: fix the listed fields and call again; intent: is not a known field; owner: is required; nonce: is required");
    expect(refusalText({ code: "InvalidInput", retryable: false, hint: "fix", issues: [{ path: "a\u0007b", message: "is wrong" }, { path: "", message: "give one" }] })).toBe(
      "InvalidInput: fix; a b: is wrong; give one",
    );
  });
});

describe("the judge's reads on a rate-limiting node", () => {
  it("retries the first read of the judge after the node answers 429 once", async () => {
    const answered: string[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        const { id, method } = JSON.parse(body) as { id: unknown; method: string };
        answered.push(method);
        if (answered.length === 1) {
          response.writeHead(429, "Too Many Requests").end();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result: { context: { slot: 1 }, value: null } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const judged = nodeRuntime().transport("http://" + `127.0.0.1:${port}`);
      const judge = (await generateKeyPairSigner()).address;
      await expect(escrowFor(judged, judge, judge, 0n)).rejects.not.toThrow("429");
      expect(answered).toEqual(["getAccountInfo", "getAccountInfo"]);
    } finally {
      server.close();
    }
  }, 15_000);
});
