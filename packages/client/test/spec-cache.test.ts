import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type Address, getBase58Decoder } from "@solana/kit";
import { afterEach, describe, expect, it } from "vitest";
import { seal, specMemo } from "@intent-engine/core/internal";
import { createClient, SpecSealed, type SpecSource, type Transport } from "../src/index.js";
import { createClient as nodeClient, pinnedFetch } from "../src/node.js";
import { testWallet } from "../src/testing.js";
import { type CheckedFetch, MEMO_FIRST, readSpec, SPEC_CACHE_BYTES, SPEC_CACHE_ENTRIES, SpecCache, type SpecFetch } from "../src/internal.js";
import { createdEvent, engineView, intentBytes, key, OWNER, proofIntent, tx } from "./kill-client-jobs-ledger-kit.js";

const INTENT = key(92);
const SPEC = "a spec read once\n";
const MEMO_URL = "https://" + "specs.example/once.md";
const MIRROR = "https://" + "mirror.example";
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const HASH = sha(SPEC);

function chain(memoUrl: string | null): Transport {
  const account = engineView(intentBytes(proofIntent({}, { specHash: Uint8Array.from(Buffer.from(HASH, "hex")) })));
  return {
    getAccount: async (address: Address) => (address === INTENT ? account : null),
    engineTransactions: async () => [tx("made", { emitted: [createdEvent(INTENT, OWNER)], memos: memoUrl === null ? [] : [specMemo(memoUrl)], memoSigners: [[OWNER]] })],
    genesisHash: async () => getBase58Decoder().decode(new Uint8Array(32).fill(7)),
  } as unknown as Transport;
}

const counting = (pages: Record<string, string>, asked: string[]): SpecFetch => async (url) => {
  asked.push(url);
  const page = pages[url];
  return page === undefined ? new Response("missing", { status: 404 }) : new Response(page);
};

describe("the spec cache", () => {
  it("serves a second read of a verified spec without a request", async () => {
    const asked: string[] = [];
    const mirrored = MIRROR + "/sha256/" + HASH;
    const client = createClient({ url: "http://" + "127.0.0.1:8899", transport: chain(null), fetch: counting({ [mirrored]: SPEC }, asked), specSources: [{ kind: "memo" }, { kind: "mirror", base: MIRROR }] });
    expect(await client.spec(INTENT)).toMatchObject({ url: mirrored, text: SPEC, matches: true, source: "mirror" });
    expect(asked).toStrictEqual([mirrored]);
    expect(await client.spec(INTENT)).toMatchObject({ url: mirrored, text: SPEC, matches: true, source: "cache", tried: [] });
    expect(asked).toStrictEqual([mirrored]);
  });

  it("keeps a memo spec only when it matches, and serves it again without a request", async () => {
    const asked: string[] = [];
    const cache = new SpecCache();
    const get = counting({ [MEMO_URL]: "an edited spec" }, asked);
    const sources = [{ kind: "memo" }] as const;
    expect(await readSpec(chain(MEMO_URL), get, INTENT, undefined, null, undefined, { sources, cache })).toMatchObject({ matches: false });
    expect(cache.size).toBe(0);
    const good = counting({ [MEMO_URL]: SPEC }, asked);
    await readSpec(chain(MEMO_URL), good, INTENT, undefined, null, undefined, { sources, cache });
    asked.length = 0;
    expect(await readSpec(chain(MEMO_URL), good, INTENT, undefined, null, undefined, { sources, cache })).toMatchObject({ url: MEMO_URL, source: "cache", matches: true });
    expect(asked).toStrictEqual([]);
  });

  it("is bounded in entries and bytes, dropping the least recently used", () => {
    expect([SPEC_CACHE_ENTRIES, SPEC_CACHE_BYTES]).toStrictEqual([64, 8 * 1_048_576]);
    const cache = new SpecCache(2, 10);
    cache.put("a", "u", new Uint8Array(4));
    cache.put("b", "u", new Uint8Array(4));
    expect(cache.get("a")?.bytes.length).toBe(4);
    cache.put("c", "u", new Uint8Array(1));
    expect([cache.get("a") !== undefined, cache.get("b") !== undefined, cache.get("c") !== undefined]).toStrictEqual([true, false, true]);
    cache.put("d", "u", new Uint8Array(9));
    expect([cache.size, cache.bytes, cache.get("c") !== undefined, cache.get("d")?.bytes.length]).toStrictEqual([2, 10, true, 9]);
    cache.put("e", "u", new Uint8Array(11));
    expect([cache.get("e"), cache.size]).toStrictEqual([undefined, 2]);
    cache.put("d", "v", new Uint8Array(2));
    expect([cache.size, cache.bytes, cache.get("d")?.url]).toStrictEqual([2, 3, "v"]);
    const none = new SpecCache(0);
    none.put("a", "u", new Uint8Array(1));
    expect(none.size).toBe(0);
  });

  it("hands out copies, so a caller cannot change what it serves", () => {
    const cache = new SpecCache();
    const bytes = new TextEncoder().encode(SPEC);
    cache.put(HASH, MEMO_URL, bytes);
    bytes.fill(0);
    const first = cache.get(HASH);
    first?.bytes.fill(0);
    expect(new TextDecoder().decode(cache.get(HASH)?.bytes)).toBe(SPEC);
  });
});

