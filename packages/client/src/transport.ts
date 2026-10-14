import { inspect } from "node:util";
import {
  type Address,
  appendTransactionMessageInstructions,
  type Base58EncodedBytes,
  type Base64EncodedWireTransaction,
  type Blockhash,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  type Instruction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Signature,
  signTransactionMessageWithSigners,
  type TransactionSigner,
  getBase58Decoder,
  getBase58Encoder,
} from "@solana/kit";
import { getIntentDiscriminatorBytes, getIntentSize, INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core";

export type AccountView = { owner: Address; data: Uint8Array; lamports: bigint; executable?: boolean };

export type ProgramAccount = { address: Address; data: Uint8Array };

export type EngineTransaction = {
  signature: string;
  slot: bigint;
  blockTime: bigint | null;
  failed: boolean;
  emitted: Uint8Array[];
  memos?: string[];
  memoSigners?: Address[][];
  feePayer?: Address;
  unread?: true;
};

export type ListedSignature = { signature: string; slot: bigint; blockTime: bigint | null; failed: boolean; memo: string | null };

export type Latest = { blockhash: Blockhash; lastValidBlockHeight: bigint };

export type IntentRead = { minContextSlot?: bigint; onSlot?: (slot: bigint) => void };

export type LookupTables = Readonly<Record<Address, Address[]>>;

export type Simulation = { err: string | null; logs: string[]; unitsConsumed: bigint | null; accounts: (Uint8Array | null)[] };

export interface Transport {
  getAccount(address: Address): Promise<AccountView | null>;
  getAccounts(addresses: readonly Address[]): Promise<(AccountView | null)[]>;
  warm?(addresses: readonly Address[]): Promise<void>;
  send(instructions: readonly Instruction[], payer: TransactionSigner): Promise<string>;
  latestBlockhash(): Promise<Latest>;
  sendWire(wire: Base64EncodedWireTransaction, latest: Latest): Promise<string>;
  submitWire(wire: Base64EncodedWireTransaction): Promise<string>;
  simulate(wire: Base64EncodedWireTransaction, watch?: readonly Address[]): Promise<Simulation>;
  genesisHash(): Promise<string>;
  intents(owner?: Address, read?: IntentRead): Promise<ProgramAccount[]>;
  engineTransactions(limit: number, of?: Address, memo?: string): Promise<EngineTransaction[]>;
  signaturesOf?(of: Address, limit: number, before?: string): Promise<ListedSignature[]>;
  transactionsOf?(listed: readonly ListedSignature[]): Promise<EngineTransaction[]>;
  firstAvailableSlot?(): Promise<bigint>;
  recentFees(accounts: readonly Address[]): Promise<bigint[]>;
  budget(instructions: readonly Instruction[], feePayer: Address, tables?: LookupTables): Promise<Instruction[]>;
  airdrop(address: Address, lamports: bigint): Promise<string>;
}

type Pending<T> = { send(): Promise<T> };

type RawAccount = { owner: Address; data: readonly [string, string]; lamports: bigint; executable: boolean };

type AtLeast = { minContextSlot?: bigint };

type ProgramEntry = { pubkey: Address; account: { data: readonly [string, string] } };

type Status = { err: unknown; confirmationStatus: string | null; slot?: bigint };

export type RpcLike = {
  getMultipleAccounts(addresses: Address[], config: { encoding: "base64" } & AtLeast): Pending<{ value: (RawAccount | null)[] }>;
  getAccountInfo(
    address: Address,
    config: { encoding: "base64" } & AtLeast,
  ): Pending<{ value: { owner: Address; data: readonly [string, string]; lamports: bigint; executable: boolean } | null }>;
  getLatestBlockhash(): Pending<{ value: { blockhash: Blockhash; lastValidBlockHeight: bigint } }>;
  sendTransaction(
    wire: Base64EncodedWireTransaction,
    config: { encoding: "base64"; skipPreflight?: boolean },
  ): Pending<Signature>;
  simulateTransaction(
    wire: Base64EncodedWireTransaction,
    config: {
      encoding: "base64";
      sigVerify: false;
      replaceRecentBlockhash: true;
      accounts?: { addresses: Address[]; encoding: "base64" };
    },
  ): Pending<{
    value: {
      err: unknown;
      logs: readonly string[] | null;
      unitsConsumed?: bigint | undefined;
      accounts?: readonly ({ data: readonly [string, string] } | null)[] | null;
    };
  }>;
  getSignatureStatuses(
    signatures: Signature[],
    config?: { searchTransactionHistory: boolean },
  ): Pending<{ context: { slot: bigint }; value: readonly (Status | null)[] }>;
  getEpochInfo(): Pending<{ blockHeight: bigint; absoluteSlot: bigint }>;
  getFirstAvailableBlock?(): Pending<bigint>;
  requestAirdrop(address: Address, lamports: bigint): Pending<Signature>;
  getRecentPrioritizationFees(addresses: readonly Address[]): Pending<readonly { prioritizationFee: bigint }[]>;
  getGenesisHash(): Pending<string>;
  getProgramAccounts(
    program: Address,
    config: {
      encoding: "base64";
      commitment: "confirmed";
      filters: readonly (
        | { dataSize: bigint }
        | { memcmp: { offset: bigint; bytes: string; encoding: "base58" } }
      )[];
      withContext?: true;
    } & AtLeast,
  ): Pending<readonly ProgramEntry[] | { context: { slot: bigint }; value: readonly ProgramEntry[] }>;
  getSignaturesForAddress(
    address: Address,
    config: { limit: number; before?: Signature } & AtLeast,
  ): Pending<readonly { signature: Signature; slot: bigint; blockTime: bigint | null; err: unknown; memo?: string | null }[]>;
  getTransaction(
    signature: Signature,
    config: { encoding: "json"; maxSupportedTransactionVersion: 0; commitment: "confirmed" },
  ): Pending<{
    transaction: {
      message: {
        accountKeys: readonly Address[];
        header?: { numRequiredSignatures: number };
        instructions?: readonly { programIdIndex: number; accounts?: readonly number[]; data: string }[];
      };
    };
    meta: {
      loadedAddresses?: { writable: readonly Address[]; readonly: readonly Address[] };
      innerInstructions?: readonly { instructions: readonly { programIdIndex: number; data: string }[] }[] | null;
    } | null;
  } | null>;
};

export const MEMO_PROGRAM_ADDRESS = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" as Address;

export function signersAmong(keys: readonly Address[], indices: readonly number[], signing: number): Address[] {
  return [...new Set(indices.filter((index) => index < signing).flatMap((index) => keys[index] ?? []))];
}

export const POLL_MS = 500;
export const CONFIRM_POLLS = 360;

const INTENT_OWNER_OFFSET = 8n;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const RATE_LIMIT_ATTEMPTS = 6;

export function rateLimited(error: unknown): boolean {
  return error instanceof Error && !(error instanceof Charged) && /\b429\b/.test(error.message);
}

export const MIN_CONTEXT_SLOT_NOT_REACHED = -32016;

export function behindMinSlot(error: unknown): boolean {
  if (!(error instanceof Error) || error instanceof Charged) {
    return false;
  }
  const code = (error as { context?: { __code?: unknown } }).context?.__code;
  return code === MIN_CONTEXT_SLOT_NOT_REACHED || /-32016\b|minimum context slot/i.test(error.message);
}

export async function patiently<T>(call: () => Promise<T>, wait: (ms: number) => Promise<void> = sleep): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (!(rateLimited(error) || behindMinSlot(error)) || attempt >= RATE_LIMIT_ATTEMPTS) {
        throw error;
      }
      await wait(POLL_MS * 2 ** attempt);
    }
  }
}

