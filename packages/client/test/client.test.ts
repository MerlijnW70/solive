import {
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  type Instruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type SignatureBytes,
  type TransactionPartialSigner,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { FailedTransactionMetadata } from "litesvm";
import { describe, expect, it, vi } from "vitest";
import {
  buildCancelIntent,
  buildCreateIntent,
  buildInitUser,
  COMPUTE_BUDGET_ADDRESS,
  computeUnitLimit,
  findIntentPda,
  headroom,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  IntentStatus,
  Kind,
} from "@intent-engine/core";
import {
  createClient,
  ENGINE_ERRORS,
  type IntentAccount,
  type Notifications,
  type RpcLike,
  rpcTransport,
  type Transport,
} from "../src/index.js";
import { FEE_BPS, NOW, world, type World } from "./svm.js";

const ESCROW = 400n;
const LOCAL = "http://127.0.0.1:8899";

async function create(w: World, client: ReturnType<typeof createClient>, nonce: bigint, expiresAt = NOW + 3_600n) {
  const config = await client.config();
  return buildCreateIntent({
    owner: w.owner,
    treasury: config.feeRecipient,
    maxCreateFee: config.createFee,
    maxBounty: config.crankBounty,
    nonce,
    params: { kind: Kind.SwapExactIn, amountIn: ESCROW, minOut: 50n },
    expiresAt,
    inputMint: w.inputMint,
    outputMint: w.outputMint,
    inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
    outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
}

const cancel = (w: World, nonce: bigint) =>
  buildCancelIntent({ owner: w.owner, nonce, inputMint: w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });

const until = async (check: () => boolean) => {
  for (let tries = 0; !check(); tries++) {
    if (tries > 500) {
      throw new Error("condition never held");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

function countingReads(inner: Transport) {
  let reads = 0;
  const transport: Transport = {
    ...inner,
    intents: async (...args) => {
      reads++;
      return inner.intents(...args);
    },
  };
  return { transport, reads: () => reads };
}

const twoMoreReads = async (counted: { reads: () => number }) => {
  const at = counted.reads();
  await until(() => counted.reads() >= at + 2);
};

describe("a client over the engine", () => {
  it("reads the config, sends a create with a compute budget and reads the intent back", async () => {
    const w = await world();
    const client = createClient({ url: LOCAL, transport: w.chain.transport });
    expect(client.transport).toBe(w.chain.transport);
    expect(client.url).toBe(LOCAL);

    const config = await client.config();
    expect(config.feeRecipient).toBe(w.feeRecipient.address);
    expect(config.feeBps).toBe(FEE_BPS);

    expect(await client.nextNonce(w.owner.address)).toBe(0n);
    expect(await client.intent(w.owner.address, 0n)).toBeNull();
    await client.send([await buildInitUser({ owner: w.owner })], w.owner);
    expect(await client.nextNonce(w.owner.address)).toBe(0n);

    const signature = await client.send([await create(w, client, 0n)], w.owner);
    expect(w.chain.sent.at(-1)).toBe(signature);
    expect(await client.nextNonce(w.owner.address)).toBe(1n);

    const [address] = await findIntentPda({ owner: w.owner.address, nonce: 0n });
    const found = await client.intent(w.owner.address, 0n);
    expect(found?.address).toBe(address);
    expect(found?.intent).toMatchObject({ owner: w.owner.address, nonce: 0n, escrowed: ESCROW, status: IntentStatus.Open });

    await client.send([await create(w, client, 1n)], w.owner);
    await client.send([await cancel(w, 1n)], w.owner);
    expect(await client.nextNonce(w.owner.address)).toBe(2n);

    const all = await client.intents();
    expect(all.map((i) => i.intent.nonce).sort()).toEqual([0n, 1n]);
    expect((await client.intents({ owner: w.owner.address, status: IntentStatus.Open })).map((i) => i.address)).toEqual([address]);
    expect((await client.intents({ status: IntentStatus.Cancelled })).map((i) => i.intent.nonce)).toEqual([1n]);
    expect(await client.intents({ owner: w.feeRecipient.address })).toEqual([]);
  });

  it("budgets compute from a simulation and keeps a budget the caller already set", async () => {
    const w = await world();
    const sent: Instruction[][] = [];
    const inner = w.chain.transport;
    const client = createClient({
      url: LOCAL,
      transport: { ...inner, send: async (instructions, payer) => (sent.push([...instructions]), inner.send(instructions, payer)) },
    });
    const register = [await buildInitUser({ owner: w.owner })];
    const simulation = await client.simulate(register, w.owner);
    expect(simulation.err).toBeNull();
    const consumed = simulation.unitsConsumed ?? 0n;
    expect(consumed).toBeGreaterThan(0n);

    await client.send(register, w.owner);
    const ours = sent[0] ?? [];
    const limit = ours.at(-1);
    expect(limit?.programAddress).toBe(COMPUTE_BUDGET_ADDRESS);
    expect(ours.slice(0, -1)).toEqual(register);
    const units = new DataView((limit?.data ?? new Uint8Array(5)).buffer).getUint32(1, true);
    expect(units).toBeGreaterThanOrEqual(headroom(consumed - 1_000n));
    expect(units).toBeLessThanOrEqual(headroom(consumed));

    const preset = [computeUnitLimit(300_000), await create(w, client, 0n)];
    await client.send(preset, w.owner);
    expect(sent[1]).toEqual(preset);
  });

  it("explains a real failed send with the engine's error table", async () => {
    const w = await world();
    const client = createClient({ url: LOCAL, transport: w.chain.transport });
    await client.send([await buildInitUser({ owner: w.owner })], w.owner);
    const expired = [await create(w, client, 0n, NOW - 1n)];

    const simulation = await client.simulate(expired, w.owner);
    expect(simulation.err).not.toBeNull();
    expect(client.explain({ message: simulation.err, logs: simulation.logs })).toEqual(client.explain(simulation.logs.join("\n")));

    const failure = await client.send(expired, w.owner).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    const explained = client.explain(failure);
    expect(explained).not.toBeNull();
    expect(explained).toEqual(ENGINE_ERRORS.get(explained?.code ?? -1));
    expect(explained?.name).toBe("ExpiryNotInFuture");
    expect(await client.intent(w.owner.address, 0n)).toBeNull();
  });

  it("watches intents by polling the transport until the signal aborts", async () => {
    const w = await world();
    const counted = countingReads(w.chain.transport);
    const client = createClient({ url: LOCAL, transport: counted.transport, pollMs: 5 });
    await client.send([await buildInitUser({ owner: w.owner })], w.owner);
    await client.send([await create(w, client, 0n)], w.owner);

    const seen: IntentAccount[][] = [];
    const controller = new AbortController();
    const watching = client.watch((changed) => seen.push(changed), controller.signal, { owner: w.owner.address });
    await until(() => seen.length === 1);
    expect(seen[0]?.map((c) => [c.intent.nonce, c.intent.status])).toEqual([[0n, IntentStatus.Open]]);

    await client.send([await create(w, client, 1n)], w.owner);
    await until(() => seen.length === 2);
    expect(seen[1]?.map((c) => [c.intent.nonce, c.intent.status])).toEqual([[1n, IntentStatus.Open]]);

    await client.send([await cancel(w, 0n)], w.owner);
    await until(() => seen.length === 3);
    expect(seen[2]?.map((c) => [c.intent.nonce, c.intent.status])).toEqual([[0n, IntentStatus.Cancelled]]);

    controller.abort();
    await watching;
    const reads = counted.reads();
    await client.send([await cancel(w, 1n)], w.owner);
    expect(seen).toHaveLength(3);
    expect(counted.reads()).toBe(reads);
  });

  it("watches intents through program notifications when it has them", async () => {
    const w = await world();
    await w.chain.transport.send([await buildInitUser({ owner: w.owner })], w.owner);
    const pending: unknown[] = [];
    let push: (() => void) | undefined;
    const notifications: Notifications = async (signal) => ({
      async *[Symbol.asyncIterator]() {
        while (!signal.aborted) {
          const next = pending.shift();
          if (next === undefined) {
            await new Promise<void>((resolve) => {
              push = resolve;
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
            continue;
          }
          yield next;
        }
      },
    });
    const client = createClient({ url: LOCAL, transport: w.chain.transport, notifications });
    const seen: IntentAccount[][] = [];
    const controller = new AbortController();
    const watching = client.watch((changed) => seen.push(changed), controller.signal);

    await client.send([await create(w, client, 0n)], w.owner);
    const [address] = await findIntentPda({ owner: w.owner.address, nonce: 0n });
    const account = w.chain.svm.getAccount(address);
    const data = Buffer.from(account.exists ? account.data : []).toString("base64");
    pending.push({ value: { pubkey: address, account: { data: [data, "base64"] } } });
    push?.();
    await until(() => seen.flat().some((c) => c.address === address));
    expect(seen.flat().find((c) => c.address === address)?.intent.status).toBe(IntentStatus.Open);

    controller.abort();
    await watching;
  });

  it("recovers every change its notifications never deliver by resyncing from the chain", async () => {
    const w = await world();
    await w.chain.transport.send([await buildInitUser({ owner: w.owner })], w.owner);
    const silent: Notifications = async (signal) => ({
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    });
    const client = createClient({ url: LOCAL, transport: w.chain.transport, notifications: silent, resyncSeconds: 0.02 });
    const statuses: [bigint, number][] = [];
    const controller = new AbortController();
    const watching = client.watch((changed) => statuses.push(...changed.map((c): [bigint, number] => [c.intent.nonce, c.intent.status])), controller.signal, {
      owner: w.owner.address,
    });

    await client.send([await create(w, client, 0n)], w.owner);
    await until(() => statuses.length === 1);
    await client.send([await cancel(w, 0n)], w.owner);
    await until(() => statuses.length === 2);
    expect(statuses).toEqual([
      [0n, IntentStatus.Open],
      [0n, IntentStatus.Cancelled],
    ]);

    controller.abort();
    await watching;
  });

  it("reports an intent whose account closes once, with its last known state", async () => {
    const w = await world();
    const counted = countingReads(w.chain.transport);
    const client = createClient({ url: LOCAL, transport: counted.transport, pollMs: 5 });
    await client.send([await buildInitUser({ owner: w.owner })], w.owner);
    await client.send([await create(w, client, 0n)], w.owner);
    const [address] = await findIntentPda({ owner: w.owner.address, nonce: 0n });

    const closed: IntentAccount[][] = [];
    const statuses: number[] = [];
    const controller = new AbortController();
    const watching = client.watch(
      (changed, gone) => {
        statuses.push(...changed.filter((c) => c.address === address).map((c) => c.intent.status));
        if (gone.length > 0) {
          closed.push(gone);
        }
      },
      controller.signal,
      { owner: w.owner.address },
    );
    await until(() => statuses.includes(IntentStatus.Open));
    await client.send([await cancel(w, 0n)], w.owner);
    await until(() => statuses.includes(IntentStatus.Cancelled));
    await client.close(w.owner, w.owner.address, 0n);
    await until(() => closed.length === 1);
    await twoMoreReads(counted);
    expect(closed.map((gone) => gone.map((c) => [c.address, c.intent.nonce, c.intent.status]))).toEqual([[[address, 0n, IntentStatus.Cancelled]]]);
    expect(await client.intent(w.owner.address, 0n)).toBeNull();

    controller.abort();
    await watching;
  });

  it("calls back once after its first read even when the wallet has no intents", async () => {
    const w = await world();
    const counted = countingReads(w.chain.transport);
    const client = createClient({ url: LOCAL, transport: counted.transport, pollMs: 5 });
    const calls: [IntentAccount[], IntentAccount[]][] = [];
    const controller = new AbortController();
    const watching = client.watch((changed, gone) => calls.push([changed, gone]), controller.signal, { owner: w.owner.address });
    await until(() => calls.length === 1);
    await twoMoreReads(counted);
    expect(calls).toEqual([[[], []]]);

    await client.send([await buildInitUser({ owner: w.owner })], w.owner);
    await client.send([await create(w, client, 0n)], w.owner);
    await until(() => calls.length === 2);
    expect(calls[1]?.[0].map((c) => [c.intent.nonce, c.intent.status])).toEqual([[0n, IntentStatus.Open]]);
    controller.abort();
    await watching;
  });

  it("calls back once after its first read through notifications too", async () => {
    const w = await world();
    const silent: Notifications = async (signal) => ({
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    });
    const counted = countingReads(w.chain.transport);
    const client = createClient({ url: LOCAL, transport: counted.transport, notifications: silent, resyncSeconds: 0.01 });
    const calls: number[] = [];
    const controller = new AbortController();
    const watching = client.watch((changed, gone) => calls.push(changed.length + gone.length), controller.signal);
    await until(() => calls.length === 1);
    await twoMoreReads(counted);
    expect(calls).toEqual([0]);
    controller.abort();
    await watching;
  });

  it("keeps watching through failed reads instead of rejecting", async () => {
    const w = await world();
    let failures = 3;
    const flaky = {
      ...w.chain.transport,
      intents: async (owner?: Parameters<typeof w.chain.transport.intents>[0]) => {
        if (failures > 0) {
          failures--;
          throw new Error("429 Too Many Requests");
        }
        return w.chain.transport.intents(owner);
      },
    };
    const client = createClient({ url: LOCAL, transport: flaky, pollMs: 5 });
    await client.send([await buildInitUser({ owner: w.owner })], w.owner);
    await client.send([await create(w, client, 0n)], w.owner);

    const seen: IntentAccount[][] = [];
    const controller = new AbortController();
    const watching = client.watch((changed) => seen.push(changed), controller.signal, { owner: w.owner.address });
    await until(() => seen.length === 1);
    expect(failures).toBe(0);
    expect(seen[0]?.map((c) => c.intent.status)).toEqual([IntentStatus.Open]);

    controller.abort();
    await expect(watching).resolves.toBeUndefined();
  });

  it("returns at once when watching with a signal already aborted", async () => {
    const w = await world();
    const client = createClient({ url: LOCAL, transport: w.chain.transport });
    const seen: IntentAccount[][] = [];
    await client.watch((changed) => seen.push(changed), AbortSignal.abort());
    expect(seen).toEqual([]);
  });
});

describe("a client that holds up", () => {
  it("a send calls each signer once", async () => {
    const w = await world();
    let signed = 0;
    const counting: TransactionPartialSigner = {
      address: w.owner.address,
      signTransactions: async (transactions, config) => {
        signed += 1;
        return w.owner.signTransactions(transactions, config);
      },
    };
    const client = createClient({ url: LOCAL, transport: w.chain.transport });
    await client.send([await buildInitUser({ owner: counting })], counting);
    expect(signed).toBe(1);
    await client.send([await create(w, client, 0n)], w.owner);
    expect((await client.intent(w.owner.address, 0n))?.intent.status).toBe(IntentStatus.Open);
  });

  it("watch does not report an intent closed from a stale resync", async () => {
    const w = await world();
    const local = createClient({ url: LOCAL, transport: w.chain.transport });
    await local.send([await buildInitUser({ owner: w.owner })], w.owner);
    await local.send([await create(w, local, 0n)], w.owner);
    const [address] = await findIntentPda({ owner: w.owner.address, nonce: 0n });
    const account = w.chain.svm.getAccount(address);
    const data = Buffer.from(account.exists ? account.data : []).toString("base64");
    const entry = { pubkey: address, account: { data: [data, "base64"] as const } };
    const asked: (bigint | undefined)[] = [];
    let stale = 1;
    const rpc = {
      getProgramAccounts: (_program: unknown, config: { minContextSlot?: bigint; withContext?: true }) => ({
        send: async () => {
          asked.push(config.minContextSlot);
          const caughtUp = config.minContextSlot !== undefined && stale-- <= 0;
          const slot = asked.length === 1 ? 90n : caughtUp ? 101n : 95n;
          const value = caughtUp ? [entry] : [];
          return config.withContext === true ? { context: { slot }, value } : value;
        },
      }),
    } as unknown as RpcLike;
    const notifications: Notifications = async (signal) => ({
      async *[Symbol.asyncIterator]() {
        while (asked.length === 0 && !signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        yield { context: { slot: 100n }, value: { pubkey: address, account: { data: [data, "base64"] } } };
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    });
    const client = createClient({ url: LOCAL, transport: rpcTransport(rpc, async () => undefined), notifications, resyncSeconds: 0.02 });
    const changed: string[] = [];
    const closed: string[] = [];
    const controller = new AbortController();
    const watching = client.watch(
      (fresh, gone) => {
        changed.push(...fresh.map((c) => c.address));
        closed.push(...gone.map((c) => c.address));
      },
      controller.signal,
    );
    await until(() => asked.filter((slot) => slot !== undefined && slot >= 100n).length >= 3);
    controller.abort();
    await watching;
    expect(asked.slice(1, 3)).toEqual([100n, 100n]);
    expect(changed).toEqual([address]);
    expect(closed).toEqual([]);
  });

  it("watch reports failed reads to onError", async () => {
    const refused = new Error("getProgramAccounts is disabled on this node");
    const transport = {
      intents: async () => {
        throw refused;
      },
    } as unknown as Transport;
    const client = createClient({ url: LOCAL, transport, pollMs: 5 });
    const errors: unknown[] = [];
    const calls: number[] = [];
    const controller = new AbortController();
    const watching = client.watch((fresh) => calls.push(fresh.length), controller.signal, { onError: (error) => errors.push(error) });
    await until(() => errors.length >= 2);
    controller.abort();
    await expect(watching).resolves.toBeUndefined();
    expect(errors.every((error) => error === refused)).toBe(true);
    expect(calls).toEqual([]);
  });

  it("svm simulate restores the caller's settings", async () => {
    const w = await world();
    const { svm, transport } = w.chain;
    const unsigned = (amount: bigint, blockhash: string) => {
      const compiled = compileTransaction(
        pipe(
          createTransactionMessage({ version: 0 }),
          (m) => setTransactionMessageFeePayer(w.owner.address, m),
          (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash as Blockhash, lastValidBlockHeight: 0n }, m),
          (m) =>
            appendTransactionMessageInstructions(
              [getTransferSolInstruction({ source: w.owner, destination: w.feeRecipient.address, amount })],
              m,
            ),
        ),
      );
      return { ...compiled, signatures: { [w.owner.address]: new Uint8Array(64) as SignatureBytes } };
    };
    const stale = "11111111111111111111111111111111";

    svm.withSigverify(false).withBlockhashCheck(false);
    expect((await transport.simulate(getBase64EncodedWireTransaction(unsigned(1n, stale)))).err).toBeNull();
    expect(svm.sendTransaction(unsigned(2n, stale))).not.toBeInstanceOf(FailedTransactionMetadata);

    svm.withSigverify(true).withBlockhashCheck(true);
    expect((await transport.simulate(getBase64EncodedWireTransaction(unsigned(3n, stale)))).err).toBeNull();
    const broken = vi.spyOn(svm, "simulateTransaction").mockImplementation(() => {
      throw new Error("simulation crashed");
    });
    await expect(transport.simulate(getBase64EncodedWireTransaction(unsigned(4n, stale)))).rejects.toThrow("simulation crashed");
    broken.mockRestore();
    expect(svm.sendTransaction(unsigned(5n, svm.latestBlockhash()))).toBeInstanceOf(FailedTransactionMetadata);
  });
});

describe("explaining errors", () => {
  const client = createClient({ url: "http://127.0.0.1:1" });
  const engine = `Program ${INTENT_ENGINE_PROGRAM_ADDRESS} failed: custom program error: 0x1773`;

  it("maps engine custom program errors to the IDL entry", () => {
    expect(client.explain(new Error("custom program error: 0x1773"))).toEqual({ code: 6003, name: "NonCanonical", message: "non canonical" });
    expect(client.explain("custom program error: 0x1770")?.name).toBe("Overflow");
    expect(client.explain({ context: { code: 6003 } })?.code).toBe(6003);
    expect(client.explain(new Error("send failed", { cause: { context: { code: 6000 } } }))?.name).toBe("Overflow");
    expect(client.explain(new Error("transaction failed: { InstructionError: [ 0, { Custom: 6003 } ] }"))?.code).toBe(6003);
    expect(client.explain({ message: "simulation failed", logs: ["Program log: x", engine] })?.code).toBe(6003);
  });

  it("returns null for anything the engine did not raise", () => {
    expect(client.explain(new Error("unrelated"))).toBeNull();
    expect(client.explain(null)).toBeNull();
    expect(client.explain(42)).toBeNull();
    expect(client.explain(new Error("custom program error: 0x1"))).toBeNull();
    expect(client.explain({ code: "ECONNREFUSED" })).toBeNull();
    expect(
      client.explain(new Error("Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA failed: custom program error: 0x1773")),
    ).toBeNull();
  });

  it("knows every error in the engine's IDL", () => {
    expect([...ENGINE_ERRORS.keys()].every((code) => code >= 6000)).toBe(true);
    expect(ENGINE_ERRORS.get(6003)?.name).toBe("NonCanonical");
  });
});
