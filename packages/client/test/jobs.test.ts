import { createHash, generateKeyPairSync } from "node:crypto";
import {
  type Address,
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressDecoder,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  type Instruction,
  type KeyPairSigner,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { describe, expect, it } from "vitest";
import { findEventAuthorityPda, findIntentPda, Kind, MAX_MEMO_URL, PRODUCT_SLUG, seal, SPEC_MEMO_PREFIX, specMemo } from "@intent-engine/core";
import {
  commitmentOf,
  deliverySalt,
  createClient,
  creationProof,
  engineCalls,
  type Delivery,
  DELIVERY_PAGES,
  DELIVERY_SCAN,
  deliveryRecord,
  DEVNET_GENESIS_HASH,
  EXPIRES_IN_RANGE,
  firstDelivery,
  saltCheckOf,
  JOBS_LIMIT,
  type ListedSignature,
  MAX_EXPIRES_IN,
  MAX_SPEC_BYTES,
  MEMO_PROGRAM_ADDRESS,
  memoInstruction,
  MIN_EXPIRES_IN,
  NotDeliverable,
  PLAIN_HTTP_ON_PUBLIC,
  SIGNATURE_PAGE,
  SPEC_URL_NEEDS_PROOF,
  SpecSealed,
  SpecUnreadable,
  type SpecFetch,
  type Transport,
} from "../src/index.js";
import { funded, world, type World } from "./svm.js";

const LOCAL = "http://127.0.0.1:8899";
const LOOKUP_TABLE_HEAD = 56;
const ADDRESS_LOOKUP_TABLE_PROGRAM = "AddressLookupTab1e1111111111111111111111111" as Address;
const SPEC = "the acceptance spec the work must pass\n";
const SPEC_URL = "https://example.org/jobs/spec.md";
const WORK = createHash("sha256").update("the work").digest("hex");
const WORK_URL = "https://example.org/work.tar";
const SALT = "ab".repeat(16);
const sha = (text: string) => new Uint8Array(createHash("sha256").update(text).digest());

type Fetched = { url: string; init: { redirect: string; signal: AbortSignal } };

function serving(pages: Record<string, string | Uint8Array>, fetched: Fetched[] = []): SpecFetch {
  return async (url, init) => {
    fetched.push({ url, init });
    const page = pages[url];
    return page === undefined ? new Response("missing", { status: 404 }) : new Response(page);
  };
}

const proof = (judge: Address, spec: Uint8Array = sha(SPEC)) =>
  ({ kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge, specHash: spec, judgeFee: 0n }) as const;

async function setting(fetch?: SpecFetch) {
  const w = await world();
  const client = createClient({ url: LOCAL, transport: w.chain.transport, ...(fetch === undefined ? {} : { fetch }) });
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const keypair = Uint8Array.from([...Buffer.from(jwk.d ?? "", "base64url"), ...Buffer.from(jwk.x ?? "", "base64url")]);
  const judge = await createKeyPairSignerFromBytes(keypair);
  w.chain.svm.airdrop(judge.address, lamports(100_000_000_000n));
  const order = { signer: w.owner, inputMint: w.inputMint, outputMint: w.outputMint };
  return { w, client, judge, keypair, order };
}

async function announce(w: World, worker: KeyPairSigner, to: Address, memos: readonly string[]) {
  return w.chain.transport.send(
    [...memos.map((memo) => memoInstruction(worker, memo)), getTransferSolInstruction({ source: worker, destination: to, amount: 0n })],
    worker,
  );
}

async function flood(w: World, to: Address, times: number, memos: (i: number) => readonly string[] = () => []) {
  const sender = await funded(w.chain);
  for (let i = 0; i < times; i++) {
    await announce(w, sender, to, memos(i));
  }
}

function paged(inner: Transport, size: number): Transport {
  const { signaturesOf } = inner;
  if (signaturesOf === undefined) {
    throw new Error("the transport lists no signature pages");
  }
  return { ...inner, signaturesOf: (of, limit, before) => signaturesOf(of, Math.min(limit, size), before) };
}

const FLOOD = "flood-";

function flooded(w: World, inner: Transport, of: Address, count: number): Transport {
  const { signaturesOf } = inner;
  if (signaturesOf === undefined) {
    throw new Error("the transport lists no signature pages");
  }
  const { slot, unixTimestamp } = w.chain.svm.getClock();
  return {
    ...inner,
    signaturesOf: async (address, limit, before) => {
      const at = before === undefined ? 0 : before.startsWith(FLOOD) ? Number(before.slice(FLOOD.length)) + 1 : null;
      if (address !== of || at === null) {
        return signaturesOf(address, limit, before);
      }
      const n = Math.max(0, Math.min(limit, count - at));
      const fake = Array.from({ length: n }, (_, i): ListedSignature => ({ signature: `${FLOOD}${at + i}`, slot, blockTime: unixTimestamp, failed: false, memo: null }));
      return n < limit ? [...fake, ...(await signaturesOf(address, limit - n))] : fake;
    },
  };
}

function counted(inner: Transport, calls: Address[]): Transport {
  const { signaturesOf } = inner;
  if (signaturesOf === undefined) {
    throw new Error("the transport lists no signature pages");
  }
  return {
    ...inner,
    signaturesOf: (of, limit, before) => {
      calls.push(of);
      return signaturesOf(of, limit, before);
    },
  };
}

describe("jobs", () => {
  it("lists open proof escrows with the spec url their create transaction published, and nothing else", async () => {
    const { w, client, judge, order } = await setting();
    const other = await generateKeyPairSigner();
    const published = await client.createIntent({ ...order, params: proof(judge.address), specUrl: SPEC_URL });
    const silent = await client.createIntent({ ...order, params: proof(judge.address) });
    const elsewhere = await client.createIntent({ ...order, params: proof(other.address), specUrl: SPEC_URL });
    await client.createIntent({ ...order, params: { ...proof(judge.address), specHash: new Uint8Array(32) } });
    await client.createIntent({ ...order, params: { kind: Kind.SwapExactIn, amountIn: 10n, minOut: 1n } });
    const cancelled = await client.createIntent({ ...order, params: proof(judge.address), specUrl: SPEC_URL });
    await client.cancel(w.owner, cancelled.nonce);

    const mine = await client.jobs({ attestor: judge.address });
    expect(mine.map(({ intent }) => intent).sort()).toEqual([published.intent, silent.intent].sort());
    expect(mine.find(({ intent }) => intent === published.intent)).toEqual({
      intent: published.intent,
      owner: w.owner.address,
      nonce: published.nonce,
      attestor: judge.address,
      specHash: Buffer.from(sha(SPEC)).toString("hex"),
      specUrl: SPEC_URL,
      sells: 100n,
      judgeFee: 0n,
      feeBps: expect.any(Number),
      inputMint: w.inputMint,
      expiresAt: expect.any(BigInt),
    });
    expect(mine.find(({ intent }) => intent === silent.intent)?.specUrl).toBeNull();
    expect((await client.jobs()).map(({ intent }) => intent).sort()).toEqual([published.intent, silent.intent, elsewhere.intent].sort());
  });

  it("fits the longest spec url in a first create that also registers the owner and creates the receiver's account", async () => {
    const { client, judge, order } = await setting();
    const receiver = (await generateKeyPairSigner()).address;
    const longest = "https://example.org/" + "s".repeat(MAX_MEMO_URL - 20);
    expect(longest).toHaveLength(MAX_MEMO_URL);
    const made = await client.createIntent({ ...order, receiver, params: proof(judge.address), specUrl: longest });
    expect((await client.jobs())[0]).toMatchObject({ intent: made.intent, specUrl: longest });
  });

  it("refuses a spec url on anything but a proof escrow, or one that is not an https url", async () => {
    const { client, judge, order } = await setting();
    const swap = { kind: Kind.SwapExactIn, amountIn: 10n, minOut: 1n } as const;
    await expect(client.createIntent({ ...order, params: swap, specUrl: SPEC_URL })).rejects.toThrow(SPEC_URL_NEEDS_PROOF);
    const plain = { ...proof(judge.address), specHash: new Uint8Array(32) };
    await expect(client.createIntent({ ...order, params: plain, specUrl: SPEC_URL })).rejects.toThrow(SPEC_URL_NEEDS_PROOF);
    await expect(client.createIntent({ ...order, params: proof(judge.address), specUrl: "http://example.org/spec" })).rejects.toThrow(RangeError);
    expect(await client.jobs()).toEqual([]);
  });

  it("takes the spec url only from the create transaction, not from memos anyone sends to the intent later", async () => {
    const { w, client, judge, order } = await setting();
    const silent = await client.createIntent({ ...order, params: proof(judge.address) });
    const published = await client.createIntent({ ...order, params: proof(judge.address), specUrl: SPEC_URL });
    const stranger = await funded(w.chain);
    for (const intent of [silent.intent, published.intent]) {
      await announce(w, stranger, intent, [specMemo("https://evil.example/spec.md")]);
    }
    const jobs = await client.jobs({ attestor: judge.address });
    expect(jobs.find(({ intent }) => intent === silent.intent)?.specUrl).toBeNull();
    expect(jobs.find(({ intent }) => intent === published.intent)?.specUrl).toBe(SPEC_URL);
  });
});

describe("spec", () => {
  it("fetches the published spec without redirects and says whether it matches the committed hash", async () => {
    const fetched: Fetched[] = [];
    const { client, judge, order } = await setting(serving({ [SPEC_URL]: SPEC, "https://example.org/other.md": "something else" }, fetched));
    const good = await client.createIntent({ ...order, params: proof(judge.address), specUrl: SPEC_URL });
    const swapped = await client.createIntent({ ...order, params: proof(judge.address), specUrl: "https://example.org/other.md" });
    const silent = await client.createIntent({ ...order, params: proof(judge.address) });

    expect(await client.spec(good.intent)).toEqual({ url: SPEC_URL, text: SPEC, bytes: expect.any(Uint8Array), sha256: Buffer.from(sha(SPEC)).toString("hex"), matches: true });
    expect(fetched[0]?.url).toBe(SPEC_URL);
    expect(fetched[0]?.init.redirect).toBe("error");
    expect(fetched[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(await client.spec(swapped.intent)).toMatchObject({ text: "something else", matches: false });
    fetched.length = 0;
    expect(await client.spec(silent.intent)).toBeNull();
    expect(await client.spec(judge.address)).toBeNull();
    expect(fetched).toEqual([]);
  });

  it("refuses a spec that is missing or larger than the limit", async () => {
    const big = new Uint8Array(MAX_SPEC_BYTES + 1);
    const { client, judge, order } = await setting(serving({ "https://example.org/big": big }));
    const large = await client.createIntent({ ...order, params: proof(judge.address), specUrl: "https://example.org/big" });
    const gone = await client.createIntent({ ...order, params: proof(judge.address), specUrl: "https://example.org/gone" });
    await expect(client.spec(large.intent)).rejects.toThrow(SpecUnreadable);
    await expect(client.spec(gone.intent)).rejects.toThrow("answered 404");
  });
});

describe("deliveries", () => {
  it("announces a delivery to the judge and lists it, ignoring malformed, foreign, clear v1 and other memos", async () => {
    const { w, client, judge, order } = await setting();
    const job = await client.createIntent({ ...order, params: proof(judge.address), specUrl: SPEC_URL });
    const foreign = await client.createIntent({ ...order, params: proof(w.authority.address) });
    const worker = await funded(w.chain);
    const stranger = await funded(w.chain);
    const clear = (intent: Address) => `${PRODUCT_SLUG}-delivery:${intent}:${WORK}:${WORK_URL}`;

    const signature = await client.deliver({ worker, intent: job.intent, sha256: WORK, url: WORK_URL });
    await announce(w, stranger, judge.address, ["not a delivery", `delivery sha256:${WORK}`, clear(job.intent), `${clear(job.intent)} `, clear(foreign.intent), specMemo(SPEC_URL)]);
    const later = await client.deliver({ worker: stranger, intent: job.intent, sha256: "cd".repeat(32), url: "https://example.org/v2" });

    const found = await client.deliveries({ judge: judge.address });
    const sealed = { sha256: "", url: "", slot: expect.any(BigInt), blockTime: expect.any(BigInt), sealed: expect.any(String), check: expect.any(String), salt: "" };
    const strangerSalt = await deliverySalt(stranger, job.intent, "cd".repeat(32));
    const workerSalt = await deliverySalt(worker, job.intent, WORK);
    expect(found).toEqual([
      { intent: job.intent, worker: stranger.address, signature: later, commitment: commitmentOf(job.intent, stranger.address, strangerSalt, "cd".repeat(32)), ...sealed },
      { intent: job.intent, worker: worker.address, signature, commitment: commitmentOf(job.intent, worker.address, workerSalt, WORK), ...sealed },
    ]);
    expect(await client.deliveries({ judge: judge.address, intent: job.intent })).toEqual(found);
    expect(await client.deliveries({ judge: judge.address, intent: foreign.intent })).toEqual([]);
    expect(await client.deliveries({ judge: w.authority.address })).toEqual([]);
    expect(DELIVERY_SCAN).toBe(100);
  });

  it("pays the earliest announcer of a hash: a later announcement of the same work comes second", async () => {
    const { w, client, judge, keypair, order } = await setting();
    const job = await client.createIntent({ ...order, params: proof(judge.address), specUrl: SPEC_URL });
    const worker = await funded(w.chain);
    const copier = await funded(w.chain);
    await client.deliver({ worker, intent: job.intent, sha256: WORK, url: WORK_URL });
    w.chain.svm.warpToSlot(w.chain.svm.getClock().slot + 1n);
    await client.deliver({ worker: copier, intent: job.intent, sha256: WORK, url: "https://example.org/stolen" });
    await client.deliver({ worker: copier, intent: job.intent, sha256: "cd".repeat(32), url: "https://example.org/own" });

    const found = (await client.deliveryRecord({ judge: judge.address, intent: job.intent, keypair })).deliveries;
    expect(found.map(({ worker: by }) => by)).toEqual([copier.address, copier.address, worker.address]);
    expect(firstDelivery(found, WORK)).toMatchObject({ worker: worker.address, sha256: WORK });
    expect(firstDelivery(found, "cd".repeat(32))).toMatchObject({ worker: copier.address, sha256: "cd".repeat(32) });
    expect(firstDelivery(found, "ef".repeat(32))).toBeNull();
  });

  it("a spec memo with a 0.1.23 url is still read", async () => {
    const w = await world();
    const legacy = "https://Example.org:443/jobs/./spec.md";
    const inner = w.chain.transport;
    const written: Transport = {
      ...inner,
      send: (instructions, payer) =>
        inner.send(
          instructions.map((ix) =>
            ix.programAddress === MEMO_PROGRAM_ADDRESS && new TextDecoder().decode(Uint8Array.from(ix.data ?? [])) === specMemo(SPEC_URL)
              ? { ...ix, data: new TextEncoder().encode(`${SPEC_MEMO_PREFIX}${legacy}`) }
              : ix,
          ),
          payer,
        ),
    };
    const fetched: Fetched[] = [];
    const client = createClient({ url: LOCAL, transport: written, fetch: serving({ [legacy]: SPEC }, fetched) });
    const judge = await funded(w.chain);
    const order = { signer: w.owner, inputMint: w.inputMint, outputMint: w.outputMint };
    expect(() => specMemo(legacy)).toThrow(RangeError);
    const job = await client.createIntent({ ...order, params: proof(judge.address), specUrl: SPEC_URL });
    expect((await client.jobs())[0]).toMatchObject({ intent: job.intent, specUrl: legacy });
    expect(await client.jobs({ attestor: judge.address })).toMatchObject([{ intent: job.intent, specUrl: legacy }]);
    expect(await client.spec(job.intent)).toEqual({ url: legacy, text: SPEC, bytes: expect.any(Uint8Array), sha256: Buffer.from(sha(SPEC)).toString("hex"), matches: true });
    expect(fetched.map(({ url }) => url)).toEqual([legacy]);
  });

  it("breaks a tie in slot by the lower signature", async () => {
    const intent = MEMO_PROGRAM_ADDRESS;
    const [late, second, first] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
    const at = (worker: Address, signature: string, slot: bigint) =>
      ({ intent, worker, sha256: "", url: "", signature, slot, blockTime: null, commitment: commitmentOf(intent, worker, SALT, WORK), check: saltCheckOf(SALT), salt: SALT, sealed: "" }) as unknown as Delivery;
    const found = [at(late.address, "a", 5n), at(second.address, "c", 4n), at(first.address, "b", 4n)];
    expect(firstDelivery(found, WORK)?.worker).toBe(first.address);
    expect(firstDelivery([...found].reverse(), WORK)?.worker).toBe(first.address);
  });

  it("refuses to deliver to anything but an open proof escrow, and to a bad hash or url", async () => {
    const { w, client, judge, order } = await setting();
    const worker = await funded(w.chain);
    const swap = await client.createIntent({ ...order, params: { kind: Kind.SwapExactIn, amountIn: 10n, minOut: 1n } });
    const plain = await client.createIntent({ ...order, params: { ...proof(judge.address), specHash: new Uint8Array(32) } });
    const closed = await client.createIntent({ ...order, params: proof(judge.address) });
    await client.cancel(w.owner, closed.nonce);
    const [unused] = await findIntentPda({ owner: w.owner.address, nonce: 99n });
    for (const intent of [swap.intent, plain.intent, closed.intent, unused, judge.address]) {
      await expect(client.deliver({ worker, intent, sha256: WORK, url: WORK_URL })).rejects.toThrow(NotDeliverable);
    }
    const open = await client.createIntent({ ...order, params: proof(judge.address) });
    await expect(client.deliver({ worker, intent: open.intent, sha256: "zz".repeat(32), url: WORK_URL })).rejects.toThrow(RangeError);
    await expect(client.deliver({ worker, intent: open.intent, sha256: WORK, url: "ftp://example.org/x" })).rejects.toThrow(RangeError);
    expect(await client.deliveries({ judge: judge.address })).toEqual([]);
  });

  it("uppercase sha256 is accepted", async () => {
    const { w, client, judge, keypair, order } = await setting();
    const job = await client.createIntent({ ...order, params: proof(judge.address), specUrl: SPEC_URL });
    const worker = await funded(w.chain);
    await client.deliver({ worker, intent: job.intent, sha256: WORK.toUpperCase(), url: WORK_URL });
    expect(firstDelivery((await client.deliveryRecord({ judge: judge.address, keypair })).deliveries, WORK)).toMatchObject({ intent: job.intent, worker: worker.address, sha256: WORK });
    const signature = await client.settleProof({ judge, owner: w.owner.address, nonce: job.nonce, payTo: worker.address, result: 1n, deliveredSha256: WORK.toUpperCase() });
    const released = (await client.history(job.intent)).find(({ name }) => name === "IntentAttested");
    expect(released).toMatchObject({ signature, deliveredSha256: WORK });
  });

  it("a plain http spec url is refused at create on a public cluster", async () => {
    const { w, judge, keypair, order } = await setting();
    const devnet = createClient({ url: LOCAL, transport: { ...w.chain.transport, genesisHash: async () => DEVNET_GENESIS_HASH } });
    const plain = "http://127.0.0.1:8080/spec.md";
    await expect(devnet.createIntent({ ...order, params: proof(judge.address), specUrl: plain })).rejects.toThrow(`the spec url ${plain} ${PLAIN_HTTP_ON_PUBLIC}`);
    expect(await devnet.jobs()).toEqual([]);
    const job = await devnet.createIntent({ ...order, params: proof(judge.address), specUrl: SPEC_URL });
    const worker = await funded(w.chain);
    const work = "http://127.0.0.1:8080/work.tar";
    await expect(devnet.deliver({ worker, intent: job.intent, sha256: WORK, url: work })).rejects.toThrow(`the work url ${work} ${PLAIN_HTTP_ON_PUBLIC}`);
    expect(await devnet.deliveries({ judge: judge.address })).toEqual([]);
    const local = createClient({ url: LOCAL, transport: w.chain.transport });
    await local.deliver({ worker, intent: job.intent, sha256: WORK, url: work });
    expect(firstDelivery((await local.deliveryRecord({ judge: judge.address, keypair })).deliveries, WORK)).toMatchObject({ worker: worker.address });
  });

  it("refuses an expiresIn below a minute or above a year", async () => {
    const { client, judge, order } = await setting();
    for (const expiresIn of [MIN_EXPIRES_IN - 1n, MAX_EXPIRES_IN + 1n]) {
      await expect(client.createIntent({ ...order, params: proof(judge.address), expiresIn })).rejects.toThrow(EXPIRES_IN_RANGE);
    }
    expect(await client.jobs()).toEqual([]);
    const made = await client.createIntent({ ...order, params: proof(judge.address), expiresIn: MIN_EXPIRES_IN });
    expect((await client.jobs())[0]).toMatchObject({ intent: made.intent });
  });
});

describe("history past a window of recent transactions", () => {
  it("names the honest announcer after 150 later judge transactions", async () => {
    const { w, client, judge, keypair, order } = await setting();
    const job = await client.createIntent({ ...order, params: proof(judge.address), specUrl: SPEC_URL });
    const worker = await funded(w.chain);
    const copier = await funded(w.chain);
    await client.deliver({ worker, intent: job.intent, sha256: WORK, url: WORK_URL });
    w.chain.svm.warpToSlot(w.chain.svm.getClock().slot + 1n);
    await flood(w, judge.address, 150);
    await client.deliver({ worker: copier, intent: job.intent, sha256: WORK, url: "https://example.org/stolen" });

    const record = await client.deliveryRecord({ judge: judge.address, intent: job.intent, keypair });
    expect(record.complete).toBe(true);
    expect(firstDelivery(record.deliveries, WORK)).toMatchObject({ worker: worker.address });
    expect(await client.deliveries({ judge: judge.address, intent: job.intent })).toEqual(record.deliveries.map((d) => ({ ...d, url: "", salt: "" })));
    expect(firstDelivery((await client.deliveryRecord({ judge: judge.address, keypair })).deliveries, WORK)?.worker).toBe(worker.address);
  });

  it("a flooded judge record completes with more pages", async () => {
    const { w, client, judge, order } = await setting();
    const job = await client.createIntent({ ...order, params: proof(judge.address) });
    const worker = await funded(w.chain);
    await client.deliver({ worker, intent: job.intent, sha256: WORK, url: WORK_URL });
    const flood = flooded(w, w.chain.transport, judge.address, DELIVERY_PAGES * SIGNATURE_PAGE);

    expect(DELIVERY_PAGES).toBeGreaterThanOrEqual(100);
    expect(await deliveryRecord(flood, judge.address, job.intent)).toEqual({ deliveries: [], openings: [], complete: false, pages: DELIVERY_PAGES });
    expect(await createClient({ url: LOCAL, transport: flood }).deliveryRecord({ judge: judge.address })).toEqual({ deliveries: [], openings: [], complete: false, pages: DELIVERY_PAGES });
    const further = await deliveryRecord(flood, judge.address, job.intent, DELIVERY_PAGES + 1);
    expect(further).toMatchObject({ complete: true, pages: DELIVERY_PAGES + 1 });
    expect(further.deliveries.map(({ worker: by }) => by)).toEqual([worker.address]);
    expect(await createClient({ url: LOCAL, transport: flood }).deliveryRecord({ judge: judge.address, intent: job.intent, pages: DELIVERY_PAGES + 1 })).toEqual(further);
  });

  it("an empty page is not complete when the node history starts after the intent", async () => {
    const { w, client, judge, order } = await setting();
    w.chain.svm.warpToSlot(w.chain.svm.getClock().slot + 5n);
    const created = w.chain.svm.getClock().slot;
    const job = await client.createIntent({ ...order, params: proof(judge.address) });
    w.chain.svm.warpToSlot(created + 5n);
    const pruned: Transport = { ...w.chain.transport, firstAvailableSlot: async () => created + 1n };
    const { firstAvailableSlot: _, ...unknown } = w.chain.transport;

    expect(await w.chain.transport.signaturesOf?.(judge.address, SIGNATURE_PAGE)).toEqual([]);
    expect(await deliveryRecord(pruned, judge.address, job.intent)).toEqual({ deliveries: [], openings: [], complete: false, pages: 1 });
    expect(await deliveryRecord(unknown, judge.address, job.intent)).toEqual({ deliveries: [], openings: [], complete: false, pages: 1 });
    expect((await deliveryRecord(pruned, judge.address)).complete).toBe(false);
  });

  it("an empty page is complete when the node history covers the intent", async () => {
    const { w, client, judge, order } = await setting();
    w.chain.svm.warpToSlot(w.chain.svm.getClock().slot + 5n);
    const created = w.chain.svm.getClock().slot;
    const job = await client.createIntent({ ...order, params: proof(judge.address) });
    w.chain.svm.warpToSlot(created + 5n);
    const kept: Transport = { ...w.chain.transport, firstAvailableSlot: async () => created };

    expect(await w.chain.transport.signaturesOf?.(judge.address, SIGNATURE_PAGE)).toEqual([]);
    expect(await deliveryRecord(kept, judge.address, job.intent)).toEqual({ deliveries: [], openings: [], complete: true, pages: 1 });
    expect(await deliveryRecord(w.chain.transport, judge.address, job.intent)).toEqual({ deliveries: [], openings: [], complete: true, pages: 1 });
    expect((await deliveryRecord(kept, judge.address)).complete).toBe(true);
  });

  it("a short page ends the scan", async () => {
    const { w, client, judge, order } = await setting();
    const job = await client.createIntent({ ...order, params: proof(judge.address) });
    const worker = await funded(w.chain);
    await client.deliver({ worker, intent: job.intent, sha256: WORK, url: WORK_URL });
    await flood(w, judge.address, 3);
    const calls: Address[] = [];

    const record = await deliveryRecord(counted(w.chain.transport, calls), judge.address, job.intent, 1);
    expect(record).toMatchObject({ complete: true, pages: 1, deliveries: [{ worker: worker.address }] });
    expect(calls.filter((of) => of === judge.address)).toEqual([judge.address, judge.address]);
    calls.length = 0;
    const full = flooded(w, w.chain.transport, judge.address, SIGNATURE_PAGE);
    expect(await deliveryRecord(counted(full, calls), judge.address, job.intent, 1)).toEqual({ deliveries: [], openings: [], complete: false, pages: 1 });
    expect(await deliveryRecord(counted(full, calls), judge.address, job.intent, 2)).toMatchObject({ complete: true, pages: 2 });
  });

  it("a short page is confirmed by an empty page before the scan ends", async () => {
    const { w, client, judge, order } = await setting();
    const job = await client.createIntent({ ...order, params: proof(judge.address) });
    const worker = await funded(w.chain);
    await client.deliver({ worker, intent: job.intent, sha256: WORK, url: WORK_URL });
    await flood(w, judge.address, 3);
    const { signaturesOf } = w.chain.transport;
    if (signaturesOf === undefined) {
      throw new Error("the transport lists no signature pages");
    }
    const asked: (string | undefined)[] = [];
    const pruned: Transport = {
      ...w.chain.transport,
      signaturesOf: async (of, limit, before) => {
        const listed = await signaturesOf(of, limit, before);
        if (of !== judge.address) {
          return listed;
        }
        asked.push(before);
        return before === undefined ? listed.slice(0, 2) : listed;
      },
    };

    const record = await deliveryRecord(pruned, judge.address, job.intent);
    expect(record).toMatchObject({ complete: true, pages: 2, deliveries: [{ worker: worker.address, commitment: commitmentOf(job.intent, worker.address, await deliverySalt(worker, job.intent, WORK), WORK) }] });
    expect(asked).toHaveLength(3);
    expect(asked[0]).toBeUndefined();
    expect(await signaturesOf(judge.address, SIGNATURE_PAGE, asked[2])).toEqual([]);
    expect(await deliveryRecord(pruned, judge.address, job.intent, 1)).toMatchObject({ complete: false, pages: 1, deliveries: [] });
  });

  it("stops a scan at the escrow's creation and reads a transport without paging as incomplete past its window", async () => {
    const { w, client, judge, order } = await setting();
    await flood(w, judge.address, 51);
    const job = await client.createIntent({ ...order, params: proof(judge.address) });
    const worker = await funded(w.chain);
    await client.deliver({ worker, intent: job.intent, sha256: WORK, url: WORK_URL });
    w.chain.svm.warpToSlot(w.chain.svm.getClock().slot + 1n);
    const clock = w.chain.svm.getClock();
    clock.unixTimestamp += 10n;
    w.chain.svm.setClock(clock);
    const late = await client.createIntent({ ...order, params: proof(judge.address) });
    await client.deliver({ worker, intent: late.intent, sha256: WORK, url: WORK_URL });
    expect((await deliveryRecord(paged(w.chain.transport, 5), judge.address, late.intent)).complete).toBe(true);

    const { signaturesOf: _, transactionsOf: __, ...unpaged } = w.chain.transport;
    expect(await deliveryRecord(unpaged, judge.address, job.intent)).toMatchObject({ deliveries: [{ worker: worker.address }], complete: true });
    await flood(w, judge.address, DELIVERY_SCAN);
    expect(await deliveryRecord(unpaged, judge.address, job.intent)).toEqual({ deliveries: [], openings: [], complete: false, pages: 1 });
    expect((await deliveryRecord(unpaged, judge.address, late.intent)).complete).toBe(false);
  });

  it("finds the spec url after 30 later transactions name the intent", async () => {
    const { w, client, judge, order } = await setting(serving({ [SPEC_URL]: SPEC }));
    const job = await client.createIntent({ ...order, params: proof(judge.address), specUrl: SPEC_URL });
    await flood(w, job.intent, 30, (i) => (i % 2 === 0 ? [specMemo("https://evil.example/spec.md")] : []));

    expect((await client.jobs({ attestor: judge.address }))[0]).toMatchObject({ intent: job.intent, specUrl: SPEC_URL });
    expect(await client.spec(job.intent)).toMatchObject({ url: SPEC_URL, matches: true });
  });

  it("covers more than 50 open escrows of one judge", async () => {
    const { w, client, judge, order } = await setting();
    const made = [];
    for (let i = 0; i <= JOBS_LIMIT; i++) {
      made.push(await client.createIntent({ ...order, params: { ...proof(judge.address), amountIn: 1n }, expiresIn: 3_600n + BigInt(i) }));
    }
    const [soonest] = made;
    if (soonest === undefined) {
      throw new Error("no escrow was made");
    }
    expect((await client.jobs({ attestor: judge.address })).map(({ intent }) => intent)).not.toContain(soonest.intent);
    const worker = await funded(w.chain);
    await client.deliver({ worker, intent: soonest.intent, sha256: WORK, url: WORK_URL });

    expect(await client.deliveries({ judge: judge.address })).toMatchObject([{ intent: soonest.intent, worker: worker.address, commitment: commitmentOf(soonest.intent, worker.address, await deliverySalt(worker, soonest.intent, WORK), WORK) }]);
  });

  it("refuses an http spec url on devnet", async () => {
    const local = "http://127.0.0.1:8080/spec.md";
    const fetched: Fetched[] = [];
    const { w, client, judge, order } = await setting(serving({ [local]: SPEC }, fetched));
    const job = await client.createIntent({ ...order, params: proof(judge.address), specUrl: local });
    expect(await client.spec(job.intent)).toMatchObject({ url: local, matches: true });

    const devnet = createClient({ url: LOCAL, transport: { ...w.chain.transport, genesisHash: async () => DEVNET_GENESIS_HASH }, fetch: serving({ [local]: SPEC }, fetched) });
    fetched.length = 0;
    await expect(devnet.spec(job.intent)).rejects.toThrow(SpecUnreadable);
    expect(fetched).toEqual([]);
    expect((await devnet.jobs())[0]).toMatchObject({ specUrl: local });
  });

  it("cancels the body of a response it rejects before reading it", async () => {
    const cancelled: string[] = [];
    const body = (name: string) =>
      new ReadableStream<Uint8Array>({
        pull: (controller) => controller.enqueue(new Uint8Array(16)),
        cancel: () => {
          cancelled.push(name);
        },
      });
    const replies: Record<string, () => Response> = {
      "https://example.org/gone": () => new Response(body("gone"), { status: 404 }),
      "https://example.org/huge": () => new Response(body("huge"), { headers: { "content-length": String(MAX_SPEC_BYTES + 1) } }),
    };
    const { client, judge, order } = await setting(async (url) => (replies[url] ?? (() => new Response("missing", { status: 404 })))());
    for (const url of Object.keys(replies)) {
      const job = await client.createIntent({ ...order, params: proof(judge.address), specUrl: url });
      await expect(client.spec(job.intent)).rejects.toThrow(SpecUnreadable);
    }
    expect(cancelled).toEqual(["gone", "huge"]);
  });
});

describe("svm transport", () => {
  it("the svm transport reads instruction accounts from lookup tables", async () => {
    const { w, judge, order } = await setting();
    const captured: Instruction[] = [];
    const capturing: Transport = {
      ...w.chain.transport,
      send: async (instructions) => {
        captured.push(...instructions);
        return "1".repeat(88);
      },
    };
    const made = await createClient({ url: LOCAL, transport: capturing }).createIntent({ ...order, params: proof(judge.address) });
    const [eventAuthority] = await findEventAuthorityPda();
    const table = (await generateKeyPairSigner()).address;
    const listed = [made.intent, eventAuthority];
    const header = new Uint8Array(LOOKUP_TABLE_HEAD);
    const view = new DataView(header.buffer);
    view.setUint32(0, 1, true);
    view.setBigUint64(4, 0xffff_ffff_ffff_ffffn, true);
    header[20] = listed.length;
    const data = Uint8Array.from([...header, ...listed.flatMap((address) => [...getAddressEncoder().encode(address)])]);
    w.chain.svm.setAccount({
      address: table,
      data,
      executable: false,
      lamports: lamports(w.chain.svm.minimumBalanceForRentExemption(BigInt(data.length))),
      programAddress: ADDRESS_LOOKUP_TABLE_PROGRAM,
      space: BigInt(data.length),
    });
    const latest = await w.chain.transport.latestBlockhash();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(w.owner, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
      (m) => appendTransactionMessageInstructions(captured, m),
      (m) => compressTransactionMessageUsingAddressLookupTables(m, { [table]: listed }),
    );
    const signed = await signTransactionMessageWithSigners(message);
    const compiled = getCompiledTransactionMessageDecoder().decode(signed.messageBytes);
    expect("addressTableLookups" in compiled ? compiled.addressTableLookups?.map((lookup) => lookup.lookupTableAddress) : []).toEqual([table]);
    expect(compiled.staticAccounts).not.toContain(made.intent);
    const signature = await w.chain.transport.sendWire(getBase64EncodedWireTransaction(signed), latest);
    const landed = await w.chain.transport.transactionOf?.(signature);
    const calls = landed === null || landed === undefined ? [] : engineCalls(landed);
    expect(calls.some(({ inner, accounts }) => !inner && accounts?.includes(made.intent) === true)).toBe(true);
    expect(calls.some(({ inner, accounts }) => inner && accounts?.includes(eventAuthority) === true)).toBe(true);
    expect(landed === null || landed === undefined ? null : creationProof(landed, made.intent)).toEqual({ attestor: judge.address, specHash: Buffer.from(sha(SPEC)).toString("hex") });
    expect((await w.chain.transport.signaturesOf?.(made.intent, SIGNATURE_PAGE))?.map((entry) => entry.signature)).toEqual([signature]);
  });
});

describe("a sealed spec", () => {
  const keyed = () => {
    const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
    const keypair = Uint8Array.from([...Buffer.from(jwk.d ?? "", "base64url"), ...Buffer.from(jwk.x ?? "", "base64url")]);
    return { keypair, address: getAddressDecoder().decode(keypair.slice(32)) };
  };

  it("opens for an invited wallet, checks the plain spec against the committed hash, and names who may read it", async () => {
    const [worker, other, stranger] = [keyed(), keyed(), keyed()];
    const sealed = await seal(new TextEncoder().encode(SPEC), [worker.address, other.address]);
    const { client, judge, order } = await setting(serving({ [SPEC_URL]: sealed }));
    const job = await client.createIntent({ ...order, params: proof(judge.address), specUrl: SPEC_URL });
    expect(await client.spec(job.intent, worker.keypair)).toEqual({
      url: SPEC_URL,
      text: SPEC,
      bytes: expect.any(Uint8Array),
      sha256: Buffer.from(sha(SPEC)).toString("hex"),
      matches: true,
      sealedTo: [worker.address, other.address],
    });
    const unkeyed = await client.spec(job.intent).catch((e: unknown) => e);
    expect(unkeyed).toBeInstanceOf(SpecSealed);
    expect(unkeyed).toMatchObject({ url: SPEC_URL, to: [worker.address, other.address], keyed: false });
    expect((unkeyed as Error).message).toBe(`the spec at ${SPEC_URL} is sealed to 2 invited wallets; read it with the key of an invited wallet`);
    const outsider = await client.spec(job.intent, stranger.keypair).catch((e: unknown) => e);
    expect(outsider).toMatchObject({ name: "SpecSealed", keyed: true });
    expect((outsider as Error).message).toBe(`the spec at ${SPEC_URL} is sealed to 2 invited wallets; this wallet is not one of them`);
  });

  it("says when a sealed spec opens but is not the committed one, and refuses one that was changed", async () => {
    const worker = keyed();
    const other = await seal(new TextEncoder().encode("another spec"), [worker.address]);
    const broken = new TextEncoder().encode(new TextDecoder().decode(await seal(new TextEncoder().encode(SPEC), [worker.address])).replace(/"data":"(.)/, (_, first: string) => `"data":"${first === "A" ? "B" : "A"}`));
    const { client, judge, order } = await setting(serving({ [SPEC_URL]: other, "https://example.org/broken": broken }));
    const wrong = await client.createIntent({ ...order, params: proof(judge.address), specUrl: SPEC_URL });
    const changed = await client.createIntent({ ...order, params: proof(judge.address), specUrl: "https://example.org/broken" });
    expect(await client.spec(wrong.intent, worker.keypair)).toMatchObject({ text: "another spec", matches: false, sealedTo: [worker.address] });
    await expect(client.spec(changed.intent, worker.keypair)).rejects.toThrow(new SpecUnreadable("https://example.org/broken", "is sealed but could not be opened"));
    expect(await client.spec(wrong.intent, keyed().keypair).catch((e: unknown) => e)).toBeInstanceOf(SpecSealed);
  });

  it("leaves a plain spec as it was, keyed or not", async () => {
    const worker = keyed();
    const { client, judge, order } = await setting(serving({ [SPEC_URL]: SPEC }));
    const job = await client.createIntent({ ...order, params: proof(judge.address), specUrl: SPEC_URL });
    const plain = { url: SPEC_URL, text: SPEC, bytes: expect.any(Uint8Array), sha256: Buffer.from(sha(SPEC)).toString("hex"), matches: true };
    expect(await client.spec(job.intent, worker.keypair)).toEqual(plain);
    expect(await client.spec(job.intent)).toEqual(plain);
  });
});
