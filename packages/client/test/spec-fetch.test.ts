import { createHash } from "node:crypto";
import { type Address, getBase58Decoder, type Instruction, type KeyPairSigner } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { Kind } from "@intent-engine/core";
import { INTENT_ENGINE_PROGRAM_ADDRESS, specMemo } from "@intent-engine/core/internal";
import { SpecUnreadable, type Transport } from "../src/index.js";
import { type CheckedFetch, loopbackAddress, loopbackUrl, memoInstruction, publicAddresses, SPEC_TIMEOUT_MS } from "../src/internal.js";
import { NOT_PUBLIC_SPEC } from "../src/job-specs.js";
import { createClient } from "../src/node.js";
import { funded, world, type World } from "./svm.js";

const STALLED = "stalled.example";

vi.mock("node:dns/promises", () => ({
  lookup: (host: string) => (host === STALLED ? new Promise(() => undefined) : Promise.reject(new Error(`getaddrinfo ENOTFOUND ${host}`))),
}));

const LOCAL = "http://" + "127.0.0.1:8899";
const REMOTE = "https://" + "rpc.example";
const PRIVATE_GENESIS = getBase58Decoder().decode(new Uint8Array(32).fill(7));
const SPEC = "the acceptance spec the work must pass\n";
const sha = (text: string) => new Uint8Array(createHash("sha256").update(text).digest());

type Asked = { url: string; addresses: readonly string[] };

function serving(asked: Asked[], body: () => Response = () => new Response(SPEC)): CheckedFetch {
  return async (url, init) => {
    asked.push({ url, addresses: init.addresses });
    return body();
  };
}

const proof = (judge: Address) => ({ kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge, specHash: sha(SPEC), judgeFee: 0n }) as const;

const privateCluster = (inner: Transport): Transport => ({ ...inner, genesisHash: async () => PRIVATE_GENESIS });

async function escrow(w: World, specUrl: string): Promise<Address> {
  const judge = await funded(w.chain);
  const made = await createClient({ url: LOCAL, transport: w.chain.transport }).createIntent({
    signer: w.owner,
    inputMint: w.inputMint,
    outputMint: w.outputMint,
    params: proof(judge.address),
    specUrl,
  });
  return made.intent;
}

function carrying(inner: Transport, extra: () => Instruction[]): Transport {
  let armed = true;
  return {
    ...inner,
    send: (instructions, payer) => {
      const creates = armed && instructions.some((ix) => ix.programAddress === INTENT_ENGINE_PROGRAM_ADDRESS);
      armed = armed && !creates;
      return inner.send(creates ? [...instructions, ...extra()] : instructions, payer);
    },
  };
}

async function created(w: World, stranger: KeyPairSigner, foreign: string[], specUrl?: string) {
  const judge = await funded(w.chain);
  const transport = carrying(w.chain.transport, () => foreign.map((url) => memoInstruction(stranger, specMemo(url))));
  const made = await createClient({ url: LOCAL, transport }).createIntent({
    signer: w.owner,
    inputMint: w.inputMint,
    outputMint: w.outputMint,
    params: proof(judge.address),
    ...(specUrl === undefined ? {} : { specUrl }),
  });
  const tx = await w.chain.transport.transactionOf?.(made.signature);
  const strangers = (tx?.memos ?? []).filter((_, i) => tx?.memoSigners?.[i]?.includes(stranger.address) === true);
  expect(strangers).toEqual(foreign.map(specMemo));
  return made.intent;
}

describe("the address check on a cluster that is not public", () => {
  it("refuses a private spec url before fetching it, whatever the genesis hash", async () => {
    const w = await world();
    const transport = privateCluster(w.chain.transport);
    for (const rpc of [LOCAL, REMOTE]) {
      for (const host of ["10.0.0.7", "192.168.1.2", "169.254.169.254", "[fd00::1]", "[fe80::1]"]) {
        const url = "https://" + host + "/spec.md";
        const intent = await escrow(w, url);
        const asked: Asked[] = [];
        const read = createClient({ url: rpc, transport, fetch: serving(asked) }).spec(intent);
        await expect(read).rejects.toThrow(new SpecUnreadable(url, NOT_PUBLIC_SPEC));
        expect(asked).toEqual([]);
      }
    }
  });

  it("allows a loopback spec url only when the rpc url is loopback", async () => {
    const w = await world();
    const transport = privateCluster(w.chain.transport);
    for (const [host, address] of [
      ["127.0.0.1:8443", "127.0.0.1"],
      ["[::1]:8443", "::1"],
    ] as const) {
      const url = "https://" + host + "/spec.md";
      const intent = await escrow(w, url);
      const refused: Asked[] = [];
      await expect(createClient({ url: REMOTE, transport, fetch: serving(refused) }).spec(intent)).rejects.toThrow(new SpecUnreadable(url, NOT_PUBLIC_SPEC));
      expect(refused).toEqual([]);
      for (const rpc of [LOCAL, "http://" + "localhost:8899", "http://" + "[::1]:8899"]) {
        const asked: Asked[] = [];
        expect(await createClient({ url: rpc, transport, fetch: serving(asked) }).spec(intent)).toMatchObject({ url, matches: true });
        expect(asked).toEqual([{ url, addresses: [address] }]);
      }
    }
  });

  it("hands a custom fetch the checked addresses of a public host", async () => {
    const w = await world();
    const url = "https://" + "93.184.215.14/spec.md";
    const intent = await escrow(w, url);
    const asked: Asked[] = [];
    expect(await createClient({ url: REMOTE, transport: privateCluster(w.chain.transport), fetch: serving(asked) }).spec(intent)).toMatchObject({ url, matches: true });
    expect(asked).toEqual([{ url, addresses: ["93.184.215.14"] }]);
  });

  it("refuses a host whose name does not resolve before fetching it", async () => {
    const w = await world();
    const url = "https://" + "gone.example/spec.md";
    const intent = await escrow(w, url);
    const asked: Asked[] = [];
    await expect(createClient({ url: LOCAL, transport: privateCluster(w.chain.transport), fetch: serving(asked) }).spec(intent)).rejects.toThrow(new SpecUnreadable(url, NOT_PUBLIC_SPEC));
    expect(asked).toEqual([]);
  });
});

