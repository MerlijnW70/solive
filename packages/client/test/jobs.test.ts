import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { describe, expect, it } from "vitest";
import { deliveryMemo, findIntentPda, Kind, MAX_MEMO_URL, specMemo } from "@intent-engine/core";
import {
  announcements,
  createClient,
  type Delivery,
  DELIVERY_PAGES,
  DELIVERY_SCAN,
  deliveryRecord,
  DEVNET_GENESIS_HASH,
  firstDelivery,
  JOBS_LIMIT,
  MAX_SPEC_BYTES,
  memoInstruction,
  NotDeliverable,
  SPEC_URL_NEEDS_PROOF,
  SpecUnreadable,
  type SpecFetch,
  type Transport,
} from "../src/index.js";
import { funded, world, type World } from "./svm.js";

const LOCAL = "http://127.0.0.1:8899";
const SPEC = "the acceptance spec the work must pass\n";
const SPEC_URL = "https://example.org/jobs/spec.md";
const WORK = createHash("sha256").update("the work").digest("hex");
const WORK_URL = "https://example.org/work.tar";
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
  const judge = await funded(w.chain);
  const order = { signer: w.owner, inputMint: w.inputMint, outputMint: w.outputMint };
  return { w, client, judge, order };
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

    expect(await client.spec(good.intent)).toEqual({ url: SPEC_URL, text: SPEC, sha256: Buffer.from(sha(SPEC)).toString("hex"), matches: true });
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
  it("announces a delivery to the judge and lists it, ignoring malformed, foreign and other memos", async () => {
    const { w, client, judge, order } = await setting();
    const job = await client.createIntent({ ...order, params: proof(judge.address), specUrl: SPEC_URL });
    const foreign = await client.createIntent({ ...order, params: proof(w.authority.address) });
    const worker = await funded(w.chain);
    const stranger = await funded(w.chain);

    const signature = await client.deliver({ worker, intent: job.intent, sha256: WORK, url: WORK_URL });
    await announce(w, stranger, judge.address, [
      "not a delivery",
      `delivery sha256:${WORK}`,
      `${deliveryMemo({ intent: job.intent, sha256: WORK, url: WORK_URL })} `,
      deliveryMemo({ intent: foreign.intent, sha256: WORK, url: WORK_URL }),
      deliveryMemo({ intent: judge.address, sha256: WORK, url: WORK_URL }),
      specMemo(SPEC_URL),
    ]);
    const later = await client.deliver({ worker: stranger, intent: job.intent, sha256: "cd".repeat(32), url: "https://example.org/v2" });

    const found = await client.deliveries({ judge: judge.address });
    expect(found).toEqual([
      { intent: job.intent, worker: stranger.address, sha256: "cd".repeat(32), url: "https://example.org/v2", signature: later, slot: expect.any(BigInt), blockTime: expect.any(BigInt) },
      { intent: job.intent, worker: worker.address, sha256: WORK, url: WORK_URL, signature, slot: expect.any(BigInt), blockTime: expect.any(BigInt) },
    ]);
    expect(await client.deliveries({ judge: judge.address, intent: job.intent })).toEqual(found);
    expect(await client.deliveries({ judge: judge.address, intent: foreign.intent })).toEqual([]);
    expect(await client.deliveries({ judge: w.authority.address })).toEqual([]);
    expect(DELIVERY_SCAN).toBe(100);
  });

  it("pays the earliest announcer of a hash: a copied announcement comes later and counts as a copy", async () => {
    const { w, client, judge, order } = await setting();
    const job = await client.createIntent({ ...order, params: proof(judge.address), specUrl: SPEC_URL });
    const worker = await funded(w.chain);
    const copier = await funded(w.chain);
    await client.deliver({ worker, intent: job.intent, sha256: WORK, url: WORK_URL });
    w.chain.svm.warpToSlot(w.chain.svm.getClock().slot + 1n);
    await client.deliver({ worker: copier, intent: job.intent, sha256: WORK, url: "https://example.org/stolen" });
    await client.deliver({ worker: copier, intent: job.intent, sha256: "cd".repeat(32), url: "https://example.org/own" });

    const found = await client.deliveries({ judge: judge.address, intent: job.intent });
    expect(found.map(({ worker: by }) => by)).toEqual([copier.address, copier.address, worker.address]);
    expect(firstDelivery(found, WORK)).toMatchObject({ worker: worker.address, url: WORK_URL });
    expect(firstDelivery(found, "ef".repeat(32))).toBeNull();
    expect(announcements(found).map(({ sha256, first, copies }) => [sha256, first.worker, copies])).toEqual([
      [WORK, worker.address, 1],
      ["cd".repeat(32), copier.address, 0],
    ]);
  });

  it("breaks a tie in slot by the lower signature", () => {
    const at = (worker: string, signature: string, slot: bigint) =>
      ({ intent: WORK_URL, worker, sha256: WORK, url: WORK_URL, signature, slot, blockTime: null }) as unknown as Delivery;
    const found = [at("late", "a", 5n), at("second", "c", 4n), at("first", "b", 4n)];
    expect(firstDelivery(found, WORK)?.worker).toBe("first");
    expect(firstDelivery([...found].reverse(), WORK)?.worker).toBe("first");
    expect(announcements(found)).toEqual([{ sha256: WORK, first: found[2], copies: 2 }]);
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
    await expect(client.deliver({ worker, intent: open.intent, sha256: WORK.toUpperCase(), url: WORK_URL })).rejects.toThrow(RangeError);
    await expect(client.deliver({ worker, intent: open.intent, sha256: WORK, url: "ftp://example.org/x" })).rejects.toThrow(RangeError);
    expect(await client.deliveries({ judge: judge.address })).toEqual([]);
  });
});

