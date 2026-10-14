import {
  type Address,
  appendTransactionMessageInstructions,
  type Blockhash,
  createTransactionMessage,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
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
import { type EngineTransaction, MEMO_PROGRAM_ADDRESS, type ProgramAccount, type Transport } from "./transport.js";

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
  const landed = (tx: Transaction): string => {
    const result = svm.sendTransaction(tx);
    if (result instanceof FailedTransactionMetadata) {
      throw new Error(`${String(result.err())}\n${result.meta().logs().join("\n")}`);
    }
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const keys = compiled.staticAccounts;
    for (const address of keys) {
      const data = engineData(address);
      if (data !== null && tag.every((b, i) => data[i] === b)) {
        seen.add(address);
      }
    }
    const signature = getSignatureFromTransaction(tx);
    const clock = svm.getClock();
    const memos = ("instructions" in compiled ? compiled.instructions : [])
      .filter((ix) => keys[ix.programAddressIndex] === MEMO_PROGRAM_ADDRESS)
      .map((ix) => new TextDecoder().decode(Uint8Array.from(ix.data ?? [])));
    const feePayer = keys[0];
    history.unshift({
      touched: new Set(keys),
      found: {
        signature,
        slot: clock.slot,
        blockTime: clock.unixTimestamp,
        failed: false,
        emitted: result
          .innerInstructions()
          .flat()
          .map((inner) => inner.instruction())
          .filter((ix) => keys[ix.programIdIndex()] === INTENT_ENGINE_PROGRAM_ADDRESS)
          .map((ix) => new Uint8Array(ix.data())),
        ...(memos.length === 0 ? {} : { memos }),
        ...(feePayer === undefined ? {} : { feePayer }),
      },
    });
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
    recentFees: async () => [],
    budget: async (instructions) => [...instructions],
    airdrop: async (address, amount) => {
      svm.airdrop(address, lamports(amount));
      return `airdrop-${address}-${amount}`;
    },
  };
}