export class Charged extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Charged";
  }
}

export class FailedOnChain extends Charged {}

export class BlockhashExpired extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockhashExpired";
  }
}

const withoutMark = ({ complete: _, ...found }: EngineTransaction & { complete: boolean }): EngineTransaction => found;

export const neverLanded = (error: unknown): boolean => error instanceof FailedOnChain || error instanceof BlockhashExpired;

export type Confirmed = { slot?: bigint };

export type SignatureWatch = (signature: Signature, signal: AbortSignal) => Promise<Confirmed | void>;

export function signatureWatch(url: string): SignatureWatch {
  const subscriptions = createSolanaRpcSubscriptions(socketUrl(url));
  return async (signature, abortSignal) => {
    const notes = await subscriptions.signatureNotifications(signature, { commitment: "confirmed" }).subscribe({ abortSignal });
    const iterator = notes[Symbol.asyncIterator]();
    const next = await iterator.next();
    if (next.done === true) {
      throw new Error(`the signature subscription for ${signature} ended without a notification`);
    }
    return heardSlot(signature, next.value);
  };
}

export function heardSlot(signature: Signature, note: unknown): Confirmed {
  const { context, value } = (note ?? {}) as { context?: { slot?: unknown }; value?: { err?: unknown } };
  const err = value?.err ?? null;
  if (err !== null) {
    throw new FailedOnChain(`transaction ${signature} failed: ${inspect(err)}`);
  }
  return typeof context?.slot === "bigint" ? { slot: context.slot } : {};
}

