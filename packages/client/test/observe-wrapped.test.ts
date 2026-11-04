import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import type { Address } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { describe, expect, it } from "vitest";
import { type ClientEventName, type ClientHooks, createClient, type Transport } from "../src/index.js";
import { memoized } from "../src/memoized-transport.js";
import { observedTransport, observerOf } from "../src/internal.js";
import { BlockhashExpired, MaybeSent } from "../src/send-errors.js";
import { createTestWorld, type TestWorld, testSignature } from "../src/testing.js";

const NAMES: readonly ClientEventName[] = ["request", "response", "retry", "send", "confirm", "fetch"];
const NODE = "https://" + "rpc.example";

function recorder() {
  const seen: { kind: ClientEventName; event: Record<string, unknown> }[] = [];
  const hooks = Object.fromEntries(NAMES.map((kind) => [kind, (event: Record<string, unknown>) => void seen.push({ kind, event })])) as ClientHooks;
  return { seen, hooks, of: (kind: ClientEventName) => seen.filter((entry) => entry.kind === kind).map((entry) => entry.event) };
}

async function pay(world: TestWorld, wrap: (transport: Transport) => Transport, amount = 1_000_000n) {
  const heard = recorder();
  const payer = await world.wallet();
  const to = await world.wallet(0);
  const client = createClient({ url: NODE, transport: wrap(world.transport), hooks: heard.hooks });
  const send = client.send([getTransferSolInstruction({ source: payer, destination: to.address, amount })], payer);
  return { heard, payer, send };
}