describe("the pinned fetch of a hash source", () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise((done) => (server === undefined ? done(undefined) : server.close(done)));
    server = undefined;
  });

  const listening = async (answer: (request: IncomingMessage, body: string) => [number, Record<string, string>, string]) => {
    const heard: { method: string | undefined; body: string; type: string | undefined; accept: string | undefined }[] = [];
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        heard.push({ method: request.method, body, type: request.headers["content-type"], accept: request.headers["accept"] });
        const [status, headers, text] = answer(request, body);
        response.writeHead(status, headers).end(text);
      });
    });
    await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
    return { base: "http://" + "127.0.0.1:" + String((server?.address() as AddressInfo).port), heard };
  };

  it("sends the POST, its body and its headers to the checked address", async () => {
    const { base, heard } = await listening(() => [200, {}, "answered"]);
    const response = await pinnedFetch(base + "/graphql", { redirect: "error", signal: AbortSignal.timeout(5_000), addresses: ["127.0.0.1"], method: "POST", headers: { "content-type": "application/json" }, body: '{"q":1}' });
    expect(await response.text()).toBe("answered");
    const plain = await pinnedFetch(base + "/raw", { redirect: "error", signal: AbortSignal.timeout(5_000), addresses: ["127.0.0.1"], headers: { accept: "application/vnd.ipld.raw" } });
    expect(await plain.text()).toBe("answered");
    expect(heard).toStrictEqual([
      { method: "POST", body: '{"q":1}', type: "application/json", accept: undefined },
      { method: "GET", body: "", type: undefined, accept: "application/vnd.ipld.raw" },
    ]);
  });

  it("still refuses a redirect for a POST", async () => {
    const { base } = await listening(() => [301, { location: "/elsewhere" }, ""]);
    await expect(pinnedFetch(base + "/graphql", { redirect: "error", signal: AbortSignal.timeout(5_000), addresses: ["127.0.0.1"], method: "POST", body: "{}" })).rejects.toMatchObject({ name: "FetchFailed", reason: "redirect" });
  });
});

describe("two escrows that share one spec hash", () => {
  const OPEN = key(93);
  const SEALED = key(94);
  const SEALED_URL = "https://" + "specs.example/sealed.md";

  function pair(): Transport {
    const account = engineView(intentBytes(proofIntent({}, { specHash: Uint8Array.from(Buffer.from(HASH, "hex")) })));
    const urls = new Map<Address, string>([
      [OPEN, MEMO_URL],
      [SEALED, SEALED_URL],
    ]);
    return {
      getAccount: async (address: Address) => (urls.has(address) ? account : null),
      engineTransactions: async (_limit: number, of?: Address) =>
        of === undefined || !urls.has(of) ? [] : [tx("made " + of, { emitted: [createdEvent(of, OWNER)], memos: [specMemo(urls.get(of) ?? "")], memoSigners: [[OWNER]] })],
      genesisHash: async () => getBase58Decoder().decode(new Uint8Array(32).fill(7)),
    } as unknown as Transport;
  }

  it("never serve the open one's cached plaintext for the sealed one", async () => {
    const [worker, outsider] = [await testWallet(), await testWallet()];
    const sealed = await seal(new TextEncoder().encode(SPEC), [worker.address]);
    const asked: string[] = [];
    const get: SpecFetch = async (url) => {
      asked.push(url);
      return url === MEMO_URL ? new Response(SPEC) : url === SEALED_URL ? new Response(Uint8Array.from(sealed)) : new Response("missing", { status: 404 });
    };
    const client = createClient({ url: "http://" + "127.0.0.1:8899", transport: pair(), fetch: get });
    expect(await client.spec(OPEN)).toMatchObject({ url: MEMO_URL, source: "memo", matches: true });
    expect(await client.spec(OPEN)).toMatchObject({ url: MEMO_URL, source: "cache" });
    await expect(client.spec(SEALED)).rejects.toBeInstanceOf(SpecSealed);
    await expect(client.spec(SEALED, outsider.keypair)).rejects.toMatchObject({ name: "SpecSealed", keyed: true });
    expect(await client.spec(SEALED, worker.keypair)).toMatchObject({ url: SEALED_URL, source: "memo", sealedTo: [worker.address], matches: true });
    expect(asked.filter((url) => url === SEALED_URL)).toHaveLength(3);
  });
});

