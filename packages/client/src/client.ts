import { type Address, createSolanaRpc, type Instruction, type KeyPairSigner, type Signature, type TransactionSigner } from "@solana/kit";
import {
  attestedProofMessage,
  buildCancelIntent,
  buildCloseIntent,
  buildCreateIntent,
  buildExpireIntent,
  buildFillAttested,
  buildFillIntent,
  type Config,
  decodeEvent,
  decodeParams,
  type EngineEvent,
  escrowAmount,
  feeBpsFor,
  findAssociatedTokenAddress,
  findIntentPda,
  getIntentDecoder,
  type Intent,
  type IntentParams,
  IntentStatus,
  Kind,
  isSha256Hex,
  NATIVE_MINT,
  nextFreeNonce,
  remainingOf,
  releaseMemo,
  requiredOut,
  signEd25519Instruction,
  specMemo,
  splitFees,
  TOKEN_PROGRAM_ADDRESS,
  tokenName,
} from "@intent-engine/core";
import { getCloseAccountInstruction } from "@solana-program/token";
import {
  chainTime,
  createdAccount,
  loadConfig,
  loadIntent,
  loadUser,
  MissingAccount,
  mintOf,
  type NonceWindow,
  tokenAmountOf,
} from "./accounts.js";
import { budgeted, type Priority, simulated } from "./budget.js";
import { type EngineError, explain } from "./errors.js";
import {
  type DeliverInput,
  deliveriesOf,
  type Delivery,
  deliveryInstructions,
  type Job,
  jobsOf,
  memoInstruction,
  readSpec,
  type Spec,
  type SpecFetch,
} from "./jobs.js";
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
  fetch?: SpecFetch;
};

export type IntentAccount = { address: Address; intent: Intent };

export type IntentFilter = { owner?: Address; status?: number };

export type WatchCallback = (changed: IntentAccount[], closed: IntentAccount[]) => void;

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
  specUrl?: string;
};

export type CreatedIntent = { signature: Signature; intent: Address; nonce: bigint };

export type SettleProofInput = {
  judge: KeyPairSigner;
  owner: Address;
  nonce: bigint;
  payTo: Address;
  result: bigint;
  payer?: TransactionSigner;
  deliveredSha256?: string;
};

export type HistoryEvent = EngineEvent & { signature: Signature; slot: bigint; blockTime: bigint | null };

export type FillInput = {
  solver: TransactionSigner;
  owner: Address;
  nonce: bigint;
  amountIn?: bigint;
  amountOut?: bigint;
  route?: readonly Instruction[];
};

export type Fill = {
  steps: 1 | 2;
  solver: Address;
  delivered: bigint;
  required: bigint;
  fee: bigint;
  net: bigint;
  signature: Signature;
  slot: bigint;
  blockTime: bigint | null;
};

export type TokenBalance = { mint: Address; name: string | undefined; account: Address; amount: bigint; decimals: number };

export type Balances = { sol: bigint; tokens: TokenBalance[] };

export type Client = {
  readonly url: string;
  readonly transport: Transport;
  config(): Promise<Config>;
  intent(owner: Address, nonce: bigint): Promise<IntentAccount | null>;
  intents(filter?: IntentFilter): Promise<IntentAccount[]>;
  history(intent: Address, limit?: number): Promise<HistoryEvent[]>;
  nextNonce(owner: Address): Promise<bigint>;
  simulate(instructions: readonly Instruction[], signer: TransactionSigner): Promise<Simulation>;
  send(instructions: readonly Instruction[], signer: TransactionSigner): Promise<Signature>;
  watch(onChange: WatchCallback, signal: AbortSignal, filter?: { owner?: Address }): Promise<void>;
  explain(error: unknown): EngineError | null;
  mint(address: Address): Promise<Mint>;
  chainTime(): Promise<bigint>;
  createIntent(input: CreateIntentInput): Promise<CreatedIntent>;
  cancel(signer: TransactionSigner, nonce: bigint): Promise<Signature>;
  unwrap(signer: TransactionSigner): Promise<Signature | null>;
  settleProof(input: SettleProofInput): Promise<Signature>;
  fill(input: FillInput): Promise<Signature>;
  fillOf(intent: Address): Promise<Fill | null>;
  expire(cranker: TransactionSigner, owner: Address, nonce: bigint): Promise<Signature>;
  close(cranker: TransactionSigner, owner: Address, nonce: bigint): Promise<Signature>;
  balances(owner: Address, mints: readonly Address[]): Promise<Balances>;
  jobs(filter?: { attestor?: Address }): Promise<Job[]>;
  spec(intent: Address): Promise<Spec | null>;
  deliver(input: DeliverInput): Promise<Signature>;
  deliveries(filter: { judge: Address; intent?: Address }): Promise<Delivery[]>;
};

