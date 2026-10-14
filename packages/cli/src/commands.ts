import {
  type Address,
  createNoopSigner,
  getAddressDecoder,
  getBase58Decoder,
  getBase64Decoder,
  getBase64Encoder,
  type Instruction,
  isSignerRole,
  isWritableRole,
  type KeyPairSigner,
  type TransactionSigner,
} from "@solana/kit";
import {
  buildAcceptAdmin,
  buildAdvanceEpoch,
  buildProposeAdmin,
  buildUpdateConfig,
  buildAdvanceNonce,
  buildCancelIntent,
  buildCloseIntent,
  buildInitConfig,
  buildLowerPause,
  buildRaisePause,
  buildUpdateEconomics,
  decodeEvent,
  findConfigPda,
  findIntentPda,
  findUserStatePda,
  feeBpsFor,
  findVaultPda,
  formatAmount,
  getIntentDecoder,
  type Intent,
  IntentStatus,
  getUserStateDecoder,
  kindBit,
  nextEpoch,
  PAUSE_CREATE,
  PAUSE_FILL,
  U64_MAX,
} from "@intent-engine/core";
import {
  type Chain,
  type SolverOptions,
  decodeLookupTable,
  type Fetch,
  issuePricer,
  backoff,
  jitoBundles,
  jupiterPricer,
  remembering,
  solverTableAccounts,
  tick,
  tipAccount,
} from "@intent-engine/solver";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  announcements,
  chainTime,
  clusterDomain,
  createClient,
  createdAccount,
  deliveryInstructions,
  deliveryRecord,
  type IntentChanges,
  jobsOf,
  type Latest,
  loadConfig,
  loadIntent,
  memoized,
  mintOf,
  PLAIN_HTTP_ON_PUBLIC,
  plainHttpOnPublic,
  type ProgramAccount,
  RECONNECT_MS,
  tokenAccountIfMissing,
  tokenAmountOf,
  tokenProgramOf,
  type Transport,
} from "@intent-engine/client";
import { agentServer } from "./agent/mcp.js";
import { claimsOf } from "./agent/claims.js";
import { budgetOf } from "./agent/budget.js";
import { ESTIMATE_SCAN, walletGuard } from "./agent/wallet.js";
import { relayOf } from "./agent/relay.js";
import { type Authority, type Command, type Env, usageOf } from "./args.js";
import { VERSION } from "./version.js";
import { balances, defaultMints, setup } from "./wallet.js";
import { redactUrl } from "./render.js";
import { prepare } from "./agent/prepare.js";
import { KIND_NAMES, KINDS, preparedView } from "./agent/shapes.js";
import type { AgentContext } from "./agent/actions.js";
import { prepareCreate } from "./agent/create.js";
import { getMandate, prepareAgentCreate, prepareMandate, prepareRevokeMandate } from "./agent/mandate.js";
import { listIntents } from "./agent/read.js";
import { prepareSignedIntent, previewSignedIntent, submitSignedIntent } from "./agent/signed.js";
import { approval, ask, finish, FlowRefused, hasTokens, inRaw, NOT_SENT, perform, signMessage } from "./flows.js";
import { loadMandate } from "./agent/mandate.js";
import { RELAY_MAX_TTL } from "./args.js";
import { describeIntent, quoteOf, sameBytes } from "./accounts.js";
import { closing, crank, expiring } from "./crank.js";
import { priceOf, withPriority } from "./compute.js";
import { createTreasuryAccounts, intentInputMints, treasuryView } from "./treasury.js";
import { artifactSha256, judge } from "./judge.js";

export type Runtime = {
  transport(url: string): Transport;
  intentChanges(url: string): IntentChanges;
  loadSigner(path: string): Promise<KeyPairSigner>;
  readText(path: string): Promise<string>;
  sleep(seconds: number): Promise<boolean>;
  env: Env;
  writeText(path: string, text: string): Promise<void>;
  saveText(path: string, text: string, secret: boolean): Promise<void>;
  home: string;
  now(): bigint;
  fetch: Fetch;
  entropy(): number;
  serve(server: McpServer): Promise<void>;
};

const SOLVER_ROUTE_ACCOUNTS = 40;

export const configExists = (config: Address): string =>
  `the engine is already set up on this cluster (config ${config}); change it with update-config, set-economics, raise-pause or lower-pause`;

export const ENV_JUPITER_KEY = "JUPITER_API_KEY";

export const JUPITER_DOMAIN = "jup.ag";

export function jupiterHost(url: string): boolean {
  const host = new URL(url).hostname;
  return host === JUPITER_DOMAIN || host.endsWith(`.${JUPITER_DOMAIN}`);
}