describe("hooks on a wrapped transport", () => {
  it("hears the send and its confirm through a memoized transport", async () => {
    const world = await createTestWorld();
    const { heard, payer, send } = await pay(world, memoized);
    const signature = await send;
    expect(heard.of("send")).toEqual([expect.objectContaining({ signature, payer: payer.address })]);
    expect(heard.of("confirm")).toEqual([expect.objectContaining({ signature, outcome: "confirmed" })]);
    expect(heard.of("request").length).toBeGreaterThan(0);
  });

  it("hears each send and confirm once through a transport copied member by member", async () => {
    const world = await createTestWorld();
    const { heard, payer, send } = await pay(world, (transport) => ({ ...transport }));
    const signature = await send;
    expect(heard.of("send")).toEqual([expect.objectContaining({ signature, payer: payer.address, instructions: 2 })]);
    expect(heard.of("confirm")).toEqual([expect.objectContaining({ signature, outcome: "confirmed" })]);
  });

  it("hears each send and confirm once through a memoized copy of a copy", async () => {
    const world = await createTestWorld();
    const { heard, send } = await pay(world, (transport) => memoized({ ...transport }));
    const signature = await send;
    expect(heard.of("send")).toEqual([expect.objectContaining({ signature })]);
    expect(heard.of("confirm")).toEqual([expect.objectContaining({ signature, outcome: "confirmed" })]);
  });

  it("reports a failed on-chain send through a wrapped transport as failed with its signature", async () => {
    const world = await createTestWorld();
    const { heard, send } = await pay(world, (transport) => ({ ...transport }), 1_000_000_000_000n);
    const failure = (await send.then(() => undefined, (error: unknown) => error)) as { signature: string };
    expect(heard.of("send")).toHaveLength(1);
    expect(heard.of("confirm")).toEqual([expect.objectContaining({ signature: failure.signature, outcome: "failed" })]);
  });

  it("hears a signed wire sent or submitted through a copied transport", async () => {
    const world = await createTestWorld();
    const heard = recorder();
    const { transport } = createClient({ url: NODE, transport: { ...world.transport }, hooks: heard.hooks });
    const payer = await world.wallet();
    const to = await world.wallet(0);
    const signedWire = async (amount: bigint) => {
      const latest = await world.transport.latestBlockhash();
      const signed = await signTransactionMessageWithSigners(
        pipe(
          createTransactionMessage({ version: 0 }),
          (m) => setTransactionMessageFeePayerSigner(payer, m),
          (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
          (m) => appendTransactionMessageInstructions([getTransferSolInstruction({ source: payer, destination: to.address, amount })], m),
        ),
      );
      return { wire: getBase64EncodedWireTransaction(signed), latest, signature: getSignatureFromTransaction(signed) };
    };
    const first = await signedWire(1_000_000n);
    await transport.sendWire(first.wire, first.latest);
    expect(heard.of("send")).toEqual([expect.objectContaining({ signature: first.signature, lastValidBlockHeight: first.latest.lastValidBlockHeight })]);
    expect(heard.of("confirm")).toEqual([expect.objectContaining({ signature: first.signature, outcome: "confirmed" })]);
    const second = await signedWire(2_000_000n);
    await transport.submitWire(second.wire);
    expect(heard.of("send").at(-1)).toMatchObject({ signature: second.signature, lastValidBlockHeight: null });
    expect(heard.of("send")).toHaveLength(2);
    expect(heard.of("confirm")).toHaveLength(1);
  });

  it("reports a send that fails after broadcast with the signature its error carries, and none when the error has none", async () => {
    const world = await createTestWorld();
    const payer = await world.wallet();
    const to = await world.wallet(0);
    const signature = testSignature("late");
    const failing = (error: Error): Transport => ({ ...world.transport, send: async () => Promise.reject(error) });
    const ix = getTransferSolInstruction({ source: payer, destination: to.address, amount: 1_000_000n });
    const unknown = recorder();
    await expect(createClient({ url: NODE, transport: failing(new MaybeSent(signature, null, "maybe")), hooks: unknown.hooks }).send([ix], payer)).rejects.toBeInstanceOf(MaybeSent);
    expect(unknown.of("send")).toEqual([expect.objectContaining({ signature })]);
    expect(unknown.of("confirm")).toEqual([expect.objectContaining({ signature, outcome: "unknown" })]);
    const expired = recorder();
    await expect(createClient({ url: NODE, transport: failing(new BlockhashExpired("gone")), hooks: expired.hooks }).send([ix], payer)).rejects.toBeInstanceOf(BlockhashExpired);
    expect(expired.of("send")).toEqual([]);
    expect(expired.of("confirm")).toEqual([]);
  });

  it("keeps a class signer, a signer a wrapper captured and an instruction without accounts as they are", async () => {
    const world = await createTestWorld();
    const funded = await world.wallet();
    const to = await world.wallet(0);
    class Payer {
      readonly #inner = funded;
      get address() {
        return this.#inner.address;
      }
      signTransactions(...args: Parameters<typeof funded.signTransactions>) {
        return this.#inner.signTransactions(...args);
      }
    }
    const payer = new Payer() as unknown as typeof funded;
    const seen: unknown[][] = [];
    const wrapped: Transport = {
      ...world.transport,
      send: async (instructions, signer) => {
        seen.push([...instructions]);
        return world.transport.send([...instructions, getTransferSolInstruction({ source: payer, destination: to.address, amount: 1n })], signer);
      },
    };
    const heard = recorder();
    const memo = { programAddress: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" as Address };
    const signature = await createClient({ url: NODE, transport: wrapped, hooks: heard.hooks }).send([getTransferSolInstruction({ source: payer, destination: to.address, amount: 1_000_000n }), memo], payer);
    expect(heard.of("send")).toEqual([expect.objectContaining({ signature, payer: funded.address })]);
    expect("accounts" in (seen[0]?.at(-1) as object)).toBe(false);
  });

  it("gives every observer of a wrapped transport each send once, however many times it is observed", async () => {
    const world = await createTestWorld();
    const payer = await world.wallet();
    const to = await world.wallet(0);
    const first = recorder();
    const second = recorder();
    const once = observedTransport({ ...world.transport }, observerOf(first.hooks));
    const client = createClient({ url: NODE, transport: once, hooks: second.hooks });
    const signature = await client.send([getTransferSolInstruction({ source: payer, destination: to.address, amount: 1_000_000n })], payer);
    for (const heard of [first, second]) {
      expect(heard.of("send")).toEqual([expect.objectContaining({ signature })]);
      expect(heard.of("confirm")).toEqual([expect.objectContaining({ signature, outcome: "confirmed" })]);
    }
  });
});
