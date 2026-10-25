import { type Address, generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { type EngineEvent } from "@intent-engine/core";
import { getFillAttestedSplitInstructionDataEncoder, splitN } from "@intent-engine/core/internal";
import { type EngineTransaction, type ListedSignature, type Transport } from "../src/index.js";
import { ownHistory, releaseShareOf } from "../src/internal.js";

const address = async (): Promise<Address> => (await generateKeyPairSigner()).address;

const landed = (signature: string, extra: Partial<EngineTransaction> = {}): EngineTransaction => ({ signature, slot: 1n, blockTime: null, failed: false, emitted: [], ...extra });

const listed = (signature: string, failed = false): ListedSignature => ({ signature, slot: 1n, blockTime: null, failed, memo: null });

function splitEvent(intent: Address, net: bigint): EngineEvent {
  return {
    name: "IntentSplit",
    notable: false,
    fields: { intent, owner: intent, solver: intent, attestor: intent, amountIn: net, result: 1n, fee: 0n, net, partnerFee: 0n, recipients: 3, splitHash: new Uint8Array(32) },
  };
}

function attestedEvent(intent: Address, payee: Address, net: bigint): EngineEvent {
  return {
    name: "IntentAttested",
    notable: false,
    fields: { intent, owner: intent, solver: intent, payee, attestor: intent, amountIn: net, result: 1n, fee: 0n, net, filled: net, remaining: 0n, partnerFee: 0n },
  };
}

const noAccounts = { getAccount: async () => null } as unknown as Transport;

describe("releaseShareOf", () => {
  it("adds up every share a split pays the wallet, dust included, and pays nobody it does not name", async () => {
    const [intent, wallet, other, stranger] = await Promise.all([address(), address(), address(), address()]);
    const weights = [3_333, 3_334, 3_333];
    const recipients = [wallet, other, wallet];
    const data = Uint8Array.from(getFillAttestedSplitInstructionDataEncoder().encode({ fill: { amountIn: 1_000n, result: 1n, maxFeeBps: 0 }, claim: { recipients, weights }, opening: { delivered: new Uint8Array(32), salt: new Uint8Array(16) }, ext: new Uint8Array() }));
    const transaction = landed("split", { called: [data], calledAccounts: [[wallet, wallet, intent]] });
    const net = 1_001n;
    const shares = splitN(net, weights);
    const release = { event: splitEvent(intent, net), transaction };
    expect(await releaseShareOf(noAccounts, release, intent, wallet)).toBe((shares[0] ?? 0n) + (shares[2] ?? 0n));
    expect(await releaseShareOf(noAccounts, release, intent, other)).toBe(shares[1]);
    expect(await releaseShareOf(noAccounts, release, intent, stranger)).toBeNull();
    expect(await releaseShareOf(noAccounts, release, other, wallet)).toBeNull();
  });

  it("pays a single release to the wallet that owns the paid token account, not to the token account", async () => {
    const [intent, wallet, payee] = await Promise.all([address(), address(), address()]);
    const transaction = landed("release", { tokens: [{ account: payee, mint: intent, owner: wallet }] });
    const release = { event: attestedEvent(intent, payee, 77n), transaction };
    expect(await releaseShareOf(noAccounts, release, intent, wallet)).toBe(77n);
    expect(await releaseShareOf(noAccounts, release, intent, payee)).toBeNull();
  });
});

describe("ownHistory", () => {
  it("reads the wallet's newest signatures, fetches only those that did not fail, and says whether it reached the oldest", async () => {
    const wallet = await address();
    const pages: ListedSignature[][] = [[listed("a"), listed("b", true), listed("c")], []];
    const fetched: string[][] = [];
    const asked: (Address | undefined)[] = [];
    const transport = {
      engineTransactions: async () => [],
      signaturesOf: async (of: Address) => {
        asked.push(of);
        return pages.shift() ?? [];
      },
      transactionsOf: async (wanted: readonly ListedSignature[]) => {
        fetched.push(wanted.map(({ signature }) => signature));
        return wanted.map(({ signature }) => landed(signature));
      },
    } as unknown as Transport;
    const read = await ownHistory(transport, wallet, 5);
    expect(read.transactions.map(({ signature }) => signature)).toEqual(["a", "c"]);
    expect(read.complete).toBe(true);
    expect(fetched.flat()).toEqual(["a", "c"]);
    expect(asked.every((of) => of === wallet)).toBe(true);

    const full = { ...transport, signaturesOf: async (_: Address, limit: number) => Array.from({ length: limit }, (_, i) => listed(`s${i}`)) } as unknown as Transport;
    expect((await ownHistory(full, wallet, 3)).complete).toBe(false);
  });

  it("falls back to the transport's recent transactions and stays incomplete when one was not read", async () => {
    const wallet = await address();
    const unread = { ...landed("u"), unread: true as const };
    const of: (Address | undefined)[] = [];
    const transport = {
      engineTransactions: async (_: number, at?: Address) => {
        of.push(at);
        return [landed("x"), unread];
      },
    } as unknown as Transport;
    const read = await ownHistory(transport, wallet, 10);
    expect(of).toEqual([wallet]);
    expect(read.transactions).toHaveLength(2);
    expect(read.complete).toBe(false);
    const short = { engineTransactions: async () => [landed("x")] } as unknown as Transport;
    expect((await ownHistory(short, wallet, 10)).complete).toBe(true);
    const long = { engineTransactions: async () => [landed("x"), landed("y")] } as unknown as Transport;
    expect(await ownHistory(long, wallet, 1)).toEqual({ transactions: [landed("x")], complete: false });
  });
});
