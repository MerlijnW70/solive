import { inspect } from "node:util";
import {
  type Address,
  appendTransactionMessageInstructions,
  type Blockhash,
  createTransactionMessage,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getAddressDecoder,
  getBase58Decoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  type Signature,
  signature as signatureFrom,
  signTransactionMessageWithSigners,
  type Transaction,
} from "@solana/kit";
import { InvalidInput } from "@intent-engine/core";
import { getIntentDiscriminatorBytes, getIntentSize, INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core/internal";
import { FailedTransactionMetadata, type LiteSVM } from "litesvm";
import { TOKEN_PROGRAMS } from "./accounts.js";
import { intentMatches, matchBytes } from "./intent-filters.js";
import { joined, type Observer, QUIET } from "./observe.js";
import { delivering, memberRequests, observable, transactionSend } from "./observe-transport.js";
import { BehindMinSlot, BlockhashExpired, FailedOnChain, type Failure, failure } from "./send-errors.js";
import { askedSignature } from "./signatures.js";
import { ALREADY_PROCESSED, BLOCKHASH_NOT_FOUND, errOf, fieldlessOf } from "./svm-errors.js";
import {
  type EngineTransaction,
  keysAt,
  type ListedSignature,
  MEMO_PROGRAM_ADDRESS,
  type EngineAccount,
  type EngineAccountFilter,
  type ProgramAccount,
  type SignatureLanding,
  signersAmong,
  solTransfersOf,
  type TokenHolding,
  type Transport,
} from "./transport.js";

const TOKEN_HEAD = 64;
const LOOKUP_TABLE_HEAD = 56;

export type SvmTransportOptions = { genesisHash?: string; offline?: boolean };

export const SVM_GENESIS_HASH = "11111111111111111111111111111111";

export const BLOCKHASH_GONE = "the transaction's blockhash is no longer the latest one LiteSVM accepts; nothing was charged, so sign it again with a fresh blockhash";

const sigverifyOf = (svm: LiteSVM): boolean =>
  (svm as unknown as { inner?: { getSigverify?: () => boolean } }).inner?.getSigverify?.() ?? true;

const startsWith = (data: Uint8Array, head: ArrayLike<number>, at: number): boolean =>
  data.length >= at + head.length && Array.from(head).every((b, i) => data[at + i] === b);

const decodeWire = (wire: string) => getTransactionDecoder().decode(getBase64Encoder().encode(wire));

type Compiled = ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]>;

