import { inspect } from "node:util";
import {
  type Address,
  type Base64EncodedWireTransaction,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Signature,
  signTransactionMessageWithSigners,
  getBase58Decoder,
  getBase58Encoder,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
} from "@solana/kit";
import { getIntentDiscriminatorBytes, getIntentSize, INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core";
import { confirmSent, type SignatureWatch, signatureStatus } from "./confirmation.js";
import { patiently, refusedUnsent, staleBlockhash } from "./rpc-retry.js";
import { BehindMinSlot, BlockhashExpired, MaybeSent } from "./send-errors.js";
import type {
  AccountView,
  AtLeast,
  EngineAccountFilter,
  EngineTransaction,
  FinalizedBlock,
  ListedSignature,
  ProgramEntry,
  RawAccount,
  RpcLike,
  SignatureLanding,
  Status,
  Transport,
} from "./rpc-shapes.js";
import { SYSTEM_PROGRAM_ADDRESS, TOKEN_PROGRAMS } from "./accounts.js";
import { intentMatches } from "./intent-filters.js";
import { holdingsOf, keysAt, MEMO_PROGRAM_ADDRESS, signersAmong, solTransfersOf } from "./transaction-keys.js";

type ProgramFilter = { dataSize: bigint } | { memcmp: { offset: bigint; bytes: string; encoding: "base58" } };

function accountFilters(filter?: EngineAccountFilter): ProgramFilter[] {
  if (filter === undefined) {
    return [];
  }
  return [
    ...(filter.dataSize === undefined ? [] : [{ dataSize: BigInt(filter.dataSize) }]),
    { memcmp: { offset: 0n, bytes: getBase58Decoder().decode(filter.discriminator), encoding: "base58" as const } },
    ...(filter.match ?? []).map((match) => ({
      memcmp: { offset: BigInt(match.offset), bytes: "address" in match ? (match.address as string) : getBase58Decoder().decode(match.bytes), encoding: "base58" as const },
    })),
  ];
}

const decodedEntry = ({ pubkey, account }: ProgramEntry) => ({
  address: pubkey,
  data: new Uint8Array(Buffer.from(account.data[0], "base64")),
  lamports: account.lamports ?? 0n,
});

const withoutMark = ({ complete: _, ...found }: EngineTransaction & { complete: boolean }): EngineTransaction => found;

export const MULTIPLE_ACCOUNTS_LIMIT = 100;

function viewOf(value: RawAccount | null): AccountView | null {
  return value === null
    ? null
    : { owner: value.owner, data: new Uint8Array(Buffer.from(value.data[0], "base64")), lamports: value.lamports, executable: value.executable };
}

export const TRANSACTION_FETCHES = 4;
export const KEPT_TRANSACTIONS = 256;

export const SIGNATURE_STATUSES_LIMIT = 256;

export function landingOf(status: Status | null | undefined): SignatureLanding | null {
  if (!status || (status.confirmationStatus !== "confirmed" && status.confirmationStatus !== "finalized")) {
    return null;
  }
  return status.err === null ? "landed" : "failed";
}

export function rpcTransport(rpc: RpcLike, wait?: (ms: number) => Promise<void>, watch?: SignatureWatch): Transport {
  const fetched = new Map<string, Promise<EngineTransaction & { complete: boolean }>>();
  let reached: bigint | undefined;
  const atLeast = (floor?: bigint): AtLeast => {
    const slot = floor === undefined || (reached !== undefined && reached > floor) ? reached : floor;
    return slot === undefined ? {} : { minContextSlot: slot };
  };
  const confirmed = async (signature: Signature, lastValidBlockHeight: bigint) => {
    const { slot } = await confirmSent(rpc, signature, lastValidBlockHeight, wait, watch);
    if (slot !== undefined && (reached === undefined || slot > reached)) {
      reached = slot;
    }
    return signature;
  };
  const sent = async (wire: Base64EncodedWireTransaction, lastValidBlockHeight: bigint | null, skipPreflight = false) => {
    try {
      return await patiently(() => rpc.sendTransaction(wire, { encoding: "base64", ...(skipPreflight ? { skipPreflight } : {}) }).send(), wait);
    } catch (error) {
      const signature = getSignatureFromTransaction(getTransactionDecoder().decode(getBase64Encoder().encode(wire)));
      if (!staleBlockhash(error)) {
        if (refusedUnsent(error)) {
          throw error;
        }
        throw new MaybeSent(
          signature,
          lastValidBlockHeight,
          `transaction ${signature} may have reached the node before sending it failed (${error instanceof Error ? error.message : String(error)}); look the signature up before sending again`,
          { cause: error },
        );
      }
      const { value } = await patiently(() => rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send(), wait);
      if (value[0]) {
        return signature;
      }
      throw new BlockhashExpired("the node refused the transaction because its blockhash expired; nothing was charged, so sign it again with a fresh blockhash", { cause: error });
    }
  };
  const read = (signature: string) =>
    patiently(
      () =>
        rpc
          .getTransaction(signature as Signature, {
            encoding: "json",
            maxSupportedTransactionVersion: 0,
            commitment: "confirmed",
          })
          .send(),
      wait,
    );
  const parsed = (entry: ListedSignature, tx: Awaited<ReturnType<typeof read>>): EngineTransaction & { complete: boolean } => {
    const keys = [
      ...(tx?.transaction.message.accountKeys ?? []),
      ...(tx?.meta?.loadedAddresses?.writable ?? []),
      ...(tx?.meta?.loadedAddresses?.readonly ?? []),
    ];
    const inner = (tx?.meta?.innerInstructions ?? []).flatMap((group) => group.instructions).filter((ix) => keys[ix.programIdIndex] === INTENT_ENGINE_PROGRAM_ADDRESS);
    const emitted = inner.map((ix) => Uint8Array.from(getBase58Encoder().encode(ix.data)));
    const signing = tx?.transaction.message.header?.numRequiredSignatures ?? 0;
    const memoInstructions = (tx?.transaction.message.instructions ?? []).filter((ix) => keys[ix.programIdIndex] === MEMO_PROGRAM_ADDRESS);
    const memos = memoInstructions.map((ix) => new TextDecoder().decode(Uint8Array.from(getBase58Encoder().encode(ix.data))));
    const memoSigners = memoInstructions.map((ix) => signersAmong(keys, ix.accounts ?? [], signing));
    const feePayer = tx?.transaction.message.accountKeys[0];
    const engineCalls = (tx?.transaction.message.instructions ?? []).filter((ix) => keys[ix.programIdIndex] === INTENT_ENGINE_PROGRAM_ADDRESS);
    const called = engineCalls.map((ix) => Uint8Array.from(getBase58Encoder().encode(ix.data)));
    const tokens = holdingsOf(keys, [...(tx?.meta?.preTokenBalances ?? []), ...(tx?.meta?.postTokenBalances ?? [])]);
    const transfers = solTransfersOf(
      keys,
      [...(tx?.transaction.message.instructions ?? []), ...(tx?.meta?.innerInstructions ?? []).flatMap((group) => group.instructions)]
        .filter((ix) => keys[ix.programIdIndex] === SYSTEM_PROGRAM_ADDRESS || TOKEN_PROGRAMS.includes(keys[ix.programIdIndex] as Address))
        .map((ix) => ({ program: keys[ix.programIdIndex], accounts: ix.accounts ?? [], data: Uint8Array.from(getBase58Encoder().encode(ix.data)) })),
      tx?.meta?.preBalances === undefined || tx.meta.postBalances === undefined
        ? undefined
        : { before: tx.meta.preBalances.map(BigInt), after: tx.meta.postBalances.map(BigInt) },
    );
    return {
      signature: entry.signature,
      slot: entry.slot,
      blockTime: entry.blockTime,
      failed: entry.failed,
      emitted,
      ...(inner.length === 0 ? {} : { emittedAccounts: inner.map((ix) => keysAt(keys, ix.accounts ?? [])) }),
      ...(memos.length === 0 ? {} : { memos, memoSigners }),
      ...(feePayer === undefined ? {} : { feePayer }),
      ...(called.length === 0 ? {} : { called, calledAccounts: engineCalls.map((ix) => keysAt(keys, ix.accounts ?? [])) }),
      ...(tokens.length === 0 ? {} : { tokens }),
      ...(transfers.length === 0 ? {} : { transfers }),
      ...(tx?.meta === null || tx?.meta === undefined ? { unread: true as const } : {}),
      complete: tx?.meta !== null && tx?.meta !== undefined && entry.blockTime !== null,
    };
  };
  const load = async (entry: ListedSignature): Promise<EngineTransaction & { complete: boolean }> => parsed(entry, await read(entry.signature));
  const fetchOne = (entry: ListedSignature): Promise<EngineTransaction> => {
    const known = fetched.get(entry.signature);
    if (known !== undefined) {
      fetched.delete(entry.signature);
      fetched.set(entry.signature, known);
      return known.then(withoutMark);
    }
    const pending = load(entry);
    fetched.set(entry.signature, pending);
    pending.then(
      (found) => {
        if (!found.complete && fetched.get(entry.signature) === pending) {
          fetched.delete(entry.signature);
        }
      },
      () => {
        if (fetched.get(entry.signature) === pending) {
          fetched.delete(entry.signature);
        }
      },
    );
    return pending.then(withoutMark);
  };
  const fetchAll = async (listed: readonly ListedSignature[]): Promise<EngineTransaction[]> => {
    const found: EngineTransaction[] = [];
    for (let i = 0; i < listed.length; i += TRANSACTION_FETCHES) {
      found.push(...(await Promise.all(listed.slice(i, i + TRANSACTION_FETCHES).map(fetchOne))));
    }
    for (const old of fetched.keys()) {
      if (fetched.size <= KEPT_TRANSACTIONS) {
        break;
      }
      fetched.delete(old);
    }
    return found;
  };
  const firstBlock = rpc.getFirstAvailableBlock?.bind(rpc);
  const blocksFrom = rpc.getBlocksWithLimit?.bind(rpc);
  const blockAt = rpc.getBlock?.bind(rpc);
  const finalizedBlock =
    blocksFrom === undefined || blockAt === undefined
      ? undefined
      : async (from: bigint): Promise<FinalizedBlock | null> => {
          const [slot] = await patiently(() => blocksFrom(from, 1, { commitment: "finalized" }).send(), wait);
          if (slot === undefined) {
            return null;
          }
          const block = await patiently(
            () => blockAt(slot, { commitment: "finalized", encoding: "json", transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0 }).send(),
            wait,
          );
          return block === null ? null : { slot, blockhash: block.blockhash };
        };
  const listSignatures = async (of: Address, limit: number, before?: string): Promise<ListedSignature[]> => {
    const listed = await patiently(
      () => rpc.getSignaturesForAddress(of, { limit, ...(before === undefined ? {} : { before: before as Signature }), ...atLeast() }).send(),
      wait,
    );
    return listed.map((entry) => ({
      signature: entry.signature,
      slot: entry.slot,
      blockTime: entry.blockTime,
      failed: entry.err !== null,
      memo: entry.memo ?? null,
    }));
  };
  const programAccounts = (filters: readonly ProgramFilter[], least: AtLeast, withContext: boolean, onSlot?: (slot: bigint) => void) =>
    patiently(async () => {
      const response = await rpc
        .getProgramAccounts(INTENT_ENGINE_PROGRAM_ADDRESS, {
          encoding: "base64",
          commitment: "confirmed",
          filters,
          ...least,
          ...(withContext ? { withContext: true as const } : {}),
        })
        .send();
      if (!("context" in response)) {
        return response;
      }
      if (least.minContextSlot !== undefined && response.context.slot < least.minContextSlot) {
        throw new BehindMinSlot(response.context.slot, least.minContextSlot);
      }
      onSlot?.(response.context.slot);
      return response.value;
    }, wait);
  return {
    async getAccount(address) {
      const { value } = await patiently(() => rpc.getAccountInfo(address, { encoding: "base64", ...atLeast() }).send(), wait);
      return viewOf(value);
    },
    async getAccounts(addresses) {
      const found: (AccountView | null)[] = [];
      for (let at = 0; at < addresses.length; at += MULTIPLE_ACCOUNTS_LIMIT) {
        const chunk = addresses.slice(at, at + MULTIPLE_ACCOUNTS_LIMIT);
        const { value } = await patiently(() => rpc.getMultipleAccounts([...chunk], { encoding: "base64", ...atLeast() }).send(), wait);
        found.push(...chunk.map((_, i) => viewOf(value[i] ?? null)));
      }
      return found;
    },
    async send(instructions, payer) {
      const { value: latest } = await patiently(() => rpc.getLatestBlockhash().send(), wait);
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(payer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
        (m) => appendTransactionMessageInstructions(instructions, m),
      );
      const signed = await signTransactionMessageWithSigners(message);
      const signature = await sent(getBase64EncodedWireTransaction(signed), latest.lastValidBlockHeight);
      return confirmed(signature, latest.lastValidBlockHeight);
    },
    async airdrop(address, lamports) {
      const { value: latest } = await patiently(() => rpc.getLatestBlockhash().send(), wait);
      const signature = await patiently(() => rpc.requestAirdrop(address, lamports).send(), wait);
      return confirmed(signature, latest.lastValidBlockHeight);
    },
    async latestBlockhash() {
      const { value } = await patiently(() => rpc.getLatestBlockhash().send(), wait);
      return value;
    },
    async sendWire(wire, latest) {
      const signature = await sent(wire, latest.lastValidBlockHeight);
      return confirmed(signature, latest.lastValidBlockHeight);
    },
    async submitWire(wire) {
      return sent(wire, null, true);
    },
    async simulate(wire, watch = []) {
      const { value } = await patiently(
        () =>
          rpc
            .simulateTransaction(wire, {
              encoding: "base64",
              sigVerify: false,
              replaceRecentBlockhash: true,
              ...(watch.length === 0 ? {} : { accounts: { addresses: [...watch], encoding: "base64" as const } }),
            })
            .send(),
        wait,
      );
      return {
        err: value.err === null ? null : inspect(value.err, { depth: null, breakLength: Infinity }),
        logs: [...(value.logs ?? [])],
        unitsConsumed: value.unitsConsumed ?? null,
        accounts: watch.map((_, i) => {
          const found = value.accounts?.[i];
          return found === null || found === undefined ? null : new Uint8Array(Buffer.from(found.data[0], "base64"));
        }),
      };
    },
    async genesisHash() {
      return patiently(() => rpc.getGenesisHash().send(), wait);
    },
    async recentFees(accounts) {
      const fees = await patiently(() => rpc.getRecentPrioritizationFees(accounts).send(), wait);
      return fees.map((f) => f.prioritizationFee);
    },
    async budget(instructions) {
      return [...instructions];
    },
    async engineTransactions(limit, of, memo) {
      const listed = await listSignatures(of ?? INTENT_ENGINE_PROGRAM_ADDRESS, limit);
      return fetchAll(memo === undefined ? listed : listed.filter((entry) => (entry.memo ?? "").includes(memo)));
    },
    signaturesOf: (of, limit, before) => listSignatures(of, limit, before),
    transactionsOf: (listed) => fetchAll(listed),
    async transactionOf(signature) {
      const tx = await read(signature);
      if (tx === null) {
        return null;
      }
      const failed = tx.meta !== null && tx.meta.err !== undefined && tx.meta.err !== null;
      return withoutMark(parsed({ signature, slot: tx.slot ?? 0n, blockTime: tx.blockTime ?? null, failed, memo: null }, tx));
    },
    async signatureStatuses(signatures) {
      const found: (SignatureLanding | null)[] = [];
      for (let at = 0; at < signatures.length; at += SIGNATURE_STATUSES_LIMIT) {
        const chunk = signatures.slice(at, at + SIGNATURE_STATUSES_LIMIT) as Signature[];
        const { value } = await patiently(() => rpc.getSignatureStatuses([...chunk]).send(), wait);
        found.push(...chunk.map((_, i) => landingOf(value[i])));
      }
      return found;
    },
    sendStatus: (signature, lastValidBlockHeight) => signatureStatus(rpc, signature as Signature, lastValidBlockHeight, wait),
    ...(firstBlock === undefined ? {} : { firstAvailableSlot: () => patiently(() => firstBlock().send(), wait) }),
    ...(finalizedBlock === undefined ? {} : { finalizedBlock }),
    async engineAccounts(filter) {
      return (await programAccounts(accountFilters(filter), atLeast(), true)).map(decodedEntry);
    },
    async intents(query, read) {
      const found = await programAccounts(
        accountFilters({ discriminator: getIntentDiscriminatorBytes(), dataSize: getIntentSize(), match: intentMatches(query) }),
        atLeast(read?.minContextSlot),
        read !== undefined,
        read?.onSlot,
      );
      return found.map(({ pubkey, account }) => ({
        address: pubkey,
        data: new Uint8Array(Buffer.from(account.data[0], "base64")),
      }));
    },
  };
}
