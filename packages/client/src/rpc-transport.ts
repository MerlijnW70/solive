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
import { getIntentDiscriminatorBytes, getIntentSize, INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core/internal";
import { confirmSent, type SignatureWatch, signatureStatus } from "./confirmation.js";
import { joined, type Observer, QUIET } from "./observe.js";
import { askedOf, delivering, observable, wireSend } from "./observe-transport.js";
import { refusedUnsent, staleBlockhash } from "./rpc-retry.js";
import { BehindMinSlot, BlockhashExpired, MaybeSent } from "./send-errors.js";
import { askedSignature, isTransactionSignature, nodeSignature, NotASignature } from "./signatures.js";
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
import { base64Bytes } from "./encoding.js";
import { shown } from "./shown.js";

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
  data: base64Bytes(account.data[0]),
  lamports: account.lamports ?? 0n,
});

const withoutMark = ({ complete: _, ...found }: EngineTransaction & { complete: boolean }): EngineTransaction => found;

export const MULTIPLE_ACCOUNTS_LIMIT = 100;

function viewOf(value: RawAccount | null): AccountView | null {
  return value === null
    ? null
    : { owner: value.owner, data: base64Bytes(value.data[0]), lamports: value.lamports, executable: value.executable };
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

type ReadTransaction = Awaited<ReturnType<ReturnType<RpcLike["getTransaction"]>["send"]>>;

const answers = (tx: NonNullable<ReadTransaction>, signature: Signature): boolean => tx.transaction.signatures?.[0] === signature;

function parsed(entry: ListedSignature, tx: ReadTransaction): EngineTransaction & { complete: boolean } {
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
}

export function rpcTransport(rpc: RpcLike, wait?: (ms: number) => Promise<void>, watch?: SignatureWatch, observer: Observer = QUIET): Transport {
  const fetched = new Map<string, Promise<EngineTransaction & { complete: boolean }>>();
  let reached: bigint | undefined;
  const facade = (by: Observer): Transport => {
    const ask = askedOf(by, wait);
    const atLeast = (floor?: bigint): AtLeast => {
      const slot = floor === undefined || (reached !== undefined && reached > floor) ? reached : floor;
      return slot === undefined ? {} : { minContextSlot: slot };
    };
    const confirmed = async (signature: Signature, lastValidBlockHeight: bigint) => {
      const { slot } = await confirmSent(rpc, signature, lastValidBlockHeight, wait, watch, by);
      if (slot !== undefined && (reached === undefined || slot > reached)) {
        reached = slot;
      }
      return { signature, slot };
    };
    const sent = async (wire: Base64EncodedWireTransaction, lastValidBlockHeight: bigint | null, skipPreflight = false): Promise<Signature> => {
      const own = () => getSignatureFromTransaction(getTransactionDecoder().decode(getBase64Encoder().encode(wire)));
      let answer: string;
      try {
        answer = await ask("sendTransaction", () => rpc.sendTransaction(wire, { encoding: "base64", ...(skipPreflight ? { skipPreflight } : {}) }).send());
      } catch (error) {
        const signature = own();
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
        const { value } = await ask("getSignatureStatuses", () => rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send());
        if (value[0]) {
          return signature;
        }
        throw new BlockhashExpired("the node refused the transaction because its blockhash expired; nothing was charged, so sign it again with a fresh blockhash", { cause: error });
      }
      if (!isTransactionSignature(answer)) {
        const signature = own();
        throw new MaybeSent(
          signature,
          lastValidBlockHeight,
          `the node answered the send of transaction ${signature} with something that is not a transaction signature, so it may have reached the node; look the signature up before sending again`,
          { cause: new NotASignature("sendTransaction") },
        );
      }
      return answer;
    };
    const landed = async (wire: Base64EncodedWireTransaction, lastValidBlockHeight: bigint): Promise<Signature> => {
      const deliver = async () => confirmed(await sent(wire, lastValidBlockHeight), lastValidBlockHeight);
      return (by.quiet ? await deliver() : await delivering(by, wireSend(wire, lastValidBlockHeight), deliver)).signature;
    };
    const read = (signature: Signature) =>
      ask("getTransaction", () =>
        rpc
          .getTransaction(signature, {
            encoding: "json",
            maxSupportedTransactionVersion: 0,
            commitment: "confirmed",
          })
          .send(),
      );
    const load = async (entry: ListedSignature): Promise<EngineTransaction & { complete: boolean }> => {
      const tx = await read(entry.signature);
      return parsed(entry, tx !== null && answers(tx, entry.signature) ? tx : null);
    };
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
            const [slot] = await ask("getBlocksWithLimit", () => blocksFrom(from, 1, { commitment: "finalized" }).send());
            if (slot === undefined) {
              return null;
            }
            const block = await ask("getBlock", () =>
              blockAt(slot, { commitment: "finalized", encoding: "json", transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0 }).send(),
            );
            return block === null ? null : { slot, blockhash: block.blockhash };
          };
    const listSignatures = async (of: Address, limit: number, before?: string): Promise<ListedSignature[]> => {
      const from = before === undefined ? {} : { before: askedSignature(before, "before") };
      const listed = await ask("getSignaturesForAddress", () => rpc.getSignaturesForAddress(of, { limit, ...from, ...atLeast() }).send());
      return listed.map((entry) => ({
        signature: nodeSignature(entry.signature, "getSignaturesForAddress"),
        slot: entry.slot,
        blockTime: entry.blockTime,
        failed: entry.err !== null,
        memo: entry.memo ?? null,
      }));
    };
    const programAccounts = (filters: readonly ProgramFilter[], least: AtLeast, withContext: boolean, onSlot?: (slot: bigint) => void) =>
      ask("getProgramAccounts", async () => {
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
      });
    return observable<Transport>({
      async getAccount(address) {
        const { value } = await ask("getAccountInfo", () => rpc.getAccountInfo(address, { encoding: "base64", ...atLeast() }).send());
        return viewOf(value);
      },
      async getAccounts(addresses) {
        const found: (AccountView | null)[] = [];
        for (let at = 0; at < addresses.length; at += MULTIPLE_ACCOUNTS_LIMIT) {
          const chunk = addresses.slice(at, at + MULTIPLE_ACCOUNTS_LIMIT);
          const { value } = await ask("getMultipleAccounts", () => rpc.getMultipleAccounts([...chunk], { encoding: "base64", ...atLeast() }).send());
          found.push(...chunk.map((_, i) => viewOf(value[i] ?? null)));
        }
        return found;
      },
      async send(instructions, payer) {
        const { value: latest } = await ask("getLatestBlockhash", () => rpc.getLatestBlockhash().send());
        const message = pipe(
          createTransactionMessage({ version: 0 }),
          (m) => setTransactionMessageFeePayerSigner(payer, m),
          (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
          (m) => appendTransactionMessageInstructions(instructions, m),
        );
        const signed = await signTransactionMessageWithSigners(message);
        return landed(getBase64EncodedWireTransaction(signed), latest.lastValidBlockHeight);
      },
      async airdrop(address, lamports) {
        const { value: latest } = await ask("getLatestBlockhash", () => rpc.getLatestBlockhash().send());
        const signature = nodeSignature(await ask("requestAirdrop", () => rpc.requestAirdrop(address, lamports).send()), "requestAirdrop");
        return (await confirmed(signature, latest.lastValidBlockHeight)).signature;
      },
      async latestBlockhash() {
        const { value } = await ask("getLatestBlockhash", () => rpc.getLatestBlockhash().send());
        return value;
      },
      async sendWire(wire, latest) {
        return landed(wire, latest.lastValidBlockHeight);
      },
      async submitWire(wire) {
        if (!by.quiet) {
          by.send(wireSend(wire, null));
        }
        return sent(wire, null, true);
      },
      async simulate(wire, watch = []) {
        const { value } = await ask("simulateTransaction", () =>
          rpc
            .simulateTransaction(wire, {
              encoding: "base64",
              sigVerify: false,
              replaceRecentBlockhash: true,
              ...(watch.length === 0 ? {} : { accounts: { addresses: [...watch], encoding: "base64" as const } }),
            })
            .send(),
        );
        return {
          err: value.err === null ? null : shown(value.err),
          logs: [...(value.logs ?? [])],
          unitsConsumed: value.unitsConsumed ?? null,
          accounts: watch.map((_, i) => {
            const found = value.accounts?.[i];
            return found === null || found === undefined ? null : base64Bytes(found.data[0]);
          }),
        };
      },
      async genesisHash() {
        return ask("getGenesisHash", () => rpc.getGenesisHash().send());
      },
      async recentFees(accounts) {
        const fees = await ask("getRecentPrioritizationFees", () => rpc.getRecentPrioritizationFees(accounts).send());
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
      async transactionOf(asked) {
        const signature = askedSignature(asked);
        const tx = await read(signature);
        if (tx === null) {
          return null;
        }
        if (!answers(tx, signature)) {
          return withoutMark(parsed({ signature, slot: 0n, blockTime: null, failed: false, memo: null }, null));
        }
        const failed = tx.meta !== null && tx.meta.err !== undefined && tx.meta.err !== null;
        return withoutMark(parsed({ signature, slot: tx.slot ?? 0n, blockTime: tx.blockTime ?? null, failed, memo: null }, tx));
      },
      async signatureStatuses(signatures) {
        const asked = signatures.map((signature) => askedSignature(signature, "signatures"));
        const found: (SignatureLanding | null)[] = [];
        for (let at = 0; at < asked.length; at += SIGNATURE_STATUSES_LIMIT) {
          const chunk = asked.slice(at, at + SIGNATURE_STATUSES_LIMIT);
          const { value } = await ask("getSignatureStatuses", () => rpc.getSignatureStatuses([...chunk]).send());
          found.push(...chunk.map((_, i) => landingOf(value[i])));
        }
        return found;
      },
      sendStatus: async (signature, lastValidBlockHeight) => signatureStatus(rpc, askedSignature(signature), lastValidBlockHeight, wait, by),
      ...(firstBlock === undefined ? {} : { firstAvailableSlot: () => ask("getFirstAvailableBlock", () => firstBlock().send()) }),
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
          data: base64Bytes(account.data[0]),
        }));
      },
    }, (next) => facade(joined(by, next)));
  };
  return facade(observer);
}
