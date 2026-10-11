import {
  type Address,
  createNoopSigner,
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
  getIntentDecoder,
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
  jitoBundles,
  jupiterPricer,
  solverTableAccounts,
  tick,
  tipAccount,
} from "@intent-engine/solver";
import type { McpServer } from "@modelcontextprotocol/server";
import { agentServer } from "./agent/mcp.js";
import { claimsOf } from "./agent/claims.js";
import { budgetOf } from "./agent/budget.js";
import { relayOf } from "./agent/relay.js";
import { type Authority, type Command, type Env, usageOf } from "./args.js";
import { VERSION } from "./version.js";
import { balances, defaultMints, setup } from "./wallet.js";
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
import type { IntentChanges, Latest, Transport } from "./transport.js";
import {
  chainTime,
  clusterDomain,
  createdAccount,
  describeIntent,
  loadConfig,
  loadIntent,
  quoteOf,
  sameBytes,
  tokenAmountOf,
  tokenProgramOf,
} from "./accounts.js";
import { closing, crank, expiring } from "./crank.js";
import { priceOf, withPriority } from "./compute.js";
import { createTreasuryAccounts, intentInputMints, treasuryView } from "./treasury.js";

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
  runtime: Runtime,
  by: Authority,
  build: (signer: TransactionSigner) => Promise<Instruction[]>,
  summary: (signer: Address) => string[],
  extra: object = {},
): Promise<object> {
  if ("keypair" in by) {
    const signer = await runtime.loadSigner(by.keypair);
    const instructions = await build(signer);
    const described = { ...extra, summary: summary(signer.address) };
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
    summary: summary(by.authority),
    unsigned: {
      ...view,
      transaction_base58: getBase58Decoder().decode(getBase64Encoder().encode(view.transaction)),
      instructions: instructions.map(instructionView),
      next: AUTHORITY_NEXT,
    },
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
  do {
    const fetched = await engineEvents(transport, limit);
    const fresh = fetched.filter((tx) => !seen.has(tx.signature)).reverse();
    if (seen.size > 0 && fetched.length >= limit && fresh.length === fetched.length) {
      emit({ gap: true, warning: followGap(limit) });
    }
    for (const tx of fresh) {
      emit(tx);
      shown++;
    }
    seen = new Set(fetched.map((tx) => tx.signature));
  } while (await runtime.sleep(interval));
  return shown;
}

type SolveCommand = Extract<Command, { name: "solve" }>;

export async function watchSolve(command: SolveCommand, interval: number, runtime: Runtime, emit: (value: object) => void): Promise<number> {
  const transport = withPriority(runtime.transport(command.url), command.priority);
  const options = await solverOptions(command, runtime, transport);
  const changes = runtime.intentChanges(command.url);
  let acted = 0;
  try {
    do {
      try {
        const { filled, sent, failed } = await tick(options);
        if (filled.length + sent.length + failed.length > 0) {
          emit({ filled, sent, failed });
          acted += filled.length + sent.length;
        }
      } catch (error) {
        emit({ error: error instanceof Error ? error.message : String(error) });
      }
    } while (await changes.wait(interval));
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
      const wallet = command.wallet ? { wallet: { url: command.url, files: runtime, env: runtime.env } } : {};
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
      const { intent } = await loadIntent(transport, owner.address, command.nonce);
      const ix = await buildCancelIntent({
        owner,
        nonce: command.nonce,
        inputMint: intent.inputMint,
        tokenProgram: await tokenProgramOf(transport, intent.inputMint),
      });
      return { signature: await transport.send([ix], owner) };
    }
    case "expire": {
      const cranker = await runtime.loadSigner(command.keypair);
      const { address, intent } = await loadIntent(transport, command.owner, command.nonce);
      return { signature: await transport.send(await expiring(transport, cranker, address, intent, "always", false), cranker) };
    }
    case "close": {
      const payer = await runtime.loadSigner(command.keypair);
      const { address, intent } = await loadIntent(transport, command.owner, command.nonce);
      return { signature: await transport.send(await closing(transport, payer, address, intent, "always"), payer) };
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
        runtime,
        command.by,
        async (authority) => [await buildRaisePause({ authority, flags: command.flags })],
        () => [`Pauses ${pauseList(command.flags)} for every intent until the admin lowers the pause`],
      );
    case "lower-pause":
      return administer(
        transport,
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
      const ctx = context(transport);
      const raw = await rawFlowInput(transport, command.flow, command.input, signer.address);
      switch (command.flow) {
        case "create":
          return perform(prepareCreate, ctx, { owner: signer.address, ...raw }, signer, command.yes);
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
