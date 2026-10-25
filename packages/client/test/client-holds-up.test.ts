import {
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type SignatureBytes,
  type TransactionPartialSigner,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { FailedTransactionMetadata } from "litesvm";
import { describe, expect, it, vi } from "vitest";
import { IntentStatus } from "@intent-engine/core";
import { buildInitUser, findIntentPda, INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core/internal";
import { createClient, type Notifications, type Transport } from "../src/index.js";
import { ENGINE_ERRORS, type RpcLike, rpcTransport } from "../src/internal.js";
import { world } from "./svm.js";
import { create, LOCAL, until } from "./engine-client.js";

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
    expect((await client.intent({ owner: w.owner.address, nonce: 0n }))?.intent.status).toBe(IntentStatus.Open);
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
