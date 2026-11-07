import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, getBase58Decoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { seal, specMemo } from "@intent-engine/core/internal";
import type { Transport } from "../src/index.js";
import { FetchFailed, UNEXPECTED_REDIRECT } from "../src/fetch-failed.js";
import { cidOfSpecHash, DEFAULT_SPEC_SOURCES, IPLD_RAW, MAX_SPEC_BYTES, NO_SPEC_URL, readSpec, SEALED_FROM_HASH_SOURCE, SPEC_READ_MS, SPEC_READ_OVER, SPEC_REDIRECTS, SpecCache, type SpecFetch, SpecSealed, type SpecSource, SpecUnreadable } from "../src/internal.js";
import { NOT_PUBLIC_SPEC } from "../src/job-specs.js";
import { testWallet } from "../src/testing.js";
import { createdEvent, engineView, intentBytes, key, OWNER, proofIntent, tx } from "./kill-client-jobs-ledger-kit.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const INTENT = key(91);
const PRIVATE_GENESIS = getBase58Decoder().decode(new Uint8Array(32).fill(7));
const SPEC = "deliver a module whose tests pass\n";
const MEMO_URL = "https://" + "specs.example/job.md";
const MIRROR = "https://" + "mirror.example";
const SECOND = "https://" + "second.example";
const GATEWAY = "https://" + "gateway.example";
const ARWEAVE = "https://" + "arweave.example";
const ARWEAVE_ID = "A".repeat(42) + "b";
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const HASH = sha(SPEC);
const MIRRORED = MIRROR + "/sha256/" + HASH;
const SECONDED = SECOND + "/sha256/" + HASH;

type Asked = { url: string; init: Parameters<SpecFetch>[1] };
type Page = () => Response | Promise<Response>;

function chain(memoUrl: string | null): Transport {
  const account = engineView(intentBytes(proofIntent({}, { specHash: Uint8Array.from(Buffer.from(HASH, "hex")) })));
  return {
    getAccount: async (address: Address) => (address === INTENT ? account : null),
    engineTransactions: async () => [tx("made", { emitted: [createdEvent(INTENT, OWNER)], memos: memoUrl === null ? [] : [specMemo(memoUrl)], memoSigners: [[OWNER]] })],
    genesisHash: async () => PRIVATE_GENESIS,
  } as unknown as Transport;
}

function serving(pages: Record<string, Page>, asked: Asked[] = []): SpecFetch {
  return async (url, init) => {
    asked.push({ url, init });
    const page = pages[url];
    return page === undefined ? new Response("missing", { status: 404 }) : page();
  };
}

const text = (body: string | Uint8Array): Page => () => new Response(typeof body === "string" ? body : Uint8Array.from(body));
const mirrors = (...bases: string[]): SpecSource[] => [{ kind: "memo" }, ...bases.map((base) => ({ kind: "mirror" as const, base }))];

const read = (memoUrl: string | null, get: SpecFetch, sources: readonly SpecSource[], cache?: SpecCache) =>
  readSpec(chain(memoUrl), get, INTENT, undefined, null, undefined, { sources, ...(cache === undefined ? {} : { cache }) });

const refusal = (spec: Promise<unknown>) =>
  spec.then(
    () => null,
    (error: unknown) => error,
  );

