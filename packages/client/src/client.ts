import { type Address, createSolanaRpc, type Instruction, type KeyPairSigner, type Signature, type TransactionSigner } from "@solana/kit";
import {
  attestedProofMessage,
  buildCancelIntent,
  buildCreateIntent,
  buildFillAttested,
  type Config,
  decodeParams,
  escrowAmount,
  feeBpsFor,
  findIntentPda,
  getIntentDecoder,
  type Intent,
  type IntentParams,
  IntentStatus,
  Kind,
  nextFreeNonce,
  signEd25519Instruction,
  splitFees,
} from "@intent-engine/core";
import { chainTime, loadConfig, loadIntent, loadUser, MissingAccount, mintOf, type NonceWindow } from "./accounts.js";
import { budgeted, type Priority, simulated } from "./budget.js";
import { type EngineError, explain } from "./errors.js";
import { initUserIfMissing, tokenAccountIfMissing, wrapIfShort } from "./setup.js";
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
  resyncSeconds?: number;
};

export type IntentAccount = { address: Address; intent: Intent };

export type IntentFilter = { owner?: Address; status?: number };

export type WatchCallback = (changed: IntentAccount[], closed: Address[]) => void;

export type Mint = { decimals: number; tokenProgram: Address };

export type CreateIntentInput = {
  signer: TransactionSigner;
  params: IntentParams;
  inputMint: Address;
  outputMint: Address;
  expiresIn?: bigint;
  expiresAt?: bigint;
  nonce?: bigint;
  receiver?: Address;
};

export type CreatedIntent = { signature: Signature; intent: Address; nonce: bigint };

export type SettleProofInput = {
  judge: KeyPairSigner;
  owner: Address;
  nonce: bigint;
  payTo: Address;
  result: bigint;
  payer?: TransactionSigner;
};

export type Client = {
  readonly url: string;
  readonly transport: Transport;
  config(): Promise<Config>;
  intent(owner: Address, nonce: bigint): Promise<IntentAccount | null>;
  intents(filter?: IntentFilter): Promise<IntentAccount[]>;
  nextNonce(owner: Address): Promise<bigint>;
  simulate(instructions: readonly Instruction[], signer: TransactionSigner): Promise<Simulation>;
  send(instructions: readonly Instruction[], signer: TransactionSigner): Promise<Signature>;
  watch(onChange: WatchCallback, signal: AbortSignal, filter?: { owner?: Address }): Promise<void>;
  explain(error: unknown): EngineError | null;
  mint(address: Address): Promise<Mint>;
  chainTime(): Promise<bigint>;
  createIntent(input: CreateIntentInput): Promise<CreatedIntent>;
  cancel(signer: TransactionSigner, nonce: bigint): Promise<Signature>;
  settleProof(input: SettleProofInput): Promise<Signature>;
};

export const DEFAULT_EXPIRES_IN = 3_600n;

export const WATCH_POLL_MS = 2_000;
export const WATCH_WAIT_SECONDS = 10;

export class NoFreeNonce extends Error {
  readonly owner: Address;

  constructor(owner: Address) {
    super(`every nonce in the window of ${owner} is used; advance the nonce window first`);
    this.name = "NoFreeNonce";
    this.owner = owner;
  }
}

export class NotSettleable extends Error {
  readonly intent: Address;

  constructor(intent: Address, reason: string) {
    super(`intent ${intent} ${reason}`);
    this.name = "NotSettleable";
    this.intent = intent;
  }
}

function nonceAfter(owner: Address, user: NonceWindow | null): bigint {
  if (user === null) {
    return 0n;
  }
  const next = nextFreeNonce(user);
  if (next === null) {
    throw new NoFreeNonce(owner);
  }
  return next;
}

const decoded = ({ address, data }: ProgramAccount): IntentAccount => ({ address, intent: getIntentDecoder().decode(data) });