const never = new Promise<Confirmed>(() => undefined);

export async function confirm(
  rpc: RpcLike,
  signature: Signature,
  lastValidBlockHeight: bigint,
  wait: (ms: number) => Promise<void> = sleep,
  watch?: SignatureWatch,
): Promise<Confirmed> {
  if (watch === undefined) {
    return polled(rpc, signature, lastValidBlockHeight, wait);
  }
  const controller = new AbortController();
  const heard = watch(signature, controller.signal).then(
    (found) => found ?? {},
    (error: unknown) => {
      if (error instanceof Charged) {
        throw error;
      }
      return never;
    },
  );
  try {
    return await Promise.race([heard, polled(rpc, signature, lastValidBlockHeight, wait, controller.signal)]);
  } finally {
    controller.abort();
  }
}

function settled(signature: Signature, status: Status | null | undefined): Confirmed | null {
  if (!status || (status.confirmationStatus !== "confirmed" && status.confirmationStatus !== "finalized")) {
    return null;
  }
  if (status.err !== null) {
    throw new FailedOnChain(`transaction ${signature} failed: ${inspect(status.err)}`);
  }
  return status.slot === undefined ? {} : { slot: status.slot };
}

export async function confirmSent(
  rpc: RpcLike,
  signature: Signature,
  lastValidBlockHeight: bigint,
  wait: (ms: number) => Promise<void> = sleep,
  watch?: SignatureWatch,
): Promise<Confirmed> {
  try {
    return await confirm(rpc, signature, lastValidBlockHeight, wait, watch);
  } catch (error) {
    if (error instanceof Charged || error instanceof BlockhashExpired) {
      throw error;
    }
    throw new Charged(
      `transaction ${signature} was sent but its confirmation could not be read (${error instanceof Error ? error.message : String(error)}); look the signature up before sending again`,
    );
  }
}

async function polled(
  rpc: RpcLike,
  signature: Signature,
  lastValidBlockHeight: bigint,
  wait: (ms: number) => Promise<void>,
  stop?: AbortSignal,
): Promise<Confirmed> {
  for (let poll = 1; stop?.aborted !== true; poll++) {
    const [status] = (await patiently(() => rpc.getSignatureStatuses([signature]).send(), wait)).value;
    const confirmed = settled(signature, status);
    if (confirmed !== null) {
      return confirmed;
    }
    const epoch = await patiently(() => rpc.getEpochInfo().send(), wait);
    if (epoch.blockHeight > lastValidBlockHeight) {
      const late = await patiently(() => rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send(), wait);
      const [found] = late.value;
      const landed = settled(signature, found);
      if (landed !== null) {
        return landed;
      }
      if (found) {
        throw new Charged(`transaction ${signature} landed but is not confirmed yet; look the signature up before sending again`);
      }
      if (late.context.slot >= epoch.absoluteSlot) {
        throw new BlockhashExpired(`transaction ${signature} expired before confirmation`);
      }
    }
    if (poll >= CONFIRM_POLLS) {
      throw new Charged(
        `transaction ${signature} was neither confirmed nor expired after ${CONFIRM_POLLS} checks; the node may be stuck, so look the signature up before sending again`,
      );
    }
    await wait(POLL_MS);
  }
  return {};
}

export const MULTIPLE_ACCOUNTS_LIMIT = 100;

function viewOf(value: RawAccount | null): AccountView | null {
  return value === null
    ? null
    : { owner: value.owner, data: new Uint8Array(Buffer.from(value.data[0], "base64")), lamports: value.lamports, executable: value.executable };
}

export const TRANSACTION_FETCHES = 4;
export const KEPT_TRANSACTIONS = 256;

export function boundMembers<T extends object>(inner: T): T {
  const members: Record<PropertyKey, unknown> = {};
  for (let at: object | null = inner; at !== null && at !== Object.prototype; at = Object.getPrototypeOf(at) as object | null) {
    for (const key of Reflect.ownKeys(at)) {
      if (key === "constructor" || Object.prototype.hasOwnProperty.call(members, key)) {
        continue;
      }
      const value: unknown = Reflect.get(inner, key);
      members[key] = typeof value === "function" ? value.bind(inner) : value;
    }
  }
  return members as T;
}

