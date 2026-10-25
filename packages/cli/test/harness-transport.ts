import { type Address, type Blockhash, getBase64Encoder, getSignatureFromTransaction, getTransactionDecoder, lamports } from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import {
  EVENT_IX_TAG,
  findIntentPda,
  getIntentCreatedEventEncoder,
  getIntentDecoder,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  MANDATE_NONCE_BIT,
} from "@intent-engine/core/internal";
import type { Fetch } from "@intent-engine/solver";
import { type EngineAccountFilter, type EngineTransaction, type Transport } from "@intent-engine/client";
import { intentMatches, matchBytes } from "@intent-engine/client/internal";
import { h, PACKET_LIMIT, send, touch } from "./harness-state.js";

const startsWith = (data: Uint8Array, head: ArrayLike<number>, at: number): boolean =>
  data.length >= at + head.length && Array.from(head).every((b, i) => data[at + i] === b);

const matches = (data: Uint8Array, filter: EngineAccountFilter): boolean =>
  (filter.dataSize === undefined || data.length === filter.dataSize) &&
  startsWith(data, filter.discriminator, 0) &&
  (filter.match ?? []).every((match) => startsWith(data, matchBytes(match), match.offset));

const decodeWire = (wire: string) => getTransactionDecoder().decode(getBase64Encoder().encode(wire));

export const transport: Transport = {
  async getAccounts(addresses) {
    return Promise.all(addresses.map((address) => transport.getAccount(address)));
  },
  async getAccount(address) {
    h.reads.set(address, (h.reads.get(address) ?? 0) + 1);
    const account = h.svm.getAccount(address);
    return account.exists
      ? { owner: account.programAddress, data: new Uint8Array(account.data), lamports: account.lamports, executable: account.executable }
      : null;
  },
  send: (ixs, payer) => send(payer, ixs),
  latestBlockhash: async () => ({ blockhash: h.svm.latestBlockhash() as Blockhash, lastValidBlockHeight: 0n }),
  submitWire: async (wire) => {
    h.submitted.push(wire);
    const tx = decodeWire(wire);
    if (h.dropSubmits) {
      return getSignatureFromTransaction(tx);
    }
    const result = h.svm.sendTransaction(tx);
    if (result instanceof FailedTransactionMetadata) {
      throw new Error(`${String(result.err())}\n${result.meta().logs().join("\n")}`);
    }
    touch(tx);
    h.wires.push(wire);
    return getSignatureFromTransaction(tx);
  },
  sendWire: async (wire) => {
    const tx = decodeWire(wire);
    const fails = h.sendFails !== null && (h.sendFails.after ?? 0) > 0 ? null : h.sendFails;
    if (h.sendFails !== null && fails === null) {
      h.sendFails.after = (h.sendFails.after ?? 0) - 1;
    } else {
      h.sendFails = null;
    }
    if (fails !== null && !fails.landed) {
      throw fails.error;
    }
    const result = h.svm.sendTransaction(tx);
    if (!(result instanceof FailedTransactionMetadata)) {
      touch(tx);
    }
    if (fails !== null) {
      throw fails.error;
    }
    if (result instanceof FailedTransactionMetadata) {
      throw new Error(`${String(result.err())}\n${result.meta().logs().join("\n")}`);
    }
    touch(tx);
    h.wires.push(wire);
    return getSignatureFromTransaction(tx);
  },
  simulate: async (wire, watch = []) => {
    const bytes = getBase64Encoder().encode(wire).length;
    if (h.packetLimit && bytes > PACKET_LIMIT) {
      throw new Error(`base64 encoded solana_transaction::versioned::VersionedTransaction too large: ${bytes} bytes (max: encoded/raw ${PACKET_LIMIT})`);
    }
    h.simulated.push(wire);
    const tx = decodeWire(wire);
    const unsigned = Object.fromEntries(
      Object.entries(tx.signatures).map(([signer, signature]) => [signer, signature ?? new Uint8Array(64)]),
    );
    h.svm.withSigverify(false).withBlockhashCheck(false);
    const result = h.svm.simulateTransaction({ ...tx, signatures: unsigned } as typeof tx);
    h.svm.withSigverify(true).withBlockhashCheck(true);
    const meta = result.meta();
    const post = result instanceof FailedTransactionMetadata ? new Map() : new Map(result.postAccounts().map((a) => [a.address, a.data]));
    return {
      err: result instanceof FailedTransactionMetadata ? String(result.err()) : null,
      logs: meta.logs(),
      unitsConsumed: meta.computeUnitsConsumed(),
      accounts: watch.map((address) => {
        const after = post.get(address);
        if (after !== undefined) {
          return new Uint8Array(after);
        }
        const now = h.svm.getAccount(address);
        return now.exists ? new Uint8Array(now.data) : null;
      }),
    };
  },
  genesisHash: async () => {
    h.genesisReads++;
    return h.genesis;
  },
  intents: async (only) => {
    h.scans++;
    if (h.failScans > 0) {
      h.failScans--;
      throw new Error("scan refused");
    }
    const found = [];
    for (const owner of only?.owner === undefined ? h.watched : [only.owner]) {
      const lanes = [1n, 2n, 3n].flatMap((serial) => Array.from({ length: 10 }, (_, i) => MANDATE_NONCE_BIT | (serial << 32n) | BigInt(i)));
      for (const nonce of [...Array.from({ length: 10 }, (_, i) => BigInt(i)), ...lanes]) {
        const [address] = await findIntentPda({ owner, nonce });
        const account = h.svm.getAccount(address);
        if (account.exists && account.programAddress === INTENT_ENGINE_PROGRAM_ADDRESS) {
          found.push({ address, data: new Uint8Array(account.data) });
        }
      }
    }
    const wanted = intentMatches(only);
    return found.filter(({ data }) => wanted.every((match) => startsWith(data, matchBytes(match), match.offset)));
  },
  engineTransactions: async (limit, of) => {
    h.requestedLimits.push(limit);
    h.requestedOf.push(of);
    return h.engineLog;
  },
  engineAccounts: async (filter) =>
    [...h.touched].flatMap((address) => {
      const account = h.svm.getAccount(address);
      if (!account.exists || account.programAddress !== INTENT_ENGINE_PROGRAM_ADDRESS) {
        return [];
      }
      const data = new Uint8Array(account.data);
      return filter === undefined || matches(data, filter) ? [{ address, data, lamports: account.lamports }] : [];
    }),
  firstAvailableSlot: async () => h.firstSlot,
  recentFees: async (accounts) => {
    h.feeQueries.push([...accounts]);
    return [...h.recentFees];
  },
  budget: async (instructions) => [...instructions],
  airdrop: async (address, amount) => {
    h.airdrops.push({ address, lamports: amount });
    if (h.airdropRefused) {
      throw new Error("429 Too Many Requests");
    }
    h.svm.airdrop(address, lamports(amount));
    return "airdrop";
  },
};