export * from "./accounts.js";
export * from "./crank.js";

const SIGNED_FILE_VERSION = 1;

export const SOLVER_TABLE_NEXT =
  "put these in an address lookup table you own (solana address-lookup-table create, then extend with them) and pass it to solve with --lookup-table";

function relayAnything(signer: TransactionSigner, mint: Address) {
  return relayOf(signer, {
    maxLamports: U64_MAX,
    maxTtl: BigInt(RELAY_MAX_TTL),
    perHour: Number.MAX_SAFE_INTEGER,
    hourlyLamports: U64_MAX,
    fees: new Map([[mint, 0n]]),
  });
}

async function rawFlowInput(
  transport: Transport,
  flow: string,
  input: Record<string, unknown>,
  signer: Address,
): Promise<Record<string, unknown>> {
  if (flow === "approve" || flow === "revoke-approval") {
    const mint = input["mint"] as Address;
    return inRaw(transport, input, mint, mint);
  }
  if (flow === "mandate-use") {
    if (!hasTokens(input)) {
      return input;
    }
    const owner = input["owner"] as Address;
    const id = input["id"] === undefined ? 0n : BigInt(input["id"] as string);
    const { mandate } = await loadMandate(transport, owner, signer, id);
    return inRaw(transport, input, mandate.inputMint, mandate.outputMint);
  }
  if (flow === "mandate-revoke") {
    return input;
  }
  return inRaw(transport, input, input["input_mint"] as Address, input["output_mint"] as Address);
}

function context(transport: Transport, relay: AgentContext["relay"] = undefined): AgentContext {
  return { transport, relay, agent: undefined, claims: claimsOf() };
}

export const AUTHORITY_NEXT =
  "import transaction_base58 into the multisig as a proposal (its blockhash and fee payer are replaced there), or build one from instructions; it carries no compute budget so it can run from a vault";

function instructionView(ix: Instruction) {
  return {
    program: ix.programAddress,
    accounts: (ix.accounts ?? []).map((meta) => ({
      address: meta.address,
      signer: isSignerRole(meta.role),
      writable: isWritableRole(meta.role),
    })),
    data: getBase64Decoder().decode(ix.data ?? new Uint8Array()),
  };
}

const kindList = (mask: bigint) =>
  KINDS.filter((kind) => (mask & kindBit(kind)) !== 0n)
    .map((kind) => KIND_NAMES[kind])
    .join(", ") || "none";

const pauseList = (flags: number) =>
  [...((flags & PAUSE_CREATE) !== 0 ? ["creating"] : []), ...((flags & PAUSE_FILL) !== 0 ? ["filling"] : [])].join(" and ") ||
  "nothing";

async function administer(
  transport: Transport,
  url: string,
  runtime: Runtime,
  by: Authority,
  build: (signer: TransactionSigner) => Promise<Instruction[]>,
  summary: (signer: Address) => string[],
  extra: object = {},
): Promise<object> {
  const cluster = { url: redactUrl(url), genesisHash: await transport.genesisHash() };
  if ("keypair" in by) {
    const signer = await runtime.loadSigner(by.keypair);
    const instructions = await build(signer);
    const described = { ...extra, cluster, summary: summary(signer.address) };
    if (!by.yes) {
      const simulated = await prepare(transport, instructions, signer.address);
      return { ...described, sent: false, units_consumed: simulated.unitsConsumed, next: NOT_SENT };
    }
    return { ...described, sent: true, signature: await transport.send(instructions, signer) };
  }
  const instructions = await build(createNoopSigner(by.authority));
  const unbudgeted: Transport = { ...transport, budget: async (ixs) => [...ixs] };
  const view = preparedView(await prepare(unbudgeted, instructions, by.authority));
  return {
    ...extra,
    cluster,
    summary: summary(by.authority),
    unsigned: {
      ...view,
      transaction_base58: getBase58Decoder().decode(getBase64Encoder().encode(view.transaction)),
      instructions: instructions.map(instructionView),
      next: AUTHORITY_NEXT,
    },
  };
}

async function previewed(
  transport: Transport,
  instructions: Instruction[],
  signer: KeyPairSigner,
  shown: object,
  yes: boolean,
): Promise<object> {
  if (!yes) {
    const simulated = await prepare(transport, instructions, signer.address);
    return { ...shown, sent: false, units_consumed: simulated.unitsConsumed, next: NOT_SENT };
  }
  return { ...shown, sent: true, signature: await transport.send(instructions, signer) };
}

