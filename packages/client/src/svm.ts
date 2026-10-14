import {
  type Address,
  appendTransactionMessageInstructions,
  type Blockhash,
  createTransactionMessage,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getAddressDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners,
  type Transaction,
} from "@solana/kit";
import { getIntentDecoder, getIntentDiscriminatorBytes, INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core";
import { FailedTransactionMetadata, type LiteSVM } from "litesvm";
import { TOKEN_PROGRAMS } from "./accounts.js";
import {
  type EngineTransaction,
  keysAt,
  type ListedSignature,
  MEMO_PROGRAM_ADDRESS,
  type ProgramAccount,
  signersAmong,
  type TokenHolding,
  type Transport,
} from "./transport.js";

const TOKEN_HEAD = 64;
const LOOKUP_TABLE_HEAD = 56;

export type SvmTransportOptions = { genesisHash?: string };

export const SVM_GENESIS_HASH = "11111111111111111111111111111111";

const sigverifyOf = (svm: LiteSVM): boolean =>
  (svm as unknown as { inner?: { getSigverify?: () => boolean } }).inner?.getSigverify?.() ?? true;

const decodeWire = (wire: string) => getTransactionDecoder().decode(getBase64Encoder().encode(wire));

export function svmTransport(svm: LiteSVM, options: SvmTransportOptions = {}): Transport {
  const seen = new Set<Address>();
  const tag = getIntentDiscriminatorBytes();
  const engineData = (address: Address): Uint8Array | null => {
    const account = svm.getAccount(address);
    return account.exists && account.programAddress === INTENT_ENGINE_PROGRAM_ADDRESS ? new Uint8Array(account.data) : null;
  };
  const history: { touched: ReadonlySet<Address>; found: EngineTransaction }[] = [];
  const byId = new Map<string, EngineTransaction>();
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
  const loaded = (compiled: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]>): Address[] => {
    const lookups = "addressTableLookups" in compiled ? (compiled.addressTableLookups ?? []) : [];
    const tables = lookups.map(({ lookupTableAddress }) => tableAddresses(lookupTableAddress));
    const pick = (indexes: (lookup: (typeof lookups)[number]) => readonly number[]) =>
      lookups.flatMap((lookup, i) => indexes(lookup).flatMap((index) => tables[i]?.[index] ?? []));
    return [...compiled.staticAccounts, ...pick(({ writableIndexes }) => writableIndexes), ...pick(({ readonlyIndexes }) => readonlyIndexes)];
  };
  const landed = (tx: Transaction): string => {
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const keys = loaded(compiled);
    const before = holdings(keys);
    const result = svm.sendTransaction(tx);
    if (result instanceof FailedTransactionMetadata) {
      throw new Error(`${String(result.err())}\n${result.meta().logs().join("\n")}`);
    }
    const after = holdings(keys).filter((held) => !before.some(({ account }) => account === held.account));
    const tokens = [...before, ...after];
    for (const address of keys) {
      const data = engineData(address);
      if (data !== null && tag.every((b, i) => data[i] === b)) {
        seen.add(address);
      }
    }
    const signature = getSignatureFromTransaction(tx);
    const clock = svm.getClock();
    const memoInstructions = ("instructions" in compiled ? compiled.instructions : []).filter((ix) => keys[ix.programAddressIndex] === MEMO_PROGRAM_ADDRESS);
    const memos = memoInstructions.map((ix) => new TextDecoder().decode(Uint8Array.from(ix.data ?? [])));
    const memoSigners = memoInstructions.map((ix) => signersAmong(keys, ix.accountIndices ?? [], compiled.header.numSignerAccounts));
    const feePayer = keys[0];
    const engineCalls = ("instructions" in compiled ? compiled.instructions : []).filter((ix) => keys[ix.programAddressIndex] === INTENT_ENGINE_PROGRAM_ADDRESS);
    const called = engineCalls.map((ix) => Uint8Array.from(ix.data ?? []));
    const inner = result
      .innerInstructions()
      .flat()
      .map((ix) => ix.instruction())
      .filter((ix) => keys[ix.programIdIndex()] === INTENT_ENGINE_PROGRAM_ADDRESS);
    const found: EngineTransaction = {
      signature,
      slot: clock.slot,
      blockTime: clock.unixTimestamp,
      failed: false,
      emitted: inner.map((ix) => new Uint8Array(ix.data())),
      ...(inner.length === 0 ? {} : { emittedAccounts: inner.map((ix) => keysAt(keys, ix.accounts())) }),
      ...(memos.length === 0 ? {} : { memos, memoSigners }),
      ...(feePayer === undefined ? {} : { feePayer }),
      ...(called.length === 0 ? {} : { called, calledAccounts: engineCalls.map((ix) => keysAt(keys, ix.accountIndices ?? [])) }),
      ...(tokens.length === 0 ? {} : { tokens }),
    };
    history.unshift({ touched: new Set(keys), found });
    byId.set(signature, found);
    return signature;
  };
  const getAccount = async (address: Address) => {
    const account = svm.getAccount(address);
    return account.exists
      ? { owner: account.programAddress, data: new Uint8Array(account.data), lamports: account.lamports, executable: account.executable }
      : null;
  };
  return {
    getAccount,
    getAccounts: async (addresses) => Promise.all(addresses.map(getAccount)),
    send: async (instructions, payer) => {
      svm.expireBlockhash();
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(payer, m),
        (m) => svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
        (m) => appendTransactionMessageInstructions(instructions, m),
      );
      return landed(await signTransactionMessageWithSigners(message));
    },
    latestBlockhash: async () => ({ blockhash: svm.latestBlockhash() as Blockhash, lastValidBlockHeight: 0n }),
    sendWire: async (wire) => landed(decodeWire(wire)),
    submitWire: async (wire) => landed(decodeWire(wire)),
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
    intents: async (owner) => {
      const found: ProgramAccount[] = [];
      for (const address of seen) {
        const data = engineData(address);
        if (data !== null && (owner === undefined || getIntentDecoder().decode(data).owner === owner)) {
          found.push({ address, data });
        }
      }
      return found;
    },
    engineTransactions: async (limit, of = INTENT_ENGINE_PROGRAM_ADDRESS, memo?: string) =>
      history
        .filter(({ touched }) => touched.has(of))
        .slice(0, limit)
        .map(({ found }) => found)
        .filter(({ memos }) => memo === undefined || (memos ?? []).some((text) => text.includes(memo))),
    signaturesOf: async (of, limit, before) => {
      const touching = history.filter(({ touched }) => touched.has(of));
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
    firstAvailableSlot: async () => 0n,
    recentFees: async () => [],
    budget: async (instructions) => [...instructions],
    airdrop: async (address, amount) => {
      svm.airdrop(address, lamports(amount));
      return `airdrop-${address}-${amount}`;
    },
  };
}