describe("a spec read by its hash when the memo url fails", () => {
  it("takes the bytes of a hash source when the memo url answers 404, and says what it tried", async () => {
    const asked: Asked[] = [];
    const spec = await read(MEMO_URL, serving({ [MIRRORED]: text(SPEC) }, asked), mirrors(MIRROR));
    expect(spec).toMatchObject({ url: MIRRORED, text: SPEC, sha256: HASH, matches: true, source: "mirror" });
    expect(spec?.tried).toStrictEqual([{ source: "memo", url: MEMO_URL, reason: `the spec at ${MEMO_URL} answered 404` }]);
    expect(asked.map(({ url, init }) => [url, init.redirect])).toStrictEqual([
      [MEMO_URL, "error"],
      [MIRRORED, "error"],
    ]);
  });

  it("reads hash sources when the escrow publishes no memo url, and keeps the memo url first when it serves", async () => {
    const missing = await read(null, serving({ [MIRRORED]: text(SPEC) }), mirrors(MIRROR));
    expect(missing).toMatchObject({ source: "mirror", matches: true, tried: [{ source: "memo", url: null, reason: NO_SPEC_URL }] });
    const asked: Asked[] = [];
    const memo = await read(MEMO_URL, serving({ [MEMO_URL]: text(SPEC), [MIRRORED]: text(SPEC) }, asked), mirrors(MIRROR));
    expect(memo).toMatchObject({ url: MEMO_URL, source: "memo", matches: true, tried: [] });
    expect(asked.map(({ url }) => url)).toStrictEqual([MEMO_URL]);
  });

  it("drops a source whose bytes do not match and takes the next", async () => {
    const spec = await read(MEMO_URL, serving({ [MEMO_URL]: text("an edited spec"), [MIRRORED]: text("another spec"), [SECONDED]: text(SPEC) }), mirrors(MIRROR, SECOND));
    expect(spec).toMatchObject({ url: SECONDED, text: SPEC, matches: true, source: "mirror" });
    expect(spec?.tried.map(({ url, reason }) => [url, reason])).toStrictEqual([
      [MEMO_URL, `the spec at ${MEMO_URL} answered bytes whose sha256 is ${sha("an edited spec")}, not the escrow's spec_hash`],
      [MIRRORED, `the spec at ${MIRRORED} answered bytes whose sha256 is ${sha("another spec")}, not the escrow's spec_hash`],
    ]);
  });

  it("keeps today's answer when nothing serves the hash: the memo's mismatch, its error, or null", async () => {
    const mismatched = await read(MEMO_URL, serving({ [MEMO_URL]: text("an edited spec"), [MIRRORED]: text("another spec") }), mirrors(MIRROR));
    expect(mismatched).toMatchObject({ url: MEMO_URL, text: "an edited spec", matches: false, source: "memo" });
    expect(mismatched?.tried).toHaveLength(2);
    const memoOnly = await refusal(read(MEMO_URL, serving({}), [{ kind: "memo" }]));
    const fallen = await refusal(read(MEMO_URL, serving({}), DEFAULT_SPEC_SOURCES));
    expect(fallen).toBeInstanceOf(SpecUnreadable);
    expect(fallen).toStrictEqual(memoOnly);
    expect((fallen as SpecUnreadable).message).toBe(`the spec at ${MEMO_URL} answered 404`);
    const redirected = serving({ [MEMO_URL]: () => Promise.reject(new FetchFailed(MEMO_URL, "redirect", UNEXPECTED_REDIRECT)) });
    expect(((await refusal(read(MEMO_URL, redirected, mirrors(MIRROR)))) as Error).message).toBe(`the spec at ${MEMO_URL} ${SPEC_REDIRECTS}`);
    expect(await read(null, serving({}), DEFAULT_SPEC_SOURCES)).toBeNull();
  });

  it("asks every default source in order: the memo url, the mirror, IPFS gateways answering raw blocks, then Arweave", async () => {
    const asked: Asked[] = [];
    await refusal(read(MEMO_URL, serving({}, asked), DEFAULT_SPEC_SOURCES));
    const cid = cidOfSpecHash(HASH);
    expect(DEFAULT_SPEC_SOURCES[0]).toStrictEqual({ kind: "memo" });
    expect(asked.map(({ url }) => url)).toStrictEqual([
      MEMO_URL,
      "https://" + "solive-specs.vercel.app/sha256/" + HASH,
      "https://" + "gateway.pinata.cloud/ipfs/" + cid + "?format=raw",
      "https://" + "ipfs.filebase.io/ipfs/" + cid + "?format=raw",
      "https://" + "arweave.net/graphql",
    ]);
    expect(asked.every(({ init }) => init.redirect === "error" && init.signal instanceof AbortSignal)).toBe(true);
  });
});