export const NOT_RELEASED = "no release of this escrow is among its recent transactions; show intent says whether it is still open";

const TOKEN_ACCOUNT_HEAD = 64;

async function receiptOf(transport: Transport, url: string, intent: Address, wanted: string | undefined): Promise<object> {
  const events = await createClient({ url, transport }).history(intent);
  const created = events.find((event) => event.name === "IntentCreated");
  let mint = created?.name === "IntentCreated" ? created.fields.inputMint : undefined;
  const release = events.find((event) => event.name === "IntentAttested" || event.name === "IntentSplit");
  if (release === undefined || (release.name !== "IntentAttested" && release.name !== "IntentSplit")) {
    return { intent, released: false, next: NOT_RELEASED };
  }
  const recorded = release.deliveredSha256;
  const common = {
    intent,
    released: true,
    attestor: release.fields.attestor,
    result: release.fields.result,
    signature: release.signature,
    ...(recorded === undefined ? {} : { delivered_sha256: recorded }),
    ...(wanted === undefined ? {} : { matches: wanted === recorded }),
  };
  const paid = async (net: bigint) => formatAmount(net, mint === undefined ? undefined : (await mintOf(transport, mint)).decimals);
  if (release.name === "IntentSplit") {
    return { ...common, paid: await paid(release.fields.net), recipients: BigInt(release.fields.recipients) };
  }
  const payee = release.fields.payee;
  const held = await transport.getAccount(payee);
  const head = held === null || held.data.length < TOKEN_ACCOUNT_HEAD ? null : held.data;
  mint ??= head === null ? undefined : getAddressDecoder().decode(head.subarray(0, 32));
  return {
    ...common,
    ...(head === null ? {} : { paid_to: getAddressDecoder().decode(head.subarray(32, TOKEN_ACCOUNT_HEAD)) }),
    payee,
    paid: await paid(release.fields.net),
  };
}

type EngineEvents = { signature: string; slot: bigint; blockTime: bigint | null; failed: boolean; events: object[] };

async function engineEvents(transport: Transport, limit: number): Promise<EngineEvents[]> {
  return (await transport.engineTransactions(limit)).map((tx) => ({
    signature: tx.signature,
    slot: tx.slot,
    blockTime: tx.blockTime,
    failed: tx.failed,
    events: tx.failed ? [] : tx.emitted.map(decodeEvent).filter((e) => e !== null),
  }));
}

export const followGap = (limit: number) =>
  `more than ${limit} engine transactions landed since the last poll, so some were not shown; raise --limit or lower --interval`;

export async function follow(
  transport: Transport,
  runtime: Runtime,
  limit: number,
  interval: number,
  emit: (value: object) => void,
): Promise<number> {
  let seen = new Set<string>();
  let shown = 0;
  let failures = 0;
  for (;;) {
    let fetched: EngineEvents[];
    try {
      fetched = await engineEvents(transport, limit);
    } catch (error) {
      const retry = (RECONNECT_MS[Math.min(failures, RECONNECT_MS.length - 1)] ?? 0) / 1000;
      failures++;
      emit({ error: error instanceof Error ? error.message : String(error), retry_in: retry });
      if (!(await runtime.sleep(retry))) {
        return shown;
      }
      continue;
    }
    failures = 0;
    const fresh = fetched.filter((tx) => !seen.has(tx.signature)).reverse();
    if (seen.size > 0 && fetched.length >= limit && fresh.length === fetched.length) {
      emit({ gap: true, warning: followGap(limit) });
    }
    for (const tx of fresh) {
      emit(tx);
      shown++;
    }
    seen = new Set(fetched.map((tx) => tx.signature));
    if (!(await runtime.sleep(interval))) {
      return shown;
    }
  }
}

type SolveCommand = Extract<Command, { name: "solve" }>;

export const IN_FLIGHT_SECONDS = 90n;

export const REFRESH_AFTER_SECONDS = 60n;

export function decodedChanges(changed: readonly ProgramAccount[]): { intents: { address: Address; intent: Intent }[]; unreadable: Address[] } {
  const intents: { address: Address; intent: Intent }[] = [];
  const unreadable: Address[] = [];
  for (const { address, data } of changed) {
    try {
      intents.push({ address, intent: getIntentDecoder().decode(data) });
    } catch {
      unreadable.push(address);
    }
  }
  return { intents, unreadable };
}

export async function stillOpen(transport: Transport, intents: readonly Address[]): Promise<Address[]> {
  const views = await transport.getAccounts(intents);
  return intents.filter((_, i) => {
    const view = views[i];
    return view !== null && view !== undefined && getIntentDecoder().decode(view.data).status === IntentStatus.Open;
  });
}