const MEMOIZED = Symbol("memoized");
const UNDERLYING = Symbol("underlying");

export const unmemoized = (transport: Transport): Transport =>
  (transport as { [UNDERLYING]?: Transport })[UNDERLYING] ?? transport;

export function memoized(inner: Transport): Transport {
  if ((inner as { [MEMOIZED]?: true })[MEMOIZED] === true) {
    return inner;
  }
  const members = boundMembers(inner);
  const seen = new Map<Address, Promise<AccountView | null>>();
  const keep = (address: Address, pending: Promise<AccountView | null>) => {
    seen.set(address, pending);
    pending.catch(() => {
      if (seen.get(address) === pending) {
        seen.delete(address);
      }
    });
    return pending;
  };
  const getAccount = (address: Address) => seen.get(address) ?? keep(address, members.getAccount(address));
  const warm = async (addresses: readonly Address[]) => {
    const missing = [...new Set(addresses)].filter((address) => !seen.has(address));
    if (missing.length === 0) {
      return;
    }
    const fetched = members.getAccounts(missing);
    missing.forEach((address, i) => keep(address, fetched.then((views) => views[i] ?? null)));
    await fetched;
  };
  const writing =
    <A extends unknown[], R>(write: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        return await write(...args);
      } finally {
        seen.clear();
      }
    };
  return {
    ...members,
    [MEMOIZED]: true,
    [UNDERLYING]: inner,
    getAccount,
    send: writing(members.send),
    sendWire: writing(members.sendWire),
    submitWire: writing(members.submitWire),
    airdrop: writing(members.airdrop),
    getAccounts: async (addresses) => {
      await warm(addresses);
      return Promise.all(addresses.map(getAccount));
    },
    warm,
  } as Transport;
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
  const load = async (entry: ListedSignature): Promise<EngineTransaction & { complete: boolean }> => {
    const tx = await patiently(
      () =>
        rpc
          .getTransaction(entry.signature as Signature, {
            encoding: "json",
            maxSupportedTransactionVersion: 0,
            commitment: "confirmed",
          })
          .send(),
      wait,
    );
    const keys = [
      ...(tx?.transaction.message.accountKeys ?? []),
      ...(tx?.meta?.loadedAddresses?.writable ?? []),
      ...(tx?.meta?.loadedAddresses?.readonly ?? []),
    ];
    const emitted = (tx?.meta?.innerInstructions ?? [])
      .flatMap((group) => group.instructions)
      .filter((ix) => keys[ix.programIdIndex] === INTENT_ENGINE_PROGRAM_ADDRESS)
      .map((ix) => Uint8Array.from(getBase58Encoder().encode(ix.data)));
    const signing = tx?.transaction.message.header?.numRequiredSignatures ?? 0;
    const memoInstructions = (tx?.transaction.message.instructions ?? []).filter((ix) => keys[ix.programIdIndex] === MEMO_PROGRAM_ADDRESS);
    const memos = memoInstructions.map((ix) => new TextDecoder().decode(Uint8Array.from(getBase58Encoder().encode(ix.data))));
    const memoSigners = memoInstructions.map((ix) => signersAmong(keys, ix.accounts ?? [], signing));
    const feePayer = tx?.transaction.message.accountKeys[0];
    return {
      signature: entry.signature,
      slot: entry.slot,
      blockTime: entry.blockTime,
      failed: entry.failed,
      emitted,
      ...(memos.length === 0 ? {} : { memos, memoSigners }),
      ...(feePayer === undefined ? {} : { feePayer }),
      ...(tx?.meta === null || tx?.meta === undefined ? { unread: true as const } : {}),
      complete: tx?.meta !== null && tx?.meta !== undefined && entry.blockTime !== null,
    };
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
      const wire = getBase64EncodedWireTransaction(signed);
      const signature = await patiently(() => rpc.sendTransaction(wire, { encoding: "base64" }).send(), wait);
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
      const signature = await patiently(() => rpc.sendTransaction(wire, { encoding: "base64" }).send(), wait);
      return confirmed(signature, latest.lastValidBlockHeight);
    },
    async submitWire(wire) {
      return patiently(() => rpc.sendTransaction(wire, { encoding: "base64", skipPreflight: true }).send(), wait);
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
    ...(firstBlock === undefined ? {} : { firstAvailableSlot: () => patiently(() => firstBlock().send(), wait) }),
    async intents(owner, read) {
      const least = atLeast(read?.minContextSlot);
      const found = await patiently(async () => {
        const response = await rpc
          .getProgramAccounts(INTENT_ENGINE_PROGRAM_ADDRESS, {
            encoding: "base64",
            commitment: "confirmed",
            filters: [
              { dataSize: BigInt(getIntentSize()) },
              {
                memcmp: {
                  offset: 0n,
                  bytes: getBase58Decoder().decode(getIntentDiscriminatorBytes()),
                  encoding: "base58",
                },
              },
              ...(owner === undefined
                ? []
                : [{ memcmp: { offset: INTENT_OWNER_OFFSET, bytes: owner as string, encoding: "base58" as const } }]),
            ],
            ...least,
            ...(read === undefined ? {} : { withContext: true as const }),
          })
          .send();
        if (!("context" in response)) {
          return response;
        }
        if (least.minContextSlot !== undefined && response.context.slot < least.minContextSlot) {
          throw new Error(
            `Minimum context slot has not been reached: the node read at slot ${response.context.slot}, below ${least.minContextSlot}`,
          );
        }
        read?.onSlot?.(response.context.slot);
        return response.value;
      }, wait);
      return found.map(({ pubkey, account }) => ({
        address: pubkey,
        data: new Uint8Array(Buffer.from(account.data[0], "base64")),
      }));
    },
  };
}