export const SPEC_URL_NEEDS_PROOF = "specUrl needs an AttestedResult intent with a non-zero specHash";

export const DEFAULT_EXPIRES_IN = 3_600n;
export const HISTORY_LIMIT = 100;

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

export class NotFillable extends Error {
  readonly intent: Address;

  constructor(intent: Address, reason: string) {
    super(`intent ${intent} ${reason}`);
    this.name = "NotFillable";
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
    const seen = new Map<Address, { key: string; view: IntentAccount }>();
    const fresh = (accounts: readonly ProgramAccount[]) =>
      accounts.flatMap((account) => {
        const view = decoded(account);
        if (filter.owner !== undefined && view.intent.owner !== filter.owner) {
          return [];
        }
        const key = Buffer.from(account.data).toString("base64");
        if (seen.get(account.address)?.key === key) {
          return [];
        }
        seen.set(account.address, { key, view });
        return [view];
      });
    let read = false;
    const report = (changed: IntentAccount[], closed: IntentAccount[], first = false) => {
      if ((changed.length > 0 || closed.length > 0 || first) && !signal.aborted) {
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
      const closed = [...seen].filter(([address]) => !present.has(address)).map(([, { view }]) => view);
      for (const { address } of closed) {
        seen.delete(address);
      }
      report(changed, closed, !read);
      read = true;
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
    if (input.specUrl !== undefined && (params.kind !== Kind.AttestedResult || params.specHash.every((b) => b === 0))) {
      throw new RangeError(SPEC_URL_NEEDS_PROOF);
    }
    const published = input.specUrl === undefined ? [] : [memoInstruction(signer, specMemo(input.specUrl))];
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
    const signature = await send([...register, ...receiver.create, ...wrap.instructions, create, ...published], signer);
    const [intent] = await findIntentPda({ owner, nonce });
    return { signature, intent, nonce };
  };

  const cancel = async (signer: TransactionSigner, nonce: bigint) => {
    const { intent } = await loadIntent(transport, signer.address, nonce);
    const { tokenProgram } = await mint(intent.inputMint);
    const refund = await tokenAccountIfMissing(transport, signer, signer.address, intent.inputMint, tokenProgram);
    return send([...refund.create, await buildCancelIntent({ owner: signer, nonce, inputMint: intent.inputMint, tokenProgram })], signer);
  };

  const unwrap = async (signer: TransactionSigner) => {
    const account = await findAssociatedTokenAddress({ owner: signer.address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    if ((await createdAccount(transport, account)) === null) {
      return null;
    }
    return send([getCloseAccountInstruction({ account, destination: signer.address, owner: signer })], signer);
  };

  const history = async (intent: Address, limit = HISTORY_LIMIT): Promise<HistoryEvent[]> =>
    (await transport.engineTransactions(limit, intent))
      .filter(({ failed }) => !failed)
      .flatMap(({ signature, slot, blockTime, emitted }) =>
        emitted
          .map((data) => decodeEvent(data) as EngineEvent | null)
          .filter((event): event is EngineEvent => event !== null && "intent" in event.fields && event.fields.intent === intent)
          .reverse()
          .map((event) => ({ ...event, signature: signature as Signature, slot, blockTime })),
      );

  const fillOf = async (intent: Address): Promise<Fill | null> => {
    const events = await history(intent);
    for (const event of events) {
      const { signature, slot, blockTime } = event;
      if (event.name === "IntentFilled") {
        const { solver, delivered, required, fee, net } = event.fields;
        return { steps: 1, solver, delivered, required, fee, net, signature, slot, blockTime };
      }
      if (event.name === "FillEnded") {
        const begun = events.find((other) => other.name === "FillBegun" && other.signature === signature);
        if (begun?.name === "FillBegun") {
          const { solver, delivered, required } = event.fields;
          return { steps: 2, solver, delivered, required, fee: begun.fields.fee, net: begun.fields.net, signature, slot, blockTime };
        }
      }
    }
    return null;
  };

  const fill = async (input: FillInput) => {
    const { solver, owner, nonce } = input;
    const [{ address, intent: held }, settings] = await Promise.all([loadIntent(transport, owner, nonce), config()]);
    if (held.status !== IntentStatus.Open) {
      throw new NotFillable(address, "is not open");
    }
    const params = decodeParams(held.kind, Uint8Array.from(held.params));
    if (params.kind === Kind.AttestedResult) {
      throw new NotFillable(address, "is an AttestedResult intent, which only its judge settles");
    }
    const [sell, buy] = await Promise.all([mint(held.inputMint), mint(held.outputMint)]);
    const amountIn = input.amountIn ?? remainingOf(held);
    const amountOut = input.amountOut ?? requiredOut(params, amountIn, await chainTime(transport));
    const kindBps = feeBpsFor(settings, held.kind);
    const shares = splitFees(amountIn, kindBps, held.partnerBps, held.partnerCutBps);
    const feeRecipient = shares.protocol > 0n ? settings.feeRecipient : undefined;
    const partner = shares.partner > 0n ? held.partner : undefined;
    const agent = held.agentFee > 0n ? held.rentPayer : undefined;
    const paid = (wallet: Address) => tokenAccountIfMissing(transport, solver, wallet, held.inputMint, sell.tokenProgram);
    const [solverInput, solverOutput, ...payouts] = await Promise.all([
      paid(solver.address),
      tokenAccountIfMissing(transport, solver, solver.address, held.outputMint, buy.tokenProgram),
      ...[feeRecipient, partner, agent].filter((wallet) => wallet !== undefined).map(paid),
    ]);
    const filled = await buildFillIntent({
      solver,
      owner,
      nonce,
      inputMint: held.inputMint,
      outputMint: held.outputMint,
      inputTokenProgram: sell.tokenProgram,
      outputTokenProgram: buy.tokenProgram,
      receiver: held.receiver,
      solverInput: solverInput.address,
      solverOutput: solverOutput.address,
      ...(feeRecipient === undefined ? {} : { feeRecipient }),
      ...(partner === undefined ? {} : { partner }),
      ...(agent === undefined ? {} : { agent }),
      mandate: held.mandate,
      amountIn,
      amountOut,
      maxFeeBps: kindBps + held.partnerBps,
    });
    const setup = [solverInput, solverOutput, ...payouts].flatMap(({ create }) => create);
    const wrap = input.route === undefined ? (await wrapIfShort(transport, solver, held.outputMint, buy.tokenProgram, amountOut)).instructions : [];
    return send([...setup, ...wrap, ...(input.route ?? []), filled], solver);
  };

  const settling = async (cranker: TransactionSigner, owner: Address, nonce: bigint) => {
    const { intent } = await loadIntent(transport, owner, nonce);
    const { tokenProgram } = await mint(intent.inputMint);
    return { ref: { cranker, owner, nonce, inputMint: intent.inputMint, tokenProgram }, rentPayer: intent.rentPayer };
  };

  const expire = async (cranker: TransactionSigner, owner: Address, nonce: bigint) => {
    const { ref } = await settling(cranker, owner, nonce);
    const refund = await tokenAccountIfMissing(transport, cranker, owner, ref.inputMint, ref.tokenProgram);
    return send([...refund.create, await buildExpireIntent(ref)], cranker);
  };

  const close = async (cranker: TransactionSigner, owner: Address, nonce: bigint) => {
    const { ref, rentPayer } = await settling(cranker, owner, nonce);
    return send([await buildCloseIntent({ ...ref, rentPayer })], cranker);
  };

  const balances = async (owner: Address, mints: readonly Address[]): Promise<Balances> => {
    const [wallet, tokens] = await Promise.all([
      transport.getAccount(owner),
      Promise.all(
        mints.map(async (address): Promise<TokenBalance> => {
          const { decimals, tokenProgram } = await mint(address);
          const account = await findAssociatedTokenAddress({ owner, mint: address, tokenProgram });
          const amount = tokenAmountOf((await createdAccount(transport, account))?.data ?? null) ?? 0n;
          return { mint: address, name: tokenName(address), account, amount, decimals };
        }),
      ),
    ]);
    return { sol: wallet?.lamports ?? 0n, tokens };
  };

  const settleProof = async (input: SettleProofInput) => {
    const { judge, owner, nonce, payTo, result, deliveredSha256 } = input;
    const payer = input.payer ?? judge;
    if (deliveredSha256 !== undefined && !isSha256Hex(deliveredSha256)) {
      throw new RangeError("deliveredSha256 must be 64 lowercase hex digits");
    }
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
    const recorded = deliveredSha256 === undefined ? [] : [memoInstruction(judge, releaseMemo(deliveredSha256))];
    return send([...setup, await signEd25519Instruction(judge, message), settle, ...recorded], payer);
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
    history,
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
    unwrap,
    settleProof,
    fill,
    fillOf,
    expire,
    close,
    balances,
    jobs: (filter = {}) => jobsOf(transport, filter.attestor),
    spec: (intent) => readSpec(transport, options.fetch ?? fetch, intent),
    deliver: async (input) => send((await deliveryInstructions(transport, input)).instructions, input.worker),
    deliveries: ({ judge, intent }) => deliveriesOf(transport, judge, intent),
  };
}