export const unlisting = Object.fromEntries(Object.entries(transport).filter(([name]) => name !== "engineAccounts")) as Transport;

export function ownerSigned(intent: Address, memos: string[]): Pick<EngineTransaction, "memos" | "memoSigners"> {
  const held = h.svm.getAccount(intent);
  if (!held.exists) {
    throw new Error("the escrow was not created");
  }
  const { owner } = getIntentDecoder().decode(held.data);
  return { memos, memoSigners: memos.map(() => [owner]) };
}

export const creation = (intent: Address, slot = 1n): EngineTransaction => ({
  signature: `create-${intent}`,
  slot,
  blockTime: null,
  failed: false,
  emitted: [
    new Uint8Array([
      ...EVENT_IX_TAG,
      ...getIntentCreatedEventEncoder().encode({
        intent,
        owner: intent,
        nonce: 0n,
        kind: 4,
        inputMint: intent,
        outputMint: intent,
        receiver: intent,
        escrowed: 0n,
        expiresAt: 0n,
        rentPayer: intent,
        flags: 0,
        bounty: 0,
        createFee: 0,
      }),
    ]),
  ],
});

export const fakeFetch: Fetch = async (url, init) => {
  h.fetched.push({ url, body: init?.body, headers: init?.headers });
  const reply = h.jupiterReplies.shift() ?? { status: 503, body: {} };
  return { ok: reply.status === 200, status: reply.status, json: async () => reply.body };
};