describe("history past a window of recent transactions", () => {
  it("names the honest announcer after 150 later judge transactions", async () => {
    const { w, client, judge, order } = await setting();
    const job = await client.createIntent({ ...order, params: proof(judge.address), specUrl: SPEC_URL });
    const worker = await funded(w.chain);
    const copier = await funded(w.chain);
    await client.deliver({ worker, intent: job.intent, sha256: WORK, url: WORK_URL });
    w.chain.svm.warpToSlot(w.chain.svm.getClock().slot + 1n);
    await flood(w, judge.address, 150);
    await client.deliver({ worker: copier, intent: job.intent, sha256: WORK, url: "https://example.org/stolen" });

    const record = await client.deliveryRecord({ judge: judge.address, intent: job.intent });
    expect(record.complete).toBe(true);
    expect(firstDelivery(record.deliveries, WORK)).toMatchObject({ worker: worker.address, url: WORK_URL });
    expect(await client.deliveries({ judge: judge.address, intent: job.intent })).toEqual(record.deliveries);
    expect(firstDelivery(await client.deliveries({ judge: judge.address }), WORK)?.worker).toBe(worker.address);
  });

  it("reports an incomplete delivery record when the page cap is reached", async () => {
    const { w, client, judge, order } = await setting();
    const job = await client.createIntent({ ...order, params: proof(judge.address) });
    const worker = await funded(w.chain);
    await client.deliver({ worker, intent: job.intent, sha256: WORK, url: WORK_URL });
    const size = 5;
    await flood(w, judge.address, DELIVERY_PAGES * size + 1);
    const capped = paged(w.chain.transport, size);

    expect(DELIVERY_PAGES).toBeGreaterThanOrEqual(10);
    const record = await deliveryRecord(capped, judge.address, job.intent);
    expect(record).toEqual({ deliveries: [], complete: false });
    expect(await createClient({ url: LOCAL, transport: capped }).deliveryRecord({ judge: judge.address })).toEqual({ deliveries: [], complete: false });
    const full = await deliveryRecord(w.chain.transport, judge.address, job.intent);
    expect(full.complete).toBe(true);
    expect(full.deliveries.map(({ worker: by }) => by)).toEqual([worker.address]);
    expect((await deliveryRecord(paged(w.chain.transport, 100), judge.address, job.intent)).complete).toBe(true);
  });

  it("stops a scan at the escrow's creation and reads a transport without paging as incomplete past its window", async () => {
    const { w, client, judge, order } = await setting();
    await flood(w, judge.address, DELIVERY_PAGES * 5 + 1);
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
    expect(await deliveryRecord(unpaged, judge.address, job.intent)).toEqual({ deliveries: [], complete: false });
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

    expect(await client.deliveries({ judge: judge.address })).toMatchObject([{ intent: soonest.intent, worker: worker.address, sha256: WORK }]);
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