export async function watchSolve(command: SolveCommand, interval: number, runtime: Runtime, emit: (value: object) => void): Promise<number> {
  const transport = withPriority(runtime.transport(command.url), command.priority);
  const options = await solverOptions(command, runtime, transport);
  const chain = remembering(options.chain);
  const held = backoff(interval, () => Number(runtime.now()) * 1_000);
  const live: SolverOptions = {
    ...options,
    chain,
    backoff: held,
    send:
      command.jito === undefined ? async (wire) => ({ signature: await transport.submitWire(wire), confirmed: false }) : options.send,
  };
  const changes = runtime.intentChanges(command.url);
  const inFlight = new Map<Address, bigint>();
  const failing = new Map<Address, bigint>();
  let scannedAt: bigint | null = null;
  let acted = 0;
  try {
    for (let changed: ProgramAccount[] | null = []; changed !== null; changed = await changes.wait(interval)) {
      const now = runtime.now();
      const began = performance.now();
      let full = false;
      try {
        full = changed.length === 0 || scannedAt === null || now - scannedAt >= BigInt(interval);
        const decoded = full ? { intents: await chain.intents(), unreadable: [] } : decodedChanges(changed);
        if (full) {
          scannedAt = now;
          held.retain(decoded.intents, await chain.now());
        }
        if (decoded.unreadable.length > 0) {
          emit({ at: now, scan: "changed", unreadable: decoded.unreadable });
        }
        const listed = decoded.intents;
        for (const [intent, until] of inFlight) {
          if (until <= now) {
            inFlight.delete(intent);
          }
        }
        const due = listed.filter(({ address }) => !inFlight.has(address));
        const { filled, sent, failed } = await tick({ ...live, chain: { ...chain, intents: async () => due } });
        for (const { intent } of sent) {
          inFlight.set(intent, now + IN_FLIGHT_SECONDS);
        }
        if (filled.length + sent.length + failed.length > 0) {
          emit({ at: now, scan: full ? "full" : "changed", ms: Math.round(performance.now() - began), filled, sent, failed });
          acted += filled.length + sent.length;
        }
        for (const [intent, at] of failing) {
          if (now - at >= REFRESH_AFTER_SECONDS * 10n) {
            failing.delete(intent);
          }
        }
        const open = await stillOpen(transport, failed.map((f) => f.intent));
        const refresh = open.filter((intent) => {
          const at = failing.get(intent);
          return at === undefined || now - at >= REFRESH_AFTER_SECONDS;
        });
        if (refresh.length > 0) {
          refresh.forEach((intent) => failing.set(intent, now));
          chain.forget();
        }
      } catch (error) {
        chain.forget();
        emit({ at: now, scan: full ? "full" : "changed", error: error instanceof Error ? error.message : String(error) });
      }
    }
  } finally {
    changes.close();
  }
  return acted;
}

async function solverOptions(command: SolveCommand, runtime: Runtime, transport: Transport): Promise<SolverOptions> {
  const solver = await runtime.loadSigner(command.keypair);
  let latest: Latest | undefined;
  const chain: Chain = {
    config: async () => (await loadConfig(transport)).config,
    intents: async () =>
      (await transport.intents()).map(({ address, data }) => ({ address, intent: getIntentDecoder().decode(data) })),
    now: () => chainTime(transport),
    tokenProgram: (mint) => tokenProgramOf(transport, mint),
    mintData: async (mint) => (await transport.getAccount(mint))?.data ?? null,
    exists: async (address) => (await createdAccount(transport, address)) !== null,
    tokenAmount: async (address) => tokenAmountOf((await transport.getAccount(address))?.data ?? null) ?? 0n,
    lookupTables: async (addresses) => {
      const tables: Record<Address, Address[]> = {};
      for (const address of addresses) {
        const view = await transport.getAccount(address);
        if (view === null) {
          throw new Error(`lookup table ${address} does not exist`);
        }
        tables[address] = decodeLookupTable(view.data);
      }
      return tables;
    },
    blockhash: async () => {
      latest = await transport.latestBlockhash();
      return latest;
    },
  };
  const bundle = command.jito === undefined ? undefined : jitoBundles({ url: command.jito, fetch: runtime.fetch });
  return {
    chain,
    pricer:
      command.jupiter === undefined
        ? issuePricer(
            await Promise.all(
              command.issue.map(async (route) => ({ ...route, outputTokenProgram: await tokenProgramOf(transport, route.outputMint) })),
            ),
          )
        : jupiterPricer({
            baseUrl: command.jupiter,
            fetch: runtime.fetch,
            slippageBps: command.slippageBps,
            maxAccounts: SOLVER_ROUTE_ACCOUNTS,
            ...(runtime.env[ENV_JUPITER_KEY] === undefined || !jupiterHost(command.jupiter)
              ? {}
              : { apiKey: runtime.env[ENV_JUPITER_KEY] }),
            ...(command.routeProgram === undefined ? {} : { swapPrograms: new Set([command.routeProgram]) }),
          }),
    solver,
    strategy: { minProfit: command.minProfit, maxFeeBps: command.maxFeeBps },
    maxSolCost: command.maxSolCost,
    maxRent: command.maxRent,
    tip: command.tipLamports === 0n ? null : { account: tipAccount(runtime.entropy()), lamports: command.tipLamports },
    lookupTables: command.lookupTables,
    unitPrice: (instructions) => priceOf(transport, command.priority, instructions),
    simulate: async (wire, watch) => {
      const simulated = await transport.simulate(wire, watch);
      return { err: simulated.err, unitsConsumed: simulated.unitsConsumed, balances: simulated.accounts.map(tokenAmountOf) };
    },
    send: async (wire) => {
      if (bundle !== undefined) {
        return { signature: await bundle([wire]), confirmed: false };
      }
      if (latest === undefined) {
        throw new Error("no blockhash was fetched for this transaction");
      }
      return { signature: await transport.sendWire(wire, latest), confirmed: true };
    },
  };
}

