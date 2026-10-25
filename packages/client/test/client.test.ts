import type { Instruction } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { IntentStatus } from "@intent-engine/core";
import {
  buildInitUser,
  COMPUTE_BUDGET_ADDRESS,
  computeUnitLimit,
  findIntentPda,
  headroom,
} from "@intent-engine/core/internal";
import { createClient, type IntentAccount, type Notifications } from "../src/index.js";
import { ENGINE_ERRORS } from "../src/internal.js";
import { FEE_BPS, NOW, world } from "./svm.js";
import { cancel, countingReads, create, ESCROW, LOCAL, twoMoreReads, until } from "./engine-client.js";

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
    expect(await client.intent({ owner: w.owner.address, nonce: 0n })).toBeNull();
    await client.send([await buildInitUser({ owner: w.owner })], w.owner);
    expect(await client.nextNonce(w.owner.address)).toBe(0n);

    const signature = await client.send([await create(w, client, 0n)], w.owner);
    expect(w.chain.sent.at(-1)).toBe(signature);
    expect(await client.nextNonce(w.owner.address)).toBe(1n);

    const [address] = await findIntentPda({ owner: w.owner.address, nonce: 0n });
    const found = await client.intent({ owner: w.owner.address, nonce: 0n });
    expect(found?.address).toBe(address);
    expect(found?.intent).toMatchObject({ owner: w.owner.address, nonce: 0n, escrowed: ESCROW, status: IntentStatus.Open });

    await client.send([await create(w, client, 1n)], w.owner);
    await client.send([await cancel(w, 1n)], w.owner);
    expect(await client.nextNonce(w.owner.address)).toBe(2n);

    const { intents: all } = await client.intents();
    expect(all.map((i) => i.intent.nonce).sort()).toEqual([0n, 1n]);
    expect((await client.intents({ owner: w.owner.address, status: IntentStatus.Open })).intents.map((i) => i.address)).toEqual([address]);
    expect((await client.intents({ status: IntentStatus.Cancelled })).intents.map((i) => i.intent.nonce)).toEqual([1n]);
    expect((await client.intents({ owner: w.feeRecipient.address })).intents).toEqual([]);
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
    expect(await client.intent({ owner: w.owner.address, nonce: 0n })).toBeNull();
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
    await client.close(w.owner, { owner: w.owner.address, nonce: 0n });
    await until(() => closed.length === 1);
    await twoMoreReads(counted);
    expect(closed.map((gone) => gone.map((c) => [c.address, c.intent.nonce, c.intent.status]))).toEqual([[[address, 0n, IntentStatus.Cancelled]]]);
    expect(await client.intent({ owner: w.owner.address, nonce: 0n })).toBeNull();

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