describe("each kind of hash source", () => {
  it("asks an IPFS gateway for the raw block of the CID", async () => {
    const block = GATEWAY + "/ipfs/" + cidOfSpecHash(HASH) + "?format=raw";
    const asked: Asked[] = [];
    const spec = await read(MEMO_URL, serving({ [block]: text(SPEC) }, asked), [{ kind: "memo" }, { kind: "ipfs", gateway: GATEWAY + "/" }]);
    expect(spec).toMatchObject({ url: block, source: "ipfs", matches: true });
    expect(asked[1]?.init).toMatchObject({ headers: { accept: IPLD_RAW } });
    expect(asked[1]?.init.method).toBeUndefined();
  });

  it("finds an Arweave upload by its Spec-Sha256 tag with one POST, then reads it raw", async () => {
    const query = ARWEAVE + "/graphql";
    const raw = (id: string) => ARWEAVE + "/raw/" + id;
    const edges = JSON.stringify({ data: { transactions: { edges: [{ node: { id: "../escape" } }, { node: { id: ARWEAVE_ID.replace("b", "c") } }, { node: { id: ARWEAVE_ID } }] } } });
    const asked: Asked[] = [];
    const get = serving({ [query]: text(edges), [raw(ARWEAVE_ID.replace("b", "c"))]: text("someone else's upload"), [raw(ARWEAVE_ID)]: text(SPEC) }, asked);
    const spec = await read(null, get, [{ kind: "memo" }, { kind: "arweave", gateway: ARWEAVE }]);
    expect(spec).toMatchObject({ url: raw(ARWEAVE_ID), source: "arweave", matches: true });
    expect(asked.map(({ url, init }) => [url, init.method ?? "GET"])).toStrictEqual([
      [query, "POST"],
      [raw(ARWEAVE_ID.replace("b", "c")), "GET"],
      [raw(ARWEAVE_ID), "GET"],
    ]);
    const posted = asked[0]?.init;
    expect(posted?.headers).toStrictEqual({ "content-type": "application/json" });
    const body = JSON.parse((posted?.body as string | undefined) ?? "{}") as { query: string; variables: { hash: string } };
    expect(body.variables).toStrictEqual({ hash: HASH });
    expect(body.query).toContain('name: "Spec-Sha256"');
  });

  it("names an Arweave answer that lists nothing or is not a list", async () => {
    const query = ARWEAVE + "/graphql";
    const empty = await read(null, serving({ [query]: text('{"data":{"transactions":{"edges":[]}}}') }), [{ kind: "memo" }, { kind: "arweave", gateway: ARWEAVE }]);
    expect(empty).toBeNull();
    const reasons = async (body: string) => (await read(MEMO_URL, serving({ [MEMO_URL]: text("other"), [query]: text(body) }), [{ kind: "memo" }, { kind: "arweave", gateway: ARWEAVE }]))?.tried.at(-1)?.reason;
    expect(await reasons("not json")).toBe(`the spec at ${query} answered no readable list of uploads`);
    expect(await reasons('{"data":{}}')).toBe(`the spec at ${query} answered no readable list of uploads`);
    expect(await reasons('{"data":{"transactions":{"edges":[{"node":{"id":"short"}}]}}}')).toBe(`the spec at ${query} lists no upload tagged with this spec hash`);
  });
});

