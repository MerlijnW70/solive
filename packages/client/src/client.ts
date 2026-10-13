import { type Address, createSolanaRpc, type Instruction, type Signature, type TransactionSigner } from "@solana/kit";
import { type Config, getIntentDecoder, type Intent, nextFreeNonce } from "@intent-engine/core";
import { loadConfig, loadIntent, loadUser, MissingAccount } from "./accounts.js";
import { budgeted, type Priority, simulated } from "./budget.js";
import { type EngineError, explain } from "./errors.js";
import {
  changesFrom,
  intentNotifications,
  type Notifications,
  pause,
  type ProgramAccount,
  type RpcLike,
  rpcTransport,
  type Simulation,
  signatureWatch,
  type Transport,
} from "./transport.js";

export type ClientOptions = {
  url: string;
  transport?: Transport;
  notifications?: Notifications;
  priority?: Priority;
  pollMs?: number;
};

export type IntentAccount = { address: Address; intent: Intent };

export type IntentFilter = { owner?: Address; status?: number };

export type Client = {
  readonly url: string;
  readonly transport: Transport;
  config(): Promise<Config>;
  intent(owner: Address, nonce: bigint): Promise<IntentAccount | null>;
  intents(filter?: IntentFilter): Promise<IntentAccount[]>;
  nextNonce(owner: Address): Promise<bigint>;
  simulate(instructions: readonly Instruction[], signer: TransactionSigner): Promise<Simulation>;
  send(instructions: readonly Instruction[], signer: TransactionSigner): Promise<Signature>;
  watch(onChange: (changed: IntentAccount[]) => void, signal: AbortSignal, filter?: { owner?: Address }): Promise<void>;
  explain(error: unknown): EngineError | null;
};

export const WATCH_POLL_MS = 2_000;
export const WATCH_WAIT_SECONDS = 30;

export class NoFreeNonce extends Error {
  readonly owner: Address;

  constructor(owner: Address) {
    super(`every nonce in the window of ${owner} is used; advance the nonce window first`);
    this.name = "NoFreeNonce";
    this.owner = owner;
  }
}

const decoded = ({ address, data }: ProgramAccount): IntentAccount => ({ address, intent: getIntentDecoder().decode(data) });

export function createClient(options: ClientOptions): Client {
  const { url, priority = 0n, pollMs = WATCH_POLL_MS } = options;
  const transport =
    options.transport ?? rpcTransport(createSolanaRpc(url) as unknown as RpcLike, undefined, signatureWatch(url));
  const notifications = options.notifications ?? (options.transport === undefined ? intentNotifications(url) : undefined);

  const watch = async (onChange: (changed: IntentAccount[]) => void, signal: AbortSignal, filter: { owner?: Address } = {}) => {
    if (signal.aborted) {
      return;
    }
    const seen = new Map<Address, string>();
    const emit = (accounts: readonly ProgramAccount[]) => {
      const changed = accounts
        .filter(({ address, data }) => {
          const key = Buffer.from(data).toString("base64");
          if (seen.get(address) === key) {
            return false;
          }
          seen.set(address, key);
          return true;
        })
        .map(decoded)
        .filter(({ intent }) => filter.owner === undefined || intent.owner === filter.owner);
      if (changed.length > 0 && !signal.aborted) {
        onChange(changed);
      }
    };
    if (notifications === undefined) {
      while (!signal.aborted) {
        emit(await transport.intents(filter.owner));
        await pause(pollMs, signal);
      }
      return;
    }
    const changes = changesFrom(notifications);
    const stop = () => changes.close();
    signal.addEventListener("abort", stop, { once: true });
    try {
      emit(await transport.intents(filter.owner));
      while (!signal.aborted) {
        emit((await changes.wait(WATCH_WAIT_SECONDS)) ?? []);
      }
    } finally {
      signal.removeEventListener("abort", stop);
      changes.close();
    }
  };

  return {
    url,
    transport,
    config: async () => (await loadConfig(transport)).config,
    intent: async (owner, nonce) => {
      try {
        return await loadIntent(transport, owner, nonce);
      } catch (error) {
        if (error instanceof MissingAccount) {
          return null;
        }
        throw error;
      }
    },
    intents: async (filter = {}) =>
      (await transport.intents(filter.owner))
        .map(decoded)
        .filter(({ intent }) => filter.status === undefined || intent.status === filter.status),
    nextNonce: async (owner) => {
      const user = await loadUser(transport, owner);
      if (user === null) {
        return 0n;
      }
      const next = nextFreeNonce(user);
      if (next === null) {
        throw new NoFreeNonce(owner);
      }
      return next;
    },
    simulate: async (instructions, signer) =>
      simulated(transport, await budgeted(transport, priority, instructions, signer.address), signer.address),
    send: async (instructions, signer) =>
      (await transport.send(await budgeted(transport, priority, instructions, signer.address), signer)) as Signature,
    watch,
    explain,
  };
}