export type IntentChanges = { wait(seconds: number): Promise<ProgramAccount[] | null>; close(): void; slot?(): bigint | undefined };

export type Notifications = (signal: AbortSignal) => Promise<AsyncIterable<unknown>>;

export function socketUrl(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === "http:" ? "ws:" : "wss:";
  if (parsed.port === "8899") {
    parsed.port = "8900";
  }
  return parsed.toString();
}

export function intentNotifications(url: string): Notifications {
  const subscriptions = createSolanaRpcSubscriptions(socketUrl(url));
  return (abortSignal) =>
    subscriptions
      .programNotifications(INTENT_ENGINE_PROGRAM_ADDRESS, {
        commitment: "confirmed",
        encoding: "base64",
        filters: [
          { dataSize: BigInt(getIntentSize()) },
          { memcmp: { offset: 0n, bytes: getBase58Decoder().decode(getIntentDiscriminatorBytes()) as Base58EncodedBytes, encoding: "base58" } },
        ],
      })
      .subscribe({ abortSignal });
}

export function changedAccount(note: unknown): ProgramAccount | null {
  const value = (note as { value?: { pubkey?: unknown; account?: { data?: unknown } } } | null)?.value;
  const data = value?.account?.data;
  if (typeof value?.pubkey !== "string" || !Array.isArray(data) || typeof data[0] !== "string") {
    return null;
  }
  return { address: value.pubkey as Address, data: new Uint8Array(Buffer.from(data[0], "base64")) };
}

export const RECONNECT_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];

export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}

export function changesFrom(notifications: Notifications, reconnect: readonly number[] = RECONNECT_MS): IntentChanges {
  const controller = new AbortController();
  const pending = new Map<Address, Uint8Array>();
  let wake: (() => void) | undefined;
  let highest: bigint | undefined;
  const drain = () => {
    const changed = [...pending].map(([address, data]) => ({ address, data }));
    pending.clear();
    return changed;
  };
  let failures = 0;
  const consume = async () => {
    const iterator = (await notifications(controller.signal))[Symbol.asyncIterator]();
    for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) {
      failures = 0;
      const changed = changedAccount(next.value);
      if (changed !== null) {
        const slot = (next.value as { context?: { slot?: unknown } }).context?.slot;
        if (typeof slot === "bigint" && (highest === undefined || slot > highest)) {
          highest = slot;
        }
        pending.set(changed.address, changed.data);
        wake?.();
      }
    }
  };
  const listen = async () => {
    while (!controller.signal.aborted) {
      await consume().catch(() => undefined);
      if (controller.signal.aborted) {
        return;
      }
      await pause(reconnect[Math.min(failures, reconnect.length - 1)] ?? 0, controller.signal);
      failures++;
    }
  };
  void listen();
  return {
    wait: (seconds) =>
      new Promise((resolve) => {
        if (pending.size > 0) {
          resolve(drain());
          return;
        }
        const timer = setTimeout(() => {
          wake = undefined;
          resolve([]);
        }, seconds * 1000);
        wake = () => {
          clearTimeout(timer);
          wake = undefined;
          resolve(drain());
        };
      }),
    close: () => {
      wake?.();
      controller.abort();
    },
    slot: () => highest,
  };
}
