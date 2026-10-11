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
};

export type Latest = { blockhash: Blockhash; lastValidBlockHeight: bigint };

export type Simulation = { err: string | null; logs: string[]; unitsConsumed: bigint | null; accounts: (Uint8Array | null)[] };

export interface Transport {
  getAccount(address: Address): Promise<AccountView | null>;
  send(instructions: readonly Instruction[], payer: TransactionSigner): Promise<string>;
  latestBlockhash(): Promise<Latest>;
  sendWire(wire: Base64EncodedWireTransaction, latest: Latest): Promise<string>;
  submitWire(wire: Base64EncodedWireTransaction): Promise<string>;
  simulate(wire: Base64EncodedWireTransaction, watch?: readonly Address[]): Promise<Simulation>;
  genesisHash(): Promise<string>;
  intents(owner?: Address): Promise<ProgramAccount[]>;
  engineTransactions(limit: number): Promise<EngineTransaction[]>;
  recentFees(accounts: readonly Address[]): Promise<bigint[]>;
  budget(instructions: readonly Instruction[], feePayer: Address): Promise<Instruction[]>;
  airdrop(address: Address, lamports: bigint): Promise<string>;
}

type Pending<T> = { send(): Promise<T> };

export type RpcLike = {
  getAccountInfo(
    address: Address,
    config: { encoding: "base64" },
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
  ): Pending<{ value: readonly ({ err: unknown; confirmationStatus: string | null } | null)[] }>;
  getBlockHeight(): Pending<bigint>;
  requestAirdrop(address: Address, lamports: bigint): Pending<Signature>;
  getRecentPrioritizationFees(addresses: readonly Address[]): Pending<readonly { prioritizationFee: bigint }[]>;
  getGenesisHash(): Pending<string>;
  getProgramAccounts(
    program: Address,
    config: {
      encoding: "base64";
      filters: readonly (
        | { dataSize: bigint }
        | { memcmp: { offset: bigint; bytes: string; encoding: "base58" } }
      )[];
    },
  ): Pending<readonly { pubkey: Address; account: { data: readonly [string, string] } }[]>;
  getSignaturesForAddress(
    address: Address,
    config: { limit: number },
  ): Pending<readonly { signature: Signature; slot: bigint; blockTime: bigint | null; err: unknown }[]>;
  getTransaction(
    signature: Signature,
    config: { encoding: "json"; maxSupportedTransactionVersion: 0; commitment: "confirmed" },
  ): Pending<{
    transaction: { message: { accountKeys: readonly Address[] } };
    meta: {
      loadedAddresses?: { writable: readonly Address[]; readonly: readonly Address[] };
      innerInstructions?: readonly { instructions: readonly { programIdIndex: number; data: string }[] }[] | null;
    } | null;
  } | null>;
};

export const POLL_MS = 500;
export const CONFIRM_POLLS = 360;

const INTENT_OWNER_OFFSET = 8n;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const RATE_LIMIT_ATTEMPTS = 6;

export function rateLimited(error: unknown): boolean {
  return error instanceof Error && /\b429\b/.test(error.message);
}

export async function patiently<T>(call: () => Promise<T>, wait: (ms: number) => Promise<void> = sleep): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (!rateLimited(error) || attempt >= RATE_LIMIT_ATTEMPTS) {
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

export async function confirm(
  rpc: RpcLike,
  signature: Signature,
  lastValidBlockHeight: bigint,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<void> {
  for (let poll = 1; ; poll++) {
    const [status] = (await patiently(() => rpc.getSignatureStatuses([signature]).send(), wait)).value;
    if (status) {
      if (status.err !== null) {
        throw new Charged(`transaction ${signature} failed: ${inspect(status.err)}`);
      }
      if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
        return;
      }
    }
    if ((await patiently(() => rpc.getBlockHeight().send(), wait)) > lastValidBlockHeight) {
      throw new Error(`transaction ${signature} expired before confirmation`);
    }
    if (poll >= CONFIRM_POLLS) {
      throw new Charged(
        `transaction ${signature} was neither confirmed nor expired after ${CONFIRM_POLLS} checks; the node may be stuck, so look the signature up before sending again`,
      );
    }
    await wait(POLL_MS);
  }
}

export function rpcTransport(rpc: RpcLike, wait?: (ms: number) => Promise<void>): Transport {
  return {
    async getAccount(address) {
      const { value } = await patiently(() => rpc.getAccountInfo(address, { encoding: "base64" }).send(), wait);
      return value === null
        ? null
        : {
            owner: value.owner,
            data: new Uint8Array(Buffer.from(value.data[0], "base64")),
            lamports: value.lamports,
            executable: value.executable,
          };
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
      await confirm(rpc, signature, latest.lastValidBlockHeight, wait);
      return signature;
    },
    async airdrop(address, lamports) {
      const { value: latest } = await patiently(() => rpc.getLatestBlockhash().send(), wait);
      const signature = await rpc.requestAirdrop(address, lamports).send();
      await confirm(rpc, signature, latest.lastValidBlockHeight, wait);
      return signature;
    },
    async latestBlockhash() {
      const { value } = await patiently(() => rpc.getLatestBlockhash().send(), wait);
      return value;
    },
    async sendWire(wire, latest) {
      const signature = await patiently(() => rpc.sendTransaction(wire, { encoding: "base64" }).send(), wait);
      await confirm(rpc, signature, latest.lastValidBlockHeight, wait);
      return signature;
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
    async engineTransactions(limit) {
      const signatures = await patiently(
        () => rpc.getSignaturesForAddress(INTENT_ENGINE_PROGRAM_ADDRESS, { limit }).send(),
        wait,
      );
      const found: EngineTransaction[] = [];
      for (const entry of signatures) {
        const tx = await patiently(
          () =>
            rpc
              .getTransaction(entry.signature, {
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
        found.push({
          signature: entry.signature,
          slot: entry.slot,
          blockTime: entry.blockTime,
          failed: entry.err !== null,
          emitted,
        });
      }
      return found;
    },
    async intents(owner) {
      const found = await patiently(
        () =>
          rpc
            .getProgramAccounts(INTENT_ENGINE_PROGRAM_ADDRESS, {
              encoding: "base64",
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
            })
            .send(),
        wait,
      );
      return found.map(({ pubkey, account }) => ({
        address: pubkey,
        data: new Uint8Array(Buffer.from(account.data[0], "base64")),
      }));
    },
  };
}

export type IntentChanges = { wait(seconds: number): Promise<ProgramAccount[] | null>; close(): void };

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

export function changesFrom(notifications: Notifications): IntentChanges {
  const controller = new AbortController();
  const pending = new Map<Address, Uint8Array>();
  let wake: (() => void) | undefined;
  const drain = () => {
    const changed = [...pending].map(([address, data]) => ({ address, data }));
    pending.clear();
    return changed;
  };
  const listen = async () => {
    const iterator = (await notifications(controller.signal))[Symbol.asyncIterator]();
    for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) {
      const changed = changedAccount(next.value);
      if (changed !== null) {
        pending.set(changed.address, changed.data);
        wake?.();
      }
    }
  };
  listen().catch(() => undefined);
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
  };
}