describe("the guard on a hash source", () => {
  it("refuses a redirect from a hash source and tries the next", async () => {
    const get = serving({ [MIRRORED]: () => Promise.reject(new FetchFailed(MIRRORED, "redirect", UNEXPECTED_REDIRECT)), [SECONDED]: text(SPEC) });
    const spec = await read(null, get, mirrors(MIRROR, SECOND));
    expect(spec).toMatchObject({ url: SECONDED, source: "mirror" });
    expect(spec?.tried.at(-1)).toStrictEqual({ source: "mirror", url: MIRRORED, reason: `the spec at ${MIRRORED} ${SPEC_REDIRECTS}` });
  });

  it("never asks a hash source on a private address, by its literal or by what its name resolves to", async () => {
    const inside = "https://" + "10.0.0.7";
    const named = "https://" + "inside.example";
    const asked: Asked[] = [];
    const get = serving({ [inside + "/sha256/" + HASH]: text(SPEC), [named + "/sha256/" + HASH]: text(SPEC) }, asked);
    const lookup = async (host: string) => (host === "inside.example" ? ["192.168.1.9"] : ["93.184.215.14"]);
    const spec = await readSpec(chain(null), get, INTENT, undefined, lookup, undefined, { sources: mirrors(inside, named) });
    expect(spec).toBeNull();
    expect(asked).toStrictEqual([]);
  });

  it("refuses a hash source body over the size cap, declared or streamed", async () => {
    const big = new Uint8Array(MAX_SPEC_BYTES + 1).fill(0x61);
    const declared: Page = () => new Response("x", { headers: { "content-length": String(MAX_SPEC_BYTES + 1) } });
    const pages = { [MIRRORED]: declared, [SECONDED]: text(big) };
    const refused = await refusal(read(MEMO_URL, serving(pages), mirrors(MIRROR, SECOND)));
    expect((refused as Error).message).toBe(`the spec at ${MEMO_URL} answered 404`);
    const spec = await read(MEMO_URL, serving({ ...pages, [MEMO_URL]: text("other") }), mirrors(MIRROR, SECOND));
    expect(spec).toMatchObject({ source: "memo", matches: false });
    expect(spec?.tried.slice(1).map(({ reason }) => reason)).toStrictEqual([`the spec at ${MIRRORED} is larger than ${MAX_SPEC_BYTES} bytes`, `the spec at ${SECONDED} is larger than ${MAX_SPEC_BYTES} bytes`]);
  });

  it("checks the private address with the rpc url's loopback rule like the memo url", async () => {
    const loop = "https://" + "127.0.0.1:8443";
    const asked: Asked[] = [];
    const get = serving({ [loop + "/sha256/" + HASH]: text(SPEC) }, asked);
    const sources = mirrors(loop);
    expect(await readSpec(chain(null), get, INTENT, undefined, null, "https://" + "rpc.example", { sources })).toBeNull();
    expect(asked).toStrictEqual([]);
    expect(await readSpec(chain(null), get, INTENT, undefined, null, "http://" + "127.0.0.1:8899", { sources })).toMatchObject({ source: "mirror", matches: true });
    const named = await read(MEMO_URL, serving({ [MEMO_URL]: text("other") }), sources);
    expect(named?.tried.at(-1)?.reason).toBe(`the spec at ${loop}/sha256/${HASH} ${NOT_PUBLIC_SPEC}`);
  });
});

describe("a sealed spec", () => {
  it("keeps the memo path: a sealed memo spec never falls back to a hash source", async () => {
    const worker = await testWallet();
    const sealed = await seal(new TextEncoder().encode(SPEC), [worker.address]);
    const asked: Asked[] = [];
    const get = serving({ [MEMO_URL]: text(sealed), [MIRRORED]: text(SPEC) }, asked);
    const error = await refusal(read(MEMO_URL, get, mirrors(MIRROR)));
    expect(error).toBeInstanceOf(SpecSealed);
    expect(asked.map(({ url }) => url)).toStrictEqual([MEMO_URL]);
  });

  it("refuses sealed bytes from a hash source", async () => {
    const worker = await testWallet();
    const sealed = await seal(new TextEncoder().encode(SPEC), [worker.address]);
    const spec = await read(MEMO_URL, serving({ [MEMO_URL]: text("other"), [MIRRORED]: text(sealed) }), mirrors(MIRROR));
    expect(spec).toMatchObject({ source: "memo", matches: false });
    expect(spec?.sealedTo).toBeUndefined();
    expect(spec?.tried.at(-1)).toStrictEqual({ source: "mirror", url: MIRRORED, reason: `the spec at ${MIRRORED} ${SEALED_FROM_HASH_SOURCE}` });
    expect(await readSpec(chain(null), serving({ [MIRRORED]: text(sealed) }), INTENT, [worker.keypair], null, undefined, { sources: mirrors(MIRROR) })).toBeNull();
  });

  it("is never cached, so a later read without the key is still refused", async () => {
    const worker = await testWallet();
    const sealed = await seal(new TextEncoder().encode(SPEC), [worker.address]);
    const cache = new SpecCache();
    const get = serving({ [MEMO_URL]: text(sealed) });
    const opened = await readSpec(chain(MEMO_URL), get, INTENT, [worker.keypair], null, undefined, { sources: mirrors(MIRROR), cache });
    expect(opened).toMatchObject({ text: SPEC, matches: true, source: "memo", sealedTo: [worker.address] });
    expect(cache.size).toBe(0);
    expect(await refusal(read(MEMO_URL, get, mirrors(MIRROR), cache))).toBeInstanceOf(SpecSealed);
  });
});

