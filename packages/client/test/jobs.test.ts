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
import { Kind, splitFees } from "@intent-engine/core";
import { findEventAuthorityPda, findIntentPda, MAX_MEMO_URL, seal, SPEC_MEMO_PREFIX, specMemo } from "@intent-engine/core/internal";
import { createClient, InvalidInput, NotDeliverable, type SpecFetch, SpecSealed, SpecUnreadable, type Transport } from "../src/index.js";
import {
  DEVNET_GENESIS_HASH,
  engineCalls,
  EXPIRES_IN_RANGE,
  JOBS_LIMIT,
  MAX_EXPIRES_IN,
  MAX_SPEC_BYTES,
  MEMO_PROGRAM_ADDRESS,
  memoInstruction,
  MIN_EXPIRES_IN,
  PAY_TO_NOT_ATTESTED,
  PLAIN_HTTP_ON_PUBLIC,
  SIGNATURE_PAGE,
  SPEC_URL_NEEDS_PROOF,
} from "../src/internal.js";
import { funded, world, type World } from "./svm.js";

const LOCAL = "http://127.0.0.1:8899";
const LOOKUP_TABLE_HEAD = 56;
const ADDRESS_LOOKUP_TABLE_PROGRAM = "AddressLookupTab1e1111111111111111111111111" as Address;
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
    await client.cancel(w.owner, { owner: w.owner.address, nonce: cancelled.nonce });

    const mine = await client.jobs({ attestor: judge.address });
    expect(mine.map(({ intent }) => intent).sort()).toEqual([published.intent, silent.intent].sort());
    const feeBps = mine.find(({ intent }) => intent === published.intent)?.feeBps ?? -1;
    expect(mine.find(({ intent }) => intent === published.intent)).toEqual({
      intent: published.intent,
      owner: w.owner.address,
      nonce: published.nonce,
      attestor: judge.address,
      specHash: Buffer.from(sha(SPEC)).toString("hex"),
      specUrl: SPEC_URL,
      sells: 100n,
      judgeFee: 0n,
      net: splitFees(100n, feeBps, 0, 0).net,
      feeBps: expect.any(Number),
      inputMint: w.inputMint,
      expiresAt: expect.any(BigInt),
    });
    expect(mine.find(({ intent }) => intent === silent.intent)?.specUrl).toBeNull();
    expect((await client.jobs()).map(({ intent }) => intent).sort()).toEqual([published.intent, silent.intent, elsewhere.intent].sort());
  });

  it("fits the longest spec url in a first create that also registers the owner, and takes no payTo on a proof escrow", async () => {
    const { client, judge, order } = await setting();
    const payTo = (await generateKeyPairSigner()).address;
    const longest = "https://example.org/" + "s".repeat(MAX_MEMO_URL - 20);
    expect(longest).toHaveLength(MAX_MEMO_URL);
    await expect(client.createIntent({ ...order, payTo, params: proof(judge.address), specUrl: longest })).rejects.toMatchObject({ field: "payTo", rule: "unsupported", message: PAY_TO_NOT_ATTESTED });
    const made = await client.createIntent({ ...order, params: proof(judge.address), specUrl: longest });
    expect((await client.jobs())[0]).toMatchObject({ intent: made.intent, specUrl: longest });
  });

  it("refuses a spec url on anything but a proof escrow, or one that is not an https url", async () => {
    const { client, judge, order } = await setting();
    const swap = { kind: Kind.SwapExactIn, amountIn: 10n, minOut: 1n } as const;
    const unproven = { ...order, params: swap, specUrl: SPEC_URL } as unknown as Parameters<typeof client.createIntent>[0];
    await expect(client.createIntent(unproven)).rejects.toThrow(SPEC_URL_NEEDS_PROOF);
    const plain = { ...proof(judge.address), specHash: new Uint8Array(32) };
    await expect(client.createIntent({ ...order, params: plain, specUrl: SPEC_URL })).rejects.toThrow(SPEC_URL_NEEDS_PROOF);
    await expect(client.createIntent({ ...order, params: proof(judge.address), specUrl: "http://example.org/spec" })).rejects.toThrow(InvalidInput);
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
    expect(() => specMemo(legacy)).toThrow(InvalidInput);
    const job = await client.createIntent({ ...order, params: proof(judge.address), specUrl: SPEC_URL });
    expect((await client.jobs())[0]).toMatchObject({ intent: job.intent, specUrl: legacy });
    expect(await client.jobs({ attestor: judge.address })).toMatchObject([{ intent: job.intent, specUrl: legacy }]);
    expect(await client.spec(job.intent)).toEqual({ url: legacy, text: SPEC, bytes: expect.any(Uint8Array), sha256: Buffer.from(sha(SPEC)).toString("hex"), matches: true });
    expect(fetched.map(({ url }) => url)).toEqual([legacy]);
  });

  it("refuses to announce to anything but an open proof escrow, and a bad hash or url", async () => {
    const { w, client, judge, order } = await setting();
    const worker = await funded(w.chain);
    const swap = await client.createIntent({ ...order, params: { kind: Kind.SwapExactIn, amountIn: 10n, minOut: 1n } });
    const plain = await client.createIntent({ ...order, params: { ...proof(judge.address), specHash: new Uint8Array(32) } });
    const closed = await client.createIntent({ ...order, params: proof(judge.address) });
    await client.cancel(w.owner, { owner: w.owner.address, nonce: closed.nonce });
    const [unused] = await findIntentPda({ owner: w.owner.address, nonce: 99n });
    for (const intent of [swap.intent, plain.intent, closed.intent, unused, judge.address]) {
      await expect(client.announce({ worker, intent, sha256: WORK, url: WORK_URL })).rejects.toThrow(NotDeliverable);
    }
    const open = await client.createIntent({ ...order, params: proof(judge.address) });
    await expect(client.announce({ worker, intent: open.intent, sha256: "zz".repeat(32), url: WORK_URL })).rejects.toThrow(InvalidInput);
    await expect(client.announce({ worker, intent: open.intent, sha256: WORK, url: "ftp://example.org/x" })).rejects.toThrow(InvalidInput);
    expect(await client.announcementsTo(judge.address)).toEqual([]);
  });
  it("uppercase sha256 is accepted", async () => {
    const { w, client, judge, keypair, order } = await setting();
    const job = await client.createIntent({ ...order, params: proof(judge.address), specUrl: SPEC_URL });
    const worker = await funded(w.chain);
    await client.announce({ worker, intent: job.intent, sha256: WORK.toUpperCase(), url: WORK_URL });
    const first = await client.firstOpening({ intent: job.intent, sha256: WORK.toUpperCase(), keypair });
    expect(first).toMatchObject({ intent: job.intent, worker: worker.address, sha256: WORK });
    const signature = await client.settleProof({ judge, intent: { owner: w.owner.address, nonce: job.nonce }, announcement: first.announcement, opening: { ...first, sha256: WORK.toUpperCase() }, result: 1n });
    const released = (await client.history(job.intent)).events.find(({ name }) => name === "IntentAttested");
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
    await expect(devnet.announce({ worker, intent: job.intent, sha256: WORK, url: work })).rejects.toThrow(`the work url ${work} ${PLAIN_HTTP_ON_PUBLIC}`);
    expect(await devnet.announcementsTo(judge.address)).toEqual([]);
    const local = createClient({ url: LOCAL, transport: w.chain.transport });
    await local.announce({ worker, intent: job.intent, sha256: WORK, url: work });
    expect(await local.firstOpening({ intent: job.intent, sha256: WORK, keypair })).toMatchObject({ worker: worker.address, url: work });
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
  it("names the honest announcer from accounts alone, after 150 later judge transactions and with no history to read", async () => {
    const { w, client, judge, keypair, order } = await setting();
    const job = await client.createIntent({ ...order, params: proof(judge.address), specUrl: SPEC_URL });
    const worker = await funded(w.chain);
    const copier = await funded(w.chain);
    await client.announce({ worker, intent: job.intent, sha256: WORK, url: WORK_URL });
    await flood(w, judge.address, 150);
    await client.announce({ worker: copier, intent: job.intent, sha256: WORK, url: "https://example.org/stolen" });
    const refuse = async (): Promise<never> => {
      throw new Error("history is not read");
    };
    const { signaturesOf: _, transactionsOf: __, transactionOf: ___, ...accountsOnly } = w.chain.transport;
    const blind = createClient({ url: LOCAL, transport: { ...accountsOnly, engineTransactions: refuse } });
    expect(await blind.announcements(job.intent)).toMatchObject({ complete: true, nextSeq: 3n });
    expect(await blind.firstOpening({ intent: job.intent, sha256: WORK, keypair })).toMatchObject({ worker: worker.address, seq: 1n });
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
    const announcedTo = await client.announce({ worker, intent: soonest.intent, sha256: WORK, url: WORK_URL });

    expect(await client.announcementsTo(judge.address)).toMatchObject([{ address: announcedTo.announcement, intent: soonest.intent, worker: worker.address }]);
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
    await expect(client.spec(changed.intent, worker.keypair)).rejects.toThrow(new SpecUnreadable("https://example.org/broken", "is sealed but could not be opened: the sealed file or its list of wallets was changed, or it was not sealed to this key"));
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