export async function run(command: Command, runtime: Runtime): Promise<object | null> {
  if (command.name === "help") {
    return usageOf(command.verb);
  }
  if (command.name === "version") {
    return { version: VERSION };
  }
  if (command.name === "hash") {
    return { artifact: command.artifact, sha256: await artifactSha256(command.artifact) };
  }
  if (command.name === "pda") {
    const [intent] = await findIntentPda({ owner: command.owner, nonce: command.nonce });
    const [vault] = await findVaultPda({ intent });
    return { intent, vault };
  }
  const transport = withPriority(runtime.transport(command.url), command.priority);
  switch (command.name) {
    case "mcp": {
      const relay =
        command.relay === undefined ? undefined : relayOf(await runtime.loadSigner(command.relay.keypair), command.relay);
      const agent =
        command.agent === undefined
          ? undefined
          : {
              signer: await runtime.loadSigner(command.agent.keypair),
              budget: budgetOf(command.agent.hourlyLamports),
              owners: new Set(command.agent.owners),
            };
      const wallet =
        command.wallet === null
          ? {}
          : { wallet: { url: command.url, files: runtime, env: runtime.env, sleep: runtime.sleep, now: runtime.now, limits: walletGuard(command.wallet) } };
      if (command.wallet !== null) {
        transport.engineTransactions(ESTIMATE_SCAN).catch(() => undefined);
      }
      await runtime.serve(agentServer({ transport, relay, agent, claims: claimsOf(), ...wallet }));
      return null;
    }
    case "setup":
      return setup(transport, runtime, command.url, command.keypair);
    case "balance": {
      const owner = command.owner ?? (await runtime.loadSigner(command.keypair ?? "")).address;
      return balances(transport, owner, command.mints ?? defaultMints(command.url));
    }
    case "domain":
      return { genesisHash: await transport.genesisHash(), domain: await clusterDomain(transport) };
    case "show-config": {
      const { address, config } = await loadConfig(transport);
      return { address, ...config, domainMatchesCluster: sameBytes(config.domain, await clusterDomain(transport)) };
    }
    case "show-intent": {
      const { address, intent } = await loadIntent(transport, command.owner, command.nonce);
      return describeIntent(address, intent);
    }
    case "quote": {
      const { address, intent } = await loadIntent(transport, command.owner, command.nonce);
      const { config } = await loadConfig(transport);
      return { address, ...quoteOf(intent, config, command.at ?? runtime.now()) };
    }
    case "cancel": {
      const owner = await runtime.loadSigner(command.keypair);
      const { address, intent } = await loadIntent(transport, owner.address, command.nonce);
      const ref = { nonce: command.nonce, inputMint: intent.inputMint, tokenProgram: await tokenProgramOf(transport, intent.inputMint) };
      const refund = await tokenAccountIfMissing(transport, owner, owner.address, intent.inputMint, ref.tokenProgram);
      const instructions = [
        ...refund.create,
        await buildCancelIntent({ ...ref, owner }),
        ...(command.close ? [await buildCloseIntent({ ...ref, owner: owner.address, cranker: owner, rentPayer: intent.rentPayer })] : []),
      ];
      const summary = [
        `Cancels intent ${address} (nonce ${command.nonce}); nobody can fill it afterwards`,
        `Returns what is left in escrow to ${refund.address}, the owner's token account for ${intent.inputMint}`,
        ...(refund.create.length > 0 ? [`Creates ${refund.address} first, since it is missing; the owner pays its rent`] : []),
        ...(command.close ? [`Closes the intent in the same transaction and returns its rent and bounty to ${intent.rentPayer}, who paid them; it can no longer be read afterwards`] : []),
      ];
      return previewed(transport, instructions, owner, { intent: address, summary }, command.yes);
    }
    case "expire": {
      const cranker = await runtime.loadSigner(command.keypair);
      const { address, intent } = await loadIntent(transport, command.owner, command.nonce);
      const instructions = await expiring(transport, cranker, address, intent, "always", false);
      const summary = [
        `Expires intent ${address} (nonce ${command.nonce}) and returns what is left in escrow to its owner ${command.owner}`,
        ...(instructions.length > 1 ? [`Creates a token account for the owner to take the refund; ${cranker.address} pays its rent`] : []),
      ];
      return previewed(transport, instructions, cranker, { intent: address, summary }, command.yes);
    }
    case "close": {
      const payer = await runtime.loadSigner(command.keypair);
      const { address, intent } = await loadIntent(transport, command.owner, command.nonce);
      const instructions = await closing(transport, payer, address, intent, "always");
      const summary = [
        `Closes intent ${address} (nonce ${command.nonce}) and returns its rent; it can no longer be read afterwards`,
        ...(instructions.length > 1 ? [`Creates a token account for the owner to take what is left in escrow; ${payer.address} pays its rent`] : []),
      ];
      return previewed(transport, instructions, payer, { intent: address, summary }, command.yes);
    }
    case "follow":
      throw new FlowRefused("events --follow streams to the terminal and runs only from the command line");
    case "events": {
      const transactions = await engineEvents(transport, command.limit);
      const notable = transactions.reduce(
        (n, tx) => n + tx.events.filter((e) => (e as { notable?: boolean }).notable === true).length,
        0,
      );
      return { notable, transactions };
    }
    case "jobs":
      return { jobs: await jobsOf(transport, command.attestor) };
    case "deliver": {
      const worker = await runtime.loadSigner(command.keypair);
      const { intent, sha256, workUrl } = command;
      const { attestor, instructions } = await deliveryInstructions(transport, { worker, intent, sha256, url: workUrl });
      const shown = {
        intent,
        attestor,
        summary: [
          `Announces: the work with sha256 ${sha256} at ${workUrl}, for the proof escrow ${intent}`,
          `Notifies: its judge ${attestor}, with a transfer of 0 lamports from ${worker.address}, which signs and pays the fee`,
        ],
      };
      return previewed(transport, instructions, worker, shown, command.yes);
    }
    case "receipt": {
      const [intent] = await findIntentPda({ owner: command.owner, nonce: command.nonce });
      return receiptOf(transport, command.url, intent, command.sha256);
    }
    case "deliveries": {
      const record = await deliveryRecord(transport, command.attestor, command.intent, command.maxPages);
      return {
        intent: command.intent,
        complete: record.complete,
        deliveries: announcements(record.deliveries).map(({ sha256, first, copies }) => ({
          sha256,
          worker: first.worker,
          url: first.url,
          signature: first.signature,
          slot: first.slot,
          copies,
        })),
      };
    }
    case "judge": {
      return judge(command, runtime, transport);
    }
    case "treasury": {
      const view = await treasuryView(transport, command.mints ?? (await intentInputMints(transport)));
      if (!command.create || command.keypair === undefined) {
        return view;
      }
      return createTreasuryAccounts(transport, view, await runtime.loadSigner(command.keypair), command.yes);
    }
    case "solver-table": {
      const { config } = await loadConfig(transport);
      const mints = [];
      for (const mint of command.mints) {
        mints.push({ mint, tokenProgram: await tokenProgramOf(transport, mint) });
      }
      const addresses = await solverTableAccounts(command.solver, config.feeRecipient, mints);
      return { solver: command.solver, count: addresses.length, addresses, next: SOLVER_TABLE_NEXT };
    }
    case "crank": {
      const cranker = await runtime.loadSigner(command.keypair);
      return crank(transport, cranker, command.dryRun, command.fundAccounts);
    }
    case "init-config": {
      const [config] = await findConfigPda();
      if ((await transport.getAccount(config)) !== null) {
        throw new Error(configExists(config));
      }
      const domain = await clusterDomain(transport);
      return administer(
        transport,
        command.url,
        runtime,
        command.by,
        async (authority) => [
          await buildInitConfig({
            authority,
            domain,
            guardian: command.guardian,
            feeRecipient: command.feeRecipient,
            enabledKinds: command.enabledKinds,
            feeBps: command.feeBps,
            paused: command.paused,
          }),
        ],
        () => [
          `Creates the engine config ${config} for this cluster (domain ${getBase58Decoder().decode(domain)}) with the signer as admin`,
          `Guardian: ${command.guardian}`,
          `Fee recipient: ${command.feeRecipient}`,
          `Fee: ${command.feeBps} bps`,
          `Enabled kinds: ${kindList(command.enabledKinds)}`,
          `Paused: ${pauseList(command.paused)}`,
        ],
        { config, domain },
      );
    }
    case "raise-pause":
      return administer(
        transport,
        command.url,
        runtime,
        command.by,
        async (authority) => [await buildRaisePause({ authority, flags: command.flags })],
        () => [`Pauses ${pauseList(command.flags)} for every intent until the admin lowers the pause`],
      );
    case "lower-pause":
      return administer(
        transport,
        command.url,
        runtime,
        command.by,
        async (admin) => [await buildLowerPause({ admin, flags: command.flags })],
        () => [`Resumes ${pauseList(command.flags)}`],
      );
    case "update-config": {
      const { config } = await loadConfig(transport);
      const c = command.change;
      const update = {
        guardian: c.guardian ?? config.guardian,
        feeRecipient: c.feeRecipient ?? config.feeRecipient,
        feeBps: c.feeBps ?? config.feeBps,
        enabledKinds: c.enabledKinds ?? config.enabledKinds,
        fillDisabledKinds: c.fillDisabledKinds ?? config.fillDisabledKinds,
      };
      const changes = [
        ...(update.guardian === config.guardian ? [] : [`Guardian: ${config.guardian} -> ${update.guardian}`]),
        ...(update.feeRecipient === config.feeRecipient ? [] : [`Fee recipient: ${config.feeRecipient} -> ${update.feeRecipient}`]),
        ...(update.feeBps === config.feeBps ? [] : [`Fee: ${config.feeBps} -> ${update.feeBps} bps`]),
        ...(update.enabledKinds === config.enabledKinds
          ? []
          : [`Enabled kinds: ${kindList(config.enabledKinds)} -> ${kindList(update.enabledKinds)}`]),
        ...(update.fillDisabledKinds === config.fillDisabledKinds
          ? []
          : [`Fills stopped for: ${kindList(config.fillDisabledKinds)} -> ${kindList(update.fillDisabledKinds)}`]),
      ];
      return administer(
        transport,
        command.url,
        runtime,
        command.by,
        async (admin) => [await buildUpdateConfig({ admin, update })],
        () => (changes.length === 0 ? ["Changes nothing: every setting already has the value given"] : changes),
        { update },
      );
    }
    case "propose-admin": {
      const { config } = await loadConfig(transport);
      return administer(
        transport,
        command.url,
        runtime,
        command.by,
        async (admin) => [await buildProposeAdmin({ admin, pendingAdmin: command.pendingAdmin })],
        () => [
          `Proposes ${command.pendingAdmin} as the next admin in place of ${config.admin}`,
          "Nothing changes until that key accepts; a later proposal replaces this one",
        ],
      );
    }
    case "accept-admin": {
      const { config } = await loadConfig(transport);
      return administer(
        transport,
        command.url,
        runtime,
        command.by,
        async (pendingAdmin) => [await buildAcceptAdmin({ pendingAdmin })],
        (signer) => [`Makes ${signer} the admin in place of ${config.admin}`],
      );
    }
    case "advance-nonce": {
      const owner = await runtime.loadSigner(command.keypair);
      const ix = await buildAdvanceNonce({ owner, nonceBase: command.base });
      return { signature: await transport.send([ix], owner) };
    }
    case "solve":
      return tick(await solverOptions(command, runtime, transport));
    case "set-economics": {
      const { config } = await loadConfig(transport);
      const e = command.economics;
      const kindFees = KINDS.filter((kind) => (BigInt(e.kindFeeMask) & kindBit(kind)) !== 0n)
        .map((kind) => `${KIND_NAMES[kind]} ${feeBpsFor({ feeBps: config.feeBps, ...e }, kind)} bps`)
        .join(", ");
      return administer(
        transport,
        command.url,
        runtime,
        command.by,
        async (admin) => [await buildUpdateEconomics({ admin, economics: e })],
        () => [
          `Crank bounty: ${config.crankBounty} -> ${e.crankBounty} lamports per intent`,
          `Create fee: ${config.createFee} -> ${e.createFee} lamports per intent`,
          `Partner cut: ${config.partnerCutBps} -> ${e.partnerCutBps} bps of each partner fee`,
          `Kind fees: ${kindFees === "" ? "none; every kind pays the base fee" : kindFees}`,
        ],
      );
    }
    case "flow": {
      const signer = await runtime.loadSigner(command.keypair);
      const reading = memoized(transport);
      const ctx = context(reading);
      const raw = await rawFlowInput(reading, command.flow, command.input, signer.address);
      switch (command.flow) {
        case "create": {
          const specUrl = raw["spec_url"];
          if (typeof specUrl === "string" && (await plainHttpOnPublic(reading, specUrl))) {
            throw new FlowRefused(`--spec-url ${specUrl} ${PLAIN_HTTP_ON_PUBLIC}`);
          }
          return perform(prepareCreate, ctx, { owner: signer.address, ...raw }, signer, command.yes);
        }
        case "mandate-grant":
          return perform(prepareMandate, ctx, { owner: signer.address, ...raw }, signer, command.yes);
        case "mandate-revoke":
          return perform(prepareRevokeMandate, ctx, { owner: signer.address, ...raw }, signer, command.yes);
        case "mandate-use":
          return perform(prepareAgentCreate, ctx, { agent: signer.address, ...raw }, signer, command.yes);
        case "approve":
        case "revoke-approval": {
          const input = raw as { mint: Address; amount?: string };
          return approval(
            transport,
            signer,
            input.mint,
            input.amount === undefined ? undefined : BigInt(input.amount),
            command.yes,
          );
        }
      }
      throw new FlowRefused(`unknown flow ${String(command.flow)}`);
    }
    case "lookup": {
      const owner =
        (command.input["owner"] as Address | undefined) ??
        (command.keypair === undefined ? undefined : (await runtime.loadSigner(command.keypair)).address);
      if (owner === undefined) {
        throw new FlowRefused("name the owner with --owner or --keypair");
      }
      const action = command.lookup === "list" ? listIntents : getMandate;
      return ask(action, context(transport), { ...command.input, owner });
    }
    case "signed-prepare": {
      const owner = await runtime.loadSigner(command.keypair);
      const input = await inRaw(
        transport,
        command.input,
        command.input["input_mint"] as Address,
        command.input["output_mint"] as Address,
      );
      if (command.yes && (await runtime.readText(command.out).then(() => true, () => false))) {
        throw new FlowRefused(`${command.out} already exists; choose another --out`);
      }
      const value = await ask(prepareSignedIntent, context(transport), { owner: owner.address, ...input });
      if (!command.yes) {
        return finish(transport, value, owner, false);
      }
      const signature = await signMessage(owner, value["message"] as string);
      const shown = await finish(transport, value, owner, true);
      await runtime.writeText(
        command.out,
        `${JSON.stringify({ version: SIGNED_FILE_VERSION, submit: value["submit"], signature }, null, 2)}\n`,
      );
      return { ...shown, saved: command.out };
    }
    case "signed-submit": {
      const relayer = await runtime.loadSigner(command.keypair);
      let saved: { version?: unknown; submit?: Record<string, unknown>; signature?: unknown };
      try {
        saved = JSON.parse(await runtime.readText(command.file)) as typeof saved;
      } catch {
        throw new FlowRefused(`${command.file} is not a signed intent file`);
      }
      if (saved.version !== SIGNED_FILE_VERSION || saved.submit === undefined || typeof saved.signature !== "string") {
        throw new FlowRefused(`${command.file} is not a signed intent file`);
      }
      const signed = { ...saved.submit, signature: saved.signature };
      if (!command.yes) {
        return { ...(await ask(previewSignedIntent, context(transport), signed)), sent: false, next: NOT_SENT };
      }
      return { ...(await ask(submitSignedIntent, context(transport, relayAnything(relayer, String(saved.submit["input_mint"]) as Address)), signed)), sent: true };
    }
    case "advance-epoch": {
      const owner = await runtime.loadSigner(command.keypair);
      const [userState] = await findUserStatePda({ owner: owner.address });
      const view = await createdAccount(transport, userState);
      if (view === null) {
        throw new Error(`${owner.address} has no user state`);
      }
      const epoch = nextEpoch(getUserStateDecoder().decode(view.data).epoch);
      const ix = await buildAdvanceEpoch({ owner, epoch });
      return { epoch, signature: await transport.send([ix], owner) };
    }
  }
}