describe("one timeout for the whole read", () => {
  it("ends a lookup that never answers and a body that never ends within the same limit", async () => {
    const w = await world();
    const stalled = "https://" + STALLED + "/spec.md";
    const slow = "https://" + "93.184.215.14/slow.md";
    const lookupIntent = await escrow(w, stalled);
    const bodyIntent = await escrow(w, slow);
    const asked: Asked[] = [];
    const endless = () => new Response(new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(new Uint8Array(1)) }));
    const client = createClient({ url: LOCAL, transport: privateCluster(w.chain.transport), fetch: serving(asked, endless) });
    const timed = async (intent: Address) => {
      const start = performance.now();
      const error = await client.spec(intent).catch((caught: unknown) => caught);
      return { error, ms: performance.now() - start };
    };
    const [lookup, body] = await Promise.all([timed(lookupIntent), timed(bodyIntent)]);
    for (const { error, ms } of [lookup, body]) {
      expect(error).toBeInstanceOf(SpecUnreadable);
      expect(ms).toBeGreaterThanOrEqual(SPEC_TIMEOUT_MS - 100);
      expect(ms).toBeLessThan(SPEC_TIMEOUT_MS + 3_000);
    }
    expect(asked.map(({ url }) => url)).toEqual([slow]);
  }, 30_000);
});

describe("the spec url the owner signed", () => {
  it("returns the owner's url when the creation also carries a spec memo another wallet signed", async () => {
    const w = await world();
    const stranger = await funded(w.chain);
    const owners = "https://" + "93.184.215.14/spec.md";
    const intent = await created(w, stranger, ["https://" + "10.0.0.9/evil.md"], owners);
    const asked: Asked[] = [];
    const client = createClient({ url: LOCAL, transport: w.chain.transport, fetch: serving(asked) });
    expect((await client.jobs()).find((job) => job.intent === intent)?.specUrl).toBe(owners);
    expect(await client.spec(intent)).toMatchObject({ url: owners, matches: true });
    expect(asked.map(({ url }) => url)).toEqual([owners]);
  });

  it("finds no spec url when only another wallet signed a spec memo", async () => {
    const w = await world();
    const stranger = await funded(w.chain);
    const intent = await created(w, stranger, ["https://" + "93.184.215.14/relayed.md"]);
    const asked: Asked[] = [];
    const client = createClient({ url: LOCAL, transport: w.chain.transport, fetch: serving(asked) });
    expect((await client.jobs()).find((job) => job.intent === intent)?.specUrl).toBeNull();
    expect(await client.spec(intent)).toBeNull();
    expect(asked).toEqual([]);
  });

  it("finds no spec url when the owner signed two different ones", async () => {
    const w = await world();
    const judge = await funded(w.chain);
    const second = "https://" + "93.184.215.14/second.md";
    const transport = carrying(w.chain.transport, () => [memoInstruction(w.owner, specMemo(second))]);
    const made = await createClient({ url: LOCAL, transport }).createIntent({
      signer: w.owner,
      inputMint: w.inputMint,
      outputMint: w.outputMint,
      params: proof(judge.address),
      specUrl: "https://" + "93.184.215.14/first.md",
    });
    const client = createClient({ url: LOCAL, transport: w.chain.transport, fetch: serving([]) });
    expect((await client.jobs()).find((job) => job.intent === made.intent)?.specUrl).toBeNull();
  });
});

describe("loopback addresses", () => {
  it.each(["127.0.0.1", "127.255.0.9", "::1", "::ffff:127.0.0.1", "0:0:0:0:0:0:0:1"])("counts %s as loopback", (ip) => {
    expect(loopbackAddress(ip)).toBe(true);
  });

  it.each(["10.0.0.1", "169.254.169.254", "::", "::2", "fe80::1", "::ffff:10.0.0.1", "8.8.8.8", "localhost", "128.0.0.1"])("does not count %s as loopback", (ip) => {
    expect(loopbackAddress(ip)).toBe(false);
  });

  it("reads a loopback rpc url by its host", () => {
    expect([LOCAL, "http://" + "localhost:8899", "http://" + "[::1]:8899", REMOTE, "http://" + "10.0.0.1:8899", "not a url"].map(loopbackUrl)).toEqual([true, true, true, false, false, false]);
  });

  it("allows loopback answers only when asked, and never private ones", async () => {
    const answers = (found: string[]) => async () => found;
    expect(await publicAddresses("spec.example", answers(["127.0.0.1"]))).toBeNull();
    expect(await publicAddresses("spec.example", answers(["127.0.0.1", "::1"]), true)).toEqual(["127.0.0.1", "::1"]);
    expect(await publicAddresses("spec.example", answers(["127.0.0.1", "10.0.0.1"]), true)).toBeNull();
    expect(await publicAddresses("spec.example", answers(["169.254.169.254"]), true)).toBeNull();
    expect(await publicAddresses("spec.example", answers(["8.8.8.8"]))).toEqual(["8.8.8.8"]);
  });
});