describe("a copy from a hash source after the memo url failed", () => {
  it("is not kept, so a memo url that comes back sealed is refused on the next read", async () => {
    const worker = await testWallet();
    const sealed = await seal(new TextEncoder().encode(SPEC), [worker.address]);
    const mirrored = MIRROR + "/sha256/" + HASH;
    let back = false;
    const asked: string[] = [];
    const get: SpecFetch = async (url) => {
      asked.push(url);
      if (url === MEMO_URL) {
        return back ? new Response(Uint8Array.from(sealed)) : new Response("gone", { status: 404 });
      }
      return url === mirrored ? new Response(SPEC) : new Response("missing", { status: 404 });
    };
    const client = createClient({ url: "http://" + "127.0.0.1:8899", transport: chain(MEMO_URL), fetch: get, specSources: [{ kind: "memo" }, { kind: "mirror", base: MIRROR }] });
    expect(await client.spec(INTENT)).toMatchObject({ url: mirrored, source: "mirror", matches: true });
    back = true;
    await expect(client.spec(INTENT)).rejects.toBeInstanceOf(SpecSealed);
    expect(await client.spec(INTENT, worker.keypair)).toMatchObject({ url: MEMO_URL, source: "memo", sealedTo: [worker.address] });
    expect(asked).toStrictEqual([MEMO_URL, mirrored, MEMO_URL, MEMO_URL]);
  });
});

describe("the Node entry's checked fetch", () => {
  it("carries the Arweave POST, its body and its headers to a fetch you pass", async () => {
    const ARWEAVE = "https://" + "arweave.example";
    const id = "A".repeat(42) + "b";
    const heard: { url: string; method: string | undefined; body: string | undefined; headers: unknown; addresses: readonly string[] }[] = [];
    const checked: CheckedFetch = async (url, init) => {
      heard.push({ url, method: init.method, body: init.body, headers: init.headers, addresses: init.addresses });
      return url.endsWith("/graphql") ? new Response(JSON.stringify({ data: { transactions: { edges: [{ node: { id } }] } } })) : new Response(SPEC);
    };
    const client = nodeClient({ url: "http://" + "127.0.0.1:8899", transport: chain(null), fetch: checked, lookup: async () => ["93.184.215.14"], specSources: [{ kind: "memo" }, { kind: "arweave", gateway: ARWEAVE }] });
    expect(await client.spec(INTENT)).toMatchObject({ url: ARWEAVE + "/raw/" + id, source: "arweave", matches: true });
    expect(heard).toStrictEqual([
      { url: ARWEAVE + "/graphql", method: "POST", body: expect.stringContaining(HASH), headers: { "content-type": "application/json" }, addresses: ["93.184.215.14"] },
      { url: ARWEAVE + "/raw/" + id, method: undefined, body: undefined, headers: undefined, addresses: ["93.184.215.14"] },
    ]);
  });
});

describe("a list of spec sources", () => {
  it("is refused unless the memo url comes first", async () => {
    const asked: string[] = [];
    const get = counting({}, asked);
    for (const sources of [[], [{ kind: "mirror", base: MIRROR }], [{ kind: "mirror", base: MIRROR }, { kind: "memo" }]] as SpecSource[][]) {
      await expect(readSpec(chain(MEMO_URL), get, INTENT, undefined, null, undefined, { sources })).rejects.toMatchObject({ name: "InvalidInput", field: "specSources", message: MEMO_FIRST });
      expect(() => createClient({ url: "http://" + "127.0.0.1:8899", transport: chain(MEMO_URL), specSources: sources })).toThrow(MEMO_FIRST);
    }
    expect(asked).toStrictEqual([]);
  });
});