export function createClient(options: ClientOptions): Client {
  const { url, priority = 0n, pollMs = WATCH_POLL_MS, resyncSeconds = WATCH_WAIT_SECONDS } = options;
  const transport =
    options.transport ?? rpcTransport(createSolanaRpc(url) as unknown as RpcLike, undefined, signatureWatch(url));
  const notifications = options.notifications ?? (options.transport === undefined ? intentNotifications(url) : undefined);

  const watch = async (onChange: WatchCallback, signal: AbortSignal, filter: { owner?: Address } = {}) => {
    if (signal.aborted) {
      return;
    }
    const seen = new Map<Address, string>();
    const fresh = (accounts: readonly ProgramAccount[]) =>
      accounts.flatMap((account) => {
        const view = decoded(account);
        if (filter.owner !== undefined && view.intent.owner !== filter.owner) {
          return [];
        }
        const key = Buffer.from(account.data).toString("base64");
        if (seen.get(account.address) === key) {
          return [];
        }
        seen.set(account.address, key);
        return [view];
      });
    const report = (changed: IntentAccount[], closed: Address[]) => {
      if ((changed.length > 0 || closed.length > 0) && !signal.aborted) {
        onChange(changed, closed);
      }
    };
    const sync = async () => {
      const accounts = await transport.intents(filter.owner).catch(() => null);
      if (accounts === null) {
        return;
      }
      const present = new Set(accounts.map(({ address }) => address));
      const changed = fresh(accounts);
      const closed = [...seen.keys()].filter((address) => !present.has(address));
      for (const address of closed) {
        seen.delete(address);
      }
      report(changed, closed);
    };
    if (notifications === undefined) {
      while (!signal.aborted) {
        await sync();
        await pause(pollMs, signal);
      }
      return;
    }
    const changes = changesFrom(notifications);
    const stop = () => changes.close();
    signal.addEventListener("abort", stop, { once: true });
    try {
      await sync();
      let synced = Date.now();
      while (!signal.aborted) {
        report(fresh((await changes.wait(resyncSeconds)) ?? []), []);
        if (!signal.aborted && Date.now() - synced >= resyncSeconds * 1000) {
          await sync();
          synced = Date.now();
        }
      }
    } finally {
      signal.removeEventListener("abort", stop);
      changes.close();
    }
  };

  const config = async () => (await loadConfig(transport)).config;
  const send = async (instructions: readonly Instruction[], signer: TransactionSigner) =>
    (await transport.send(await budgeted(transport, priority, instructions, signer.address), signer)) as Signature;

  const mints = new Map<Address, Promise<Mint>>();
  const mint = (address: Address) => {
    const known = mints.get(address);
    if (known !== undefined) {
      return known;
    }
    const loading = mintOf(transport, address).then(({ decimals, tokenProgram }) => ({ decimals, tokenProgram }));
    mints.set(address, loading);
    loading.catch(() => mints.delete(address));
    return loading;
  };

  const createIntent = async (input: CreateIntentInput): Promise<CreatedIntent> => {
    const { signer, params, inputMint, outputMint } = input;
    const owner = signer.address;
    const [settings, sell, buy, user] = await Promise.all([config(), mint(inputMint), mint(outputMint), loadUser(transport, owner)]);
    const nonce = input.nonce ?? nonceAfter(owner, user);
    const expiresAt = input.expiresAt ?? (await chainTime(transport)) + (input.expiresIn ?? DEFAULT_EXPIRES_IN);
    const recipient = input.receiver ?? owner;
    const receiver = await tokenAccountIfMissing(transport, signer, recipient, outputMint, buy.tokenProgram);
    const wrap = await wrapIfShort(transport, signer, inputMint, sell.tokenProgram, escrowAmount(params));
    const create = await buildCreateIntent({
      owner: signer,
      treasury: settings.feeRecipient,
      maxCreateFee: settings.createFee,
      maxBounty: settings.crankBounty,
      nonce,
      params,
      expiresAt,
      inputMint,
      outputMint,
      inputTokenProgram: sell.tokenProgram,
      outputTokenProgram: buy.tokenProgram,
      ...(recipient === owner ? {} : { receiver: receiver.address, receiverAuthority: recipient }),
    });
    const register = await initUserIfMissing(user, signer);
    const signature = await send([...register, ...receiver.create, ...wrap.instructions, create], signer);
    const [intent] = await findIntentPda({ owner, nonce });
    return { signature, intent, nonce };
  };

  const cancel = async (signer: TransactionSigner, nonce: bigint) => {
    const { intent } = await loadIntent(transport, signer.address, nonce);
    const { tokenProgram } = await mint(intent.inputMint);
    const refund = await tokenAccountIfMissing(transport, signer, signer.address, intent.inputMint, tokenProgram);
    return send([...refund.create, await buildCancelIntent({ owner: signer, nonce, inputMint: intent.inputMint, tokenProgram })], signer);
  };

  const settleProof = async (input: SettleProofInput) => {
    const { judge, owner, nonce, payTo, result } = input;
    const payer = input.payer ?? judge;
    const [{ address, intent: held }, settings] = await Promise.all([loadIntent(transport, owner, nonce), config()]);
    const params = decodeParams(held.kind, Uint8Array.from(held.params));
    if (params.kind !== Kind.AttestedResult) {
      throw new NotSettleable(address, "is not an AttestedResult intent");
    }
    if (params.specHash.every((b) => b === 0)) {
      throw new NotSettleable(address, "commits no spec hash, so it is not a proof intent");
    }
    if (held.status !== IntentStatus.Open) {
      throw new NotSettleable(address, "is not open");
    }
    if (params.attestor !== judge.address) {
      throw new NotSettleable(address, `names ${params.attestor} as its judge, not ${judge.address}`);
    }
    const { tokenProgram } = await mint(held.inputMint);
    const account = (wallet: Address) => tokenAccountIfMissing(transport, payer, wallet, held.inputMint, tokenProgram);
    const amountIn = held.escrowed - held.filled;
    const kindBps = feeBpsFor(settings, held.kind);
    const maxFeeBps = kindBps + held.partnerBps;
    const shares = splitFees(amountIn - params.judgeFee, kindBps, held.partnerBps, held.partnerCutBps);
    const feeRecipient = shares.protocol > 0n ? settings.feeRecipient : undefined;
    const partner = shares.partner > 0n ? held.partner : undefined;
    const paidJudge = params.judgeFee > 0n ? judge.address : undefined;
    const payee = await account(payTo);
    const others = await Promise.all([feeRecipient, partner, paidJudge].filter((wallet) => wallet !== undefined).map(account));
    const fields = { amountIn, result, maxFeeBps };
    const message = await attestedProofMessage(judge.address, {
      ...fields,
      domain: Uint8Array.from(settings.domain),
      intent: address,
      payee: payee.address,
      filled: held.filled,
      revision: held.revision,
      specHash: params.specHash,
    });
    const settle = await buildFillAttested({
      ...fields,
      solver: judge,
      owner,
      nonce,
      inputMint: held.inputMint,
      inputTokenProgram: tokenProgram,
      payee: payee.address,
      ...(feeRecipient === undefined ? {} : { feeRecipient }),
      ...(partner === undefined ? {} : { partner }),
      ...(paidJudge === undefined ? {} : { judge: paidJudge }),
    });
    const setup = [payee, ...others].flatMap(({ create }) => create);
    return send([...setup, await signEd25519Instruction(judge, message), settle], payer);
  };

  return {
    url,
    transport,
    config,
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
    nextNonce: async (owner) => nonceAfter(owner, await loadUser(transport, owner)),
    simulate: async (instructions, signer) =>
      simulated(transport, await budgeted(transport, priority, instructions, signer.address), signer.address),
    send,
    watch,
    explain,
    mint,
    chainTime: () => chainTime(transport),
    createIntent,
    cancel,
    settleProof,
  };
}