describe("the spec source sentences of the docs", () => {
  const page = (name: string) => readFileSync(join(ROOT, "docs", name), "utf8");

  it("name each kind of source, its request and the rule every byte passes", () => {
    const client = page("sdk-client.md");
    for (const sentence of [
      "a `mirror` at `{base}/sha256/{hex}`, an `ipfs` gateway at `{gateway}/ipfs/{cid}?format=raw` with the CID `cidOfSpecHash` gives, and `arweave` by a GraphQL query for its `Spec-Sha256` tag, then `{gateway}/raw/{id}`.",
      "Every source goes through the same address checks, size cap, timeout and no-redirect rule as the memo url, and its bytes count only when their sha256 is the committed hash. Only the memo url may serve sealed bytes; another source that serves them is passed over.",
      "pass `specSources` to `createClient` to replace it.",
      "A client keeps each escrow's verified spec in memory by the escrow and its hash, so reading it again makes no request. It keeps a copy from another source only when the escrow publishes no memo url, so a memo url that comes back is read again.",
      "A spec is known as sealed only from its memo url. When that url is gone, a sealed job's spec is read by hash like any other, from whatever copy a source serves.",
      "A list whose first source is not `memo` is refused with `InvalidInput`, and one read stops asking sources after SPEC_READ_MS (" + SPEC_READ_MS + ", in milliseconds).",
    ]) {
      expect(client).toContain(sentence);
    }
    expect(DEFAULT_SPEC_SOURCES.map(({ kind }) => kind)).toStrictEqual(["memo", "mirror", "ipfs", "ipfs", "arweave"]);
    const mcp = page("mcp.md");
    expect(mcp).toContain("keeps their bytes only when their sha256 equals it. `source` says which served it: `memo`, `mirror`, `ipfs`, `arweave` or `cache`");
    expect(mcp).toContain("A job is known as sealed only from its url: when that url is gone, its spec is read by hash like any other job's.");
  });
});

describe("the time one spec read may take", () => {
  it("stops asking sources once its overall budget runs out", async () => {
    expect(SPEC_READ_MS).toBe(20_000);
    const asked: string[] = [];
    const stalled: SpecFetch = (url, init) => {
      asked.push(url);
      return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason as Error), { once: true }));
    };
    const started = performance.now();
    const error = await refusal(readSpec(chain(MEMO_URL), stalled, INTENT, undefined, null, undefined, { sources: mirrors(MIRROR, SECOND), budgetMs: 50 }));
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(error).toBeInstanceOf(SpecUnreadable);
    expect((error as SpecUnreadable).url).toBe(MEMO_URL);
    expect(asked).toStrictEqual([MEMO_URL]);
  });

  it("names each source it skipped for time", async () => {
    const asked: string[] = [];
    const get: SpecFetch = (url, init) => {
      asked.push(url);
      return url === MEMO_URL ? Promise.resolve(new Response("an edited spec")) : new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason as Error), { once: true }));
    };
    const spec = await readSpec(chain(MEMO_URL), get, INTENT, undefined, null, undefined, { sources: mirrors(MIRROR, SECOND), budgetMs: 50 });
    expect(spec).toMatchObject({ source: "memo", matches: false });
    expect(asked).toStrictEqual([MEMO_URL, MIRRORED]);
    expect(spec?.tried.at(-1)).toStrictEqual({ source: "mirror", url: null, reason: SPEC_READ_OVER });
  });
});