export function svmTransport(svm: LiteSVM, options: SvmTransportOptions = {}): Transport {
  const touched = new Set<Address>();
  const history: { touched: ReadonlySet<Address>; found: EngineTransaction }[] = [];
  const byId = new Map<string, EngineTransaction>();
  const failures = new Map<string, Failure>();
  const heights = new Map<string, bigint>();
  const height = (): bigint => {
    const blockhash = svm.latestBlockhash();
    const known = heights.get(blockhash);
    if (known !== undefined) {
      return known;
    }
    const next = BigInt(heights.size);
    heights.set(blockhash, next);
    return next;
  };
  const holdings = (keys: readonly Address[]): TokenHolding[] =>
    keys.flatMap((account) => {
      const held = svm.getAccount(account);
      if (!held.exists || !TOKEN_PROGRAMS.includes(held.programAddress) || held.data.length < TOKEN_HEAD) {
        return [];
      }
      const decoder = getAddressDecoder();
      return [{ account, mint: decoder.decode(held.data.subarray(0, 32)), owner: decoder.decode(held.data.subarray(32, TOKEN_HEAD)) }];
    });
  const tableAddresses = (table: Address): Address[] => {
    const held = svm.getAccount(table);
    if (!held.exists || held.data.length < LOOKUP_TABLE_HEAD) {
      return [];
    }
    const decoder = getAddressDecoder();
    return Array.from({ length: Math.floor((held.data.length - LOOKUP_TABLE_HEAD) / 32) }, (_, i) =>
      decoder.decode(held.data.subarray(LOOKUP_TABLE_HEAD + i * 32, LOOKUP_TABLE_HEAD + (i + 1) * 32)),
    );
  };
  const loaded = (compiled: Compiled): Address[] => {
    const lookups = "addressTableLookups" in compiled ? (compiled.addressTableLookups ?? []) : [];
    const tables = lookups.map(({ lookupTableAddress }) => tableAddresses(lookupTableAddress));
    const pick = (indexes: (lookup: (typeof lookups)[number]) => readonly number[]) =>
      lookups.flatMap((lookup, i) => indexes(lookup).flatMap((index) => tables[i]?.[index] ?? []));
    return [...compiled.staticAccounts, ...pick(({ writableIndexes }) => writableIndexes), ...pick(({ readonlyIndexes }) => readonlyIndexes)];
  };
  const messageParts = (compiled: Compiled, keys: readonly Address[]) => {
    const instructions = "instructions" in compiled ? compiled.instructions : [];
    const memoInstructions = instructions.filter((ix) => keys[ix.programAddressIndex] === MEMO_PROGRAM_ADDRESS);
    const memos = memoInstructions.map((ix) => new TextDecoder().decode(Uint8Array.from(ix.data ?? [])));
    const memoSigners = memoInstructions.map((ix) => signersAmong(keys, ix.accountIndices ?? [], compiled.header.numSignerAccounts));
    const feePayer = keys[0];
    const engineCalls = instructions.filter((ix) => keys[ix.programAddressIndex] === INTENT_ENGINE_PROGRAM_ADDRESS);
    const called = engineCalls.map((ix) => Uint8Array.from(ix.data ?? []));
    return {
      ...(memos.length === 0 ? {} : { memos, memoSigners }),
      ...(feePayer === undefined ? {} : { feePayer }),
      ...(called.length === 0 ? {} : { called, calledAccounts: engineCalls.map((ix) => keysAt(keys, ix.accountIndices ?? [])) }),
    };
  };
  const record = (keys: readonly Address[], found: EngineTransaction) => {
    for (const address of keys) {
      touched.add(address);
    }
    history.unshift({ touched: new Set(keys), found });
    byId.set(found.signature, found);
  };
  const failedOnChain = (found: Failure, logs: readonly string[]) => new FailedOnChain(`${inspect(found.err, { depth: null, breakLength: Infinity })}\n${logs.join("\n")}`, found);
  const settledBefore = (signature: Signature, submitted: boolean): Signature | undefined => {
    const failed = failures.get(signature);
    if (failed !== undefined) {
      if (submitted) {
        return signature;
      }
      throw failedOnChain(failed, failed.logs ?? []);
    }
    return byId.has(signature) ? signature : undefined;
  };
  const landed = (tx: Transaction, submitted = false): Signature => {
    const signature = getSignatureFromTransaction(tx);
    const known = settledBefore(signature, submitted);
    if (known !== undefined) {
      return known;
    }
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const keys = loaded(compiled);
    const instructions = "instructions" in compiled ? compiled.instructions : [];
    const before = holdings(keys);
    const lamportsOf = () => keys.map((key) => svm.getBalance(key) ?? 0n);
    const lamportsBefore = lamportsOf();
    const result = svm.sendTransaction(tx);
    const clock = svm.getClock();
    if (result instanceof FailedTransactionMetadata) {
      const fieldless = fieldlessOf(result);
      if (fieldless === BLOCKHASH_NOT_FOUND) {
        throw new BlockhashExpired(BLOCKHASH_GONE);
      }
      const elsewhere = fieldless === ALREADY_PROCESSED ? svm.getTransaction(signature) : null;
      if (elsewhere !== null && !(elsewhere instanceof FailedTransactionMetadata)) {
        return signature;
      }
      const logs = result.meta().logs();
      const programs = instructions.flatMap((ix) => keys[ix.programAddressIndex] ?? []);
      const failed = failure(signature, errOf(result), logs, programs);
      failures.set(signature, failed);
      record(keys, { signature, slot: clock.slot, blockTime: clock.unixTimestamp, failed: true, emitted: [], ...messageParts(compiled, keys) });
      if (submitted) {
        return signature;
      }
      throw failedOnChain(failed, logs);
    }
    const after = holdings(keys).filter((held) => !before.some(({ account }) => account === held.account));
    const tokens = [...before, ...after];
    const everyInner = result
      .innerInstructions()
      .flat()
      .map((ix) => ix.instruction());
    const inner = everyInner.filter((ix) => keys[ix.programIdIndex()] === INTENT_ENGINE_PROGRAM_ADDRESS);
    const transfers = solTransfersOf(
      keys,
      [
        ...instructions.map((ix) => ({ program: keys[ix.programAddressIndex], accounts: ix.accountIndices ?? [], data: Uint8Array.from(ix.data ?? []) })),
        ...everyInner.map((ix) => ({ program: keys[ix.programIdIndex()], accounts: Array.from(ix.accounts()), data: new Uint8Array(ix.data()) })),
      ],
      { before: lamportsBefore, after: lamportsOf() },
    );
    record(keys, {
      signature,
      slot: clock.slot,
      blockTime: clock.unixTimestamp,
      failed: false,
      emitted: inner.map((ix) => new Uint8Array(ix.data())),
      ...(inner.length === 0 ? {} : { emittedAccounts: inner.map((ix) => keysAt(keys, ix.accounts())) }),
      ...messageParts(compiled, keys),
      ...(tokens.length === 0 ? {} : { tokens }),
      ...(transfers.length === 0 ? {} : { transfers }),
    });
    return signature;
  };
  const getAccount = async (address: Address) => {
    const account = svm.getAccount(address);
    return account.exists
      ? { owner: account.programAddress, data: new Uint8Array(account.data), lamports: account.lamports, executable: account.executable }
      : null;
  };
  const matches = (data: Uint8Array, filter: EngineAccountFilter): boolean =>
    (filter.dataSize === undefined || data.length === filter.dataSize) &&
    startsWith(data, filter.discriminator, 0) &&
    (filter.match ?? []).every((match) => startsWith(data, matchBytes(match), match.offset));
  const listed = (filter?: EngineAccountFilter): EngineAccount[] => {
    const owned = new Map(svm.getProgramAccounts(INTENT_ENGINE_PROGRAM_ADDRESS).map((account) => [account.address, account]));
    for (const address of owned.keys()) {
      touched.add(address);
    }
    return [...touched].flatMap((address) => {
      const account = owned.get(address);
      if (account === undefined) {
        return [];
      }
      const data = new Uint8Array(account.data);
      return filter === undefined || matches(data, filter) ? [{ address, data, lamports: account.lamports }] : [];
    });
  };
  const landing = (signature: string): SignatureLanding | null => (failures.has(signature) ? "failed" : byId.has(signature) ? "landed" : null);
  const delivered = async (tx: Transaction, by: Observer, lastValidBlockHeight: () => bigint): Promise<Signature> => {
    const deliver = async () => {
      const signature = landed(tx);
      return { signature, slot: byId.get(signature)?.slot };
    };
    return (by.quiet ? await deliver() : await delivering(by, transactionSend(tx, lastValidBlockHeight()), deliver)).signature;
  };
  const facade = (by: Observer): Transport => {
    const members: Transport = {
      ...(options.offline === true ? { offline: true } : {}),
      getAccount,
      engineAccounts: async (filter) => listed(filter),
      getAccounts: async (addresses) => Promise.all(addresses.map(getAccount)),
      send: async (instructions, payer) => {
        svm.expireBlockhash();
        const message = pipe(
          createTransactionMessage({ version: 0 }),
          (m) => setTransactionMessageFeePayerSigner(payer, m),
          (m) => svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
          (m) => appendTransactionMessageInstructions(instructions, m),
        );
        return delivered(await signTransactionMessageWithSigners(message), by, height);
      },
      latestBlockhash: async () => ({ blockhash: svm.latestBlockhash() as Blockhash, lastValidBlockHeight: height() }),
      sendWire: async (wire, latest) => delivered(decodeWire(wire), by, () => latest.lastValidBlockHeight),
      submitWire: async (wire) => {
        const tx = decodeWire(wire);
        if (!by.quiet) {
          by.send(transactionSend(tx, null));
        }
        return landed(tx, true);
      },
      simulate: async (wire, watch = []) => {
        const tx = decodeWire(wire);
        const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
        const messageBytes = getCompiledTransactionMessageEncoder().encode({ ...compiled, lifetimeToken: svm.latestBlockhash() });
        const unsigned = Object.fromEntries(
          Object.entries(tx.signatures).map(([signer, signature]) => [signer, signature ?? new Uint8Array(64)]),
        );
        const verifying = sigverifyOf(svm);
        svm.withSigverify(false);
        let result: ReturnType<LiteSVM["simulateTransaction"]>;
        try {
          result = svm.simulateTransaction({ messageBytes, signatures: unsigned } as unknown as typeof tx);
        } finally {
          svm.withSigverify(verifying);
        }
        const meta = result.meta();
        return {
          err: result instanceof FailedTransactionMetadata ? String(result.err()) : null,
          logs: meta.logs(),
          unitsConsumed: meta.computeUnitsConsumed(),
          accounts: watch.map(() => null),
        };
      },
      genesisHash: async () => options.genesisHash ?? SVM_GENESIS_HASH,
      intents: async (query, read) => {
        const slot = svm.getClock().slot;
        if (read?.minContextSlot !== undefined && slot < read.minContextSlot) {
          throw new BehindMinSlot(slot, read.minContextSlot);
        }
        const found = listed({
          discriminator: getIntentDiscriminatorBytes(),
          dataSize: getIntentSize(),
          match: intentMatches(query),
        }).map(({ address, data }): ProgramAccount => ({ address, data }));
        read?.onSlot?.(slot);
        return found;
      },
      engineTransactions: async (limit, of = INTENT_ENGINE_PROGRAM_ADDRESS, memo?: string) =>
        history
          .filter(({ touched }) => touched.has(of))
          .slice(0, limit)
          .map(({ found }) => found)
          .filter(({ memos }) => memo === undefined || (memos ?? []).some((text) => text.includes(memo))),
      signaturesOf: async (of, limit, before, until) => {
        const every = history.filter(({ touched }) => touched.has(of));
        const stop = until === undefined ? -1 : every.findIndex(({ found }) => found.signature === until);
        const touching = stop === -1 ? every : every.slice(0, stop);
        const start = before === undefined ? 0 : touching.findIndex(({ found }) => found.signature === before) + 1;
        return (start === 0 && before !== undefined ? [] : touching.slice(start, start + limit)).map(
          ({ found }): ListedSignature => ({
            signature: found.signature,
            slot: found.slot,
            blockTime: found.blockTime,
            failed: found.failed,
            memo: found.memos === undefined ? null : found.memos.map((text) => `[${text.length}] ${text}`).join("; "),
          }),
        );
      },
      transactionsOf: async (listed) => listed.flatMap(({ signature }) => byId.get(signature) ?? []),
      transactionOf: async (signature) => byId.get(signature) ?? null,
      signatureStatuses: async (signatures) => signatures.map(landing),
      sendStatus: async (asked, lastValidBlockHeight) => {
        const known = askedSignature(asked);
        const failed = failures.get(known);
        if (failed !== undefined) {
          return { status: "failed", ...failed };
        }
        const found = byId.get(known);
        if (found !== undefined) {
          return { status: "confirmed", signature: known, slot: found.slot };
        }
        return lastValidBlockHeight !== undefined && height() > lastValidBlockHeight ? { status: "expired", signature: known } : { status: "pending", signature: known };
      },
      firstAvailableSlot: async () => 0n,
      recentFees: async () => [],
      budget: async (instructions) => [...instructions],
      airdrop: async (address, amount) => {
        const result = svm.airdrop(address, lamports(amount));
        if (result === null) {
          throw new InvalidInput("lamports", "range", `LiteSVM cannot airdrop ${amount} lamports`);
        }
        const signature = signatureFrom(getBase58Decoder().decode((result instanceof FailedTransactionMetadata ? result.meta() : result).signature()));
        if (result instanceof FailedTransactionMetadata) {
          const logs = result.meta().logs();
          throw failedOnChain(failure(signature, errOf(result), logs), logs);
        }
        return signature;
      },
    };
    return observable(by.quiet ? members : memberRequests(members, by), (next) => facade(joined(by, next)));
  };
  return facade(QUIET);
}
