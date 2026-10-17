import { fileURLToPath } from "node:url";
import fc from "fast-check";
import {
  AccountRole,
  type Address,
  appendTransactionMessageInstructions,
  type Base64EncodedWireTransaction,
  type Blockhash,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getCompiledTransactionMessageDecoder,
  getBase64Encoder,
  getProgramDerivedAddress,
  getTransactionDecoder,
  type Instruction,
  type KeyPairSigner,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { getCreateAccountInstruction, SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import {
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  getTokenDecoder,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ALL_KINDS_MASK,
  buildCreateIntent,
  buildLowerPause,
  buildRaisePause,
  buildUpdateConfig,
  decodeParamsLoose,
  feeBpsFor,
  type IntentParams,
  kindBit,
  PAUSE_FILL,
  remainingOf,
  requiredOut,
  buildInitUser,
  buildUpdateEconomics,
  findAssociatedTokenAddress,
  findConfigPda,
  findEventAuthorityPda,
  findIntentPda,
  getConfigDecoder,
  getInitConfigInstructionAsync,
  getIntentDecoder,
  type Intent,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  IntentStatus,
  Kind,
  splitFees,
  MAX_CRANK_BOUNTY,
  MAX_CREATE_FEE,
} from "@intent-engine/core";
import {
  BACKOFF_MAX_INTERVALS,
  backingOff,
  backoff,
  BALANCES_REFUSED,
  cachedPricer,
  type Chain,
  createdRent,
  FAILED_ON_CHAIN,
  type Flight,
  landings,
  DEFAULT_MAX_RENT,
  DEFAULT_MAX_SOL_COST,
  LAMPORTS_PER_SIGNATURE,
  remembering,
  rentExempt,
  TOKEN_2022_ACCOUNT_SPACE,
  TOKEN_2022_PROGRAM,
  TOKEN_ACCOUNT_SPACE,
  tokenAccountSpace,
  tooCostly,
  tooMuchRent,
  compile,
  COMPUTE_BUDGET_ADDRESS,
  decide,
  fillInstructions,
  decodeLookupTable,
  headroom,
  INVENTORY_SPENT,
  inventoryPricer,
  MAX_COMPUTE_UNITS,
  type Pricer,
  type Quote,
  type QuoteRequest,
  RateLimited,
  ROUTE_ACCOUNT_BUDGETS,
  SIMULATION_REFUSED,
  type Simulated,
  tick,
  tooLarge,
} from "../src/index.js";

const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111" as Address;
const LOOKUP_PROGRAM = "AddressLookupTab1e1111111111111111111111111" as Address;
const NOW = 1_700_000_000n;
const DIFFERENTIAL_RUNS = Math.min(Number(process.env["SOLVER_FUZZ_RUNS"] ?? 100), 150);
const AMOUNT = 100_000n;
const MIN_OUT = 90_000n;
const enginePath =
  process.env["INTENT_ENGINE_SO"] ??
  fileURLToPath(new URL("../../../target/deploy/intent_engine.so", import.meta.url));

let svm: LiteSVM;

async function send(payer: KeyPairSigner, ixs: Instruction[]) {
  svm.expireBlockhash();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const result = svm.sendTransaction(await signTransactionMessageWithSigners(message));
  if (result instanceof FailedTransactionMetadata) {
    throw new Error(`${String(result.err())}\n${result.meta().logs().join("\n")}`);
  }
}

async function funded(): Promise<KeyPairSigner> {
  const kp = await generateKeyPairSigner();
  svm.airdrop(kp.address, lamports(100_000_000_000n));
  return kp;
}

async function mint(payer: KeyPairSigner): Promise<Address> {
  const m = await generateKeyPairSigner();
  const space = BigInt(getMintSize());
  await send(payer, [
    getCreateAccountInstruction({
      payer,
      newAccount: m,
      lamports: svm.minimumBalanceForRentExemption(space),
      space,
      programAddress: TOKEN_PROGRAM_ADDRESS,
    }),
    getInitializeMint2Instruction({ mint: m.address, decimals: 6, mintAuthority: payer.address }),
  ]);
  return m.address;
}

async function ata(payer: KeyPairSigner, owner: Address, m: Address, amount = 0n) {
  const address = await findAssociatedTokenAddress({ owner, mint: m, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  await send(payer, [
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner, mint: m }),
    ...(amount > 0n ? [getMintToInstruction({ mint: m, token: address, mintAuthority: payer, amount })] : []),
  ]);
  return address;
}

function balance(address: Address): bigint {
  const account = svm.getAccount(address);
  return account.exists ? getTokenDecoder().decode(account.data).amount : -1n;
}

const swapping: { current: { mint: Address; from: Address; to: Address; authority: KeyPairSigner } | null } = { current: null };

function stashMarket(
  stash: KeyPairSigner,
  stashAccount: Address,
  outputMint: Address,
  solverOutput: Address,
  pay: (amountIn: bigint) => bigint | null,
  tables: Address[] = [],
): Pricer {
  return {
    async quote(request) {
      const amountOut = pay(request.amountIn);
      if (amountOut === null) {
        return null;
      }
      const take = swapping.current;
      const sold =
        take !== null && take.mint === request.inputMint
          ? [
              getTransferCheckedInstruction({
                source: take.from,
                mint: take.mint,
                destination: take.to,
                authority: take.authority,
                amount: request.amountIn,
                decimals: 6,
              }),
            ]
          : [];
      return {
        amountIn: request.amountIn,
        amountOut,
        lookupTables: tables,
        instructions: [
          ...sold,
          getTransferCheckedInstruction({
            source: stashAccount,
            mint: outputMint,
            destination: solverOutput,
            authority: stash,
            amount: amountOut,
            decimals: 6,
          }),
        ],
      };
    },
  };
}

describe("solver against the deployed engine", () => {
  let authority: KeyPairSigner;
  let feeRecipient: KeyPairSigner;
  let owner: KeyPairSigner;
  let solver: KeyPairSigner;
  let stash: KeyPairSigner;
  let inputMint: Address;
  let outputMint: Address;
  let receiver: Address;
  let solverInput: Address;
  let solverOutput: Address;
  let stashAccount: Address;
  let feeTo: Address;
  let intents: Address[];

  const chain = (): Chain => ({
    async config() {
      const [address] = await findConfigPda();
      const account = svm.getAccount(address);
      if (!account.exists) {
        throw new Error("config missing");
      }
      return getConfigDecoder().decode(account.data);
    },
    async intents() {
      const out: { address: Address; intent: Intent }[] = [];
      for (const address of intents) {
        const account = svm.getAccount(address);
        if (account.exists) {
          out.push({ address, intent: getIntentDecoder().decode(account.data) });
        }
      }
      return out;
    },
    async now() {
      return svm.getClock().unixTimestamp;
    },
    async tokenProgram() {
      return TOKEN_PROGRAM_ADDRESS;
    },
    async exists(address) {
      return svm.getAccount(address).exists;
    },
    async lookupTables(addresses) {
      const out: Record<Address, Address[]> = {};
      for (const address of addresses) {
        const account = svm.getAccount(address);
        if (!account.exists) {
          throw new Error(`lookup table ${address} missing`);
        }
        out[address] = decodeLookupTable(new Uint8Array(account.data));
      }
      return out;
    },
    async blockhash() {
      return { blockhash: svm.latestBlockhash() as Blockhash, lastValidBlockHeight: 0n };
    },
    async tokenAmount(address) {
      const held = balance(address);
      return held < 0n ? 0n : held;
    },
  });

  const submit = async (wire: Base64EncodedWireTransaction) => {
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
    const result = svm.sendTransaction(tx);
    if (result instanceof FailedTransactionMetadata) {
      throw new Error(`${String(result.err())}\n${result.meta().logs().join("\n")}`);
    }
    return result.signature().toString();
  };

  async function open(nonce: bigint, partner?: Address) {
    await send(owner, [
      await buildCreateIntent({
        owner,
        treasury: feeRecipient.address,
        maxCreateFee: MAX_CREATE_FEE,
        maxBounty: MAX_CRANK_BOUNTY,
        nonce,
        params: { kind: Kind.SwapExactIn, amountIn: AMOUNT, minOut: MIN_OUT },
        expiresAt: NOW + 3_600n,
        inputMint,
        outputMint,
        inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        ...(partner === undefined ? {} : { partner: { key: partner, bps: 50 } }),
      }),
    ]);
    const [intent] = await findIntentPda({ owner: owner.address, nonce });
    intents.push(intent);
    return intent;
  }

  const simulated = async (wire: Base64EncodedWireTransaction, watch: readonly Address[] = []): Promise<Simulated> => {
    const result = svm.simulateTransaction(getTransactionDecoder().decode(getBase64Encoder().encode(wire)));
    if (result instanceof FailedTransactionMetadata) {
      return { err: String(result.err()), unitsConsumed: null, balances: [] };
    }
    const post = new Map(result.postAccounts().map((a) => [a.address, a]));
    const amountOf = (address: Address) => {
      const after = post.get(address);
      if (after !== undefined) {
        return getTokenDecoder().decode(after.data).amount;
      }
      const now = balance(address);
      return now < 0n ? null : now;
    };
    return { err: null, unitsConsumed: result.meta().computeUnitsConsumed(), balances: watch.map(amountOf) };
  };

  const landed = async (wire: Base64EncodedWireTransaction) => ({ signature: await submit(wire), confirmed: true });

  const floors = (raw: bigint) => new Map([[outputMint, raw]]);

  function solve(pricer: Pricer, extra: Partial<Parameters<typeof tick>[0]> = {}) {
    return tick({
      chain: chain(),
      pricer,
      solver,
      strategy: { minProfit: floors(1_000n), maxFeeBps: 100 },
      tip: null,
      unitPrice: async () => 0n,
      simulate: simulated,
      send: landed,
      ...extra,
    });
  }

  function budgetOf(wire: Base64EncodedWireTransaction, op: number): number | bigint | null {
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
    const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const budget = message.staticAccounts.indexOf(COMPUTE_BUDGET_ADDRESS);
    const instructions = "instructions" in message ? message.instructions : [];
    const set = instructions.find((ix) => ix.programAddressIndex === budget && ix.data?.[0] === op);
    if (set?.data === undefined) {
      return null;
    }
    const view = new DataView(set.data.buffer, set.data.byteOffset);
    return op === 2 ? view.getUint32(1, true) : view.getBigUint64(1, true);
  }

  beforeEach(async () => {
    svm = new LiteSVM().withPrecompiles();
    svm.addProgramFromFile(INTENT_ENGINE_PROGRAM_ADDRESS, enginePath);
    const clock = svm.getClock();
    clock.unixTimestamp = NOW;
    svm.setClock(clock);
    authority = await funded();
    feeRecipient = await funded();
    const [programData] = await getProgramDerivedAddress({
      programAddress: LOADER,
      seeds: [getAddressEncoder().encode(INTENT_ENGINE_PROGRAM_ADDRESS)],
    });
    const data = svm.getAccount(programData);
    if (!data.exists) {
      throw new Error("program data missing");
    }
    const bytes = new Uint8Array(data.data);
    bytes[12] = 1;
    bytes.set(getAddressEncoder().encode(authority.address), 13);
    svm.setAccount({ ...data, data: bytes });
    const [eventAuthority] = await findEventAuthorityPda();
    await send(authority, [
      await getInitConfigInstructionAsync({
        authority,
        engineProgram: INTENT_ENGINE_PROGRAM_ADDRESS,
        programData,
        eventAuthority,
        program: INTENT_ENGINE_PROGRAM_ADDRESS,
        domain: new Uint8Array(32).fill(0x11),
        guardian: authority.address,
        feeRecipient: feeRecipient.address,
        enabledKinds: ALL_KINDS_MASK,
        feeBps: 5,
        paused: 0,
      }),
    ]);
    owner = await funded();
    solver = await funded();
    stash = await funded();
    inputMint = await mint(authority);
    outputMint = await mint(authority);
    await ata(authority, owner.address, inputMint, 10_000_000n);
    receiver = await ata(authority, owner.address, outputMint);
    solverInput = await ata(authority, solver.address, inputMint);
    solverOutput = await ata(authority, solver.address, outputMint);
    stashAccount = await ata(authority, stash.address, outputMint, 10_000_000n);
    swapping.current = { mint: inputMint, from: solverInput, to: await ata(authority, stash.address, inputMint), authority: solver };
    feeTo = await ata(authority, feeRecipient.address, inputMint);
    intents = [];
    await send(owner, [await buildInitUser({ owner })]);
  });

  it("refuses a route that sends the swap output elsewhere, even when its own inventory could cover the fill", async () => {
    await open(1n);
    await send(authority, [getMintToInstruction({ mint: outputMint, token: solverOutput, mintAuthority: authority, amount: 5_000_000n })]);
    const elsewhere = await ata(authority, (await generateKeyPairSigner()).address, outputMint);
    const held = { solver: balance(solverOutput), receiver: balance(receiver) };
    const report = await solve(stashMarket(stash, stashAccount, outputMint, elsewhere, () => MIN_OUT + 4_000n));
    expect(report.filled).toEqual([]);
    expect(report.failed.map((f) => f.error.split(":")[0])).toEqual([BALANCES_REFUSED]);
    expect([balance(solverOutput), balance(receiver), balance(elsewhere)]).toEqual([held.solver, held.receiver, 0n]);
  });

  it("refuses a route that delivers less than it quoted, or takes more of the solver's input than it quoted", async () => {
    const lying = (quoted: bigint, delivered: bigint, extraInput: bigint): Pricer => ({
      async quote(request) {
        const take = swapping.current;
        if (take === null) {
          throw new Error("no swap input configured");
        }
        return {
          amountIn: request.amountIn,
          amountOut: quoted,
          lookupTables: [],
          instructions: [
            getTransferCheckedInstruction({
              source: take.from,
              mint: take.mint,
              destination: take.to,
              authority: take.authority,
              amount: request.amountIn + extraInput,
              decimals: 6,
            }),
            getTransferCheckedInstruction({
              source: stashAccount,
              mint: outputMint,
              destination: solverOutput,
              authority: stash,
              amount: delivered,
              decimals: 6,
            }),
          ],
        };
      },
    });
    await send(authority, [getMintToInstruction({ mint: inputMint, token: solverInput, mintAuthority: authority, amount: 10n })]);
    await open(1n);
    const short = await solve(lying(MIN_OUT + 4_000n, MIN_OUT + 1_000n, 0n));
    expect(short.filled).toEqual([]);
    expect(short.failed.map((f) => f.error.split(":")[0])).toEqual([BALANCES_REFUSED]);
    const greedy = await solve(lying(MIN_OUT + 4_000n, MIN_OUT + 4_000n, 1n));
    expect(greedy.filled).toEqual([]);
    expect(greedy.failed.map((f) => f.error.split(":")[0])).toEqual([BALANCES_REFUSED]);
    const honest = await solve(lying(MIN_OUT + 4_000n, MIN_OUT + 4_000n, 0n));
    expect(honest.failed).toEqual([]);
    expect(honest.filled).toHaveLength(1);
  });

  it("fills an intent from the solver's own output tokens with no route, when the simulation keeps the planned balances", async () => {
    const intent = await open(1n);
    await send(authority, [getMintToInstruction({ mint: outputMint, token: solverOutput, mintAuthority: authority, amount: AMOUNT })]);
    const pricer = inventoryPricer(
      [{ inputMint, outputMint, outputTokenProgram: TOKEN_PROGRAM_ADDRESS, out: 1n, in: 1n }],
      async () => balance(solverOutput),
    );
    const fees = splitFees(AMOUNT, 5, 0, 0);
    const report = await solve(pricer);
    expect(report).toEqual({ filled: [{ intent, profit: fees.net - MIN_OUT, signature: expect.any(String) }], sent: [], skipped: [], failed: [] });
    expect([balance(receiver), balance(solverOutput), balance(solverInput), balance(feeTo)]).toEqual([MIN_OUT, AMOUNT - MIN_OUT, fees.net, fees.protocol]);
  });

  it("skips, without failing, an inventory fill whose stock an earlier fill of the same tick already spent", async () => {
    const first = await open(1n);
    const second = await open(2n);
    await send(authority, [getMintToInstruction({ mint: outputMint, token: solverOutput, mintAuthority: authority, amount: AMOUNT })]);
    const pricer = inventoryPricer(
      [{ inputMint, outputMint, outputTokenProgram: TOKEN_PROGRAM_ADDRESS, out: 1n, in: 1n }],
      async () => balance(solverOutput),
    );
    const report = await solve(pricer);
    expect(report.failed).toEqual([]);
    expect(report.filled).toHaveLength(1);
    expect(report.skipped.map((s) => [s.intent, s.reason.split(":")[0]])).toEqual([
      [report.filled[0]?.intent === first ? second : first, INVENTORY_SPENT],
    ]);
    expect(balance(receiver)).toBe(MIN_OUT);
  });

  it("sends every inventory fill its stock covers when the sends are not yet confirmed, and skips the one it cannot cover", async () => {
    const opened = [await open(1n), await open(2n), await open(3n)];
    await send(authority, [getMintToInstruction({ mint: outputMint, token: solverOutput, mintAuthority: authority, amount: 2n * AMOUNT })]);
    const pricer = inventoryPricer(
      [{ inputMint, outputMint, outputTokenProgram: TOKEN_PROGRAM_ADDRESS, out: 1n, in: 1n }],
      async () => 3n * AMOUNT,
    );
    const report = await solve(pricer, { send: async (wire) => ({ ...(await landed(wire)), confirmed: false }) });
    expect([report.filled, report.failed]).toEqual([[], []]);
    expect(report.sent).toHaveLength(2);
    expect(report.skipped.map((s) => s.reason.split(":")[0])).toEqual([INVENTORY_SPENT]);
    expect(new Set([...report.sent.map((s) => s.intent), ...report.skipped.map((s) => s.intent)])).toEqual(new Set(opened));
    expect(balance(receiver)).toBe(2n * MIN_OUT);
  });

  it("refuses an inventory fill whose simulation spends more output than required or brings in less input than planned", async () => {
    const intent = await open(1n);
    await send(authority, [
      getMintToInstruction({ mint: outputMint, token: solverOutput, mintAuthority: authority, amount: AMOUNT }),
      getMintToInstruction({ mint: inputMint, token: solverInput, mintAuthority: authority, amount: 10n }),
    ]);
    const elsewhere = { input: await ata(authority, stash.address, inputMint), output: await ata(authority, stash.address, outputMint) };
    const leaking = (mint: Address, source: Address, destination: Address): Pricer => ({
      async quote(request) {
        return {
          amountIn: request.amountIn,
          amountOut: request.amountIn,
          lookupTables: [],
          inventory: true,
          instructions: [getTransferCheckedInstruction({ source, mint, destination, authority: solver, amount: 1n, decimals: 6 })],
        };
      },
    });
    const held = () => [balance(receiver), balance(solverOutput), balance(solverInput), balance(elsewhere.output), balance(elsewhere.input)];
    const before = held();
    for (const pricer of [leaking(outputMint, solverOutput, elsewhere.output), leaking(inputMint, solverInput, elsewhere.input)]) {
      const report = await solve(pricer);
      expect([report.filled, report.sent, report.skipped]).toEqual([[], [], []]);
      expect(report.failed.map((f) => [f.intent, f.error.split(":")[0]])).toEqual([[intent, BALANCES_REFUSED]]);
      expect(held()).toEqual(before);
    }
  });

  it("fills a profitable intent through a flash route, keeps the spread and pays exact fees", async () => {
    const intent = await open(1n);
    const report = await solve(stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 4_000n));
    expect(report.skipped).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(report.filled).toEqual([{ intent, profit: 4_000n, signature: expect.any(String) }]);
    const fees = splitFees(AMOUNT, 5, 0, 0);
    expect(balance(receiver)).toBe(MIN_OUT);
    expect(balance(solverOutput)).toBe(4_000n);
    expect([balance(solverInput), balance(swapping.current?.to ?? solverInput)]).toEqual([0n, fees.net]);
    expect(balance(feeTo)).toBe(fees.protocol);
    const stored = svm.getAccount(intent);
    const state = getIntentDecoder().decode(stored.exists ? stored.data : new Uint8Array());
    expect(state.status).toBe(IntentStatus.Filled);
    const again = await solve(stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 4_000n));
    expect(again).toEqual({ filled: [], sent: [], skipped: [{ intent, reason: "not open" }], failed: [] });
  });

  it("asks only for the compute a simulation measured, padded, and the maximum when it cannot measure", async () => {
    const pricer = () => stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 4_000n);
    const measure = async (simulate: (wire: Base64EncodedWireTransaction, watch: readonly Address[]) => Promise<Simulated>) => {
      const sent: Base64EncodedWireTransaction[] = [];
      const seen: (bigint | null)[] = [];
      const report = await solve(pricer(), {
        simulate: async (wire, watch) => {
          const result = await simulate(wire, watch);
          seen.push(result.unitsConsumed);
          return result;
        },
        send: async (wire) => {
          sent.push(wire);
          return landed(wire);
        },
      });
      expect(report.failed).toEqual([]);
      expect(report.filled).toHaveLength(1);
      return { limit: sent.map((wire) => budgetOf(wire, 2)), seen };
    };
    await open(10n);
    const sized = await measure(simulated);
    const used = sized.seen[0] ?? 0n;
    expect(used).toBeGreaterThan(0n);
    expect(sized.limit).toEqual([headroom(used)]);
    expect(headroom(used)).toBeLessThan(MAX_COMPUTE_UNITS / 10);
    await open(11n);
    const blind = await measure(async (wire, watch) => ({ ...(await simulated(wire, watch)), unitsConsumed: null }));
    expect(blind.limit).toEqual([MAX_COMPUTE_UNITS]);
  });

  it("never sends a fill that fails its simulation and says why", async () => {
    const intent = await open(12n);
    const sent: Base64EncodedWireTransaction[] = [];
    const report = await solve(stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 4_000n), {
      simulate: async () => ({ err: "InstructionError", unitsConsumed: 900n, balances: [] }),
      send: async (wire) => {
        sent.push(wire);
        return landed(wire);
      },
    });
    expect(SIMULATION_REFUSED).toBe("the fill failed in simulation, so it was not sent");
    expect(report).toEqual({ filled: [], sent: [], skipped: [], failed: [{ intent, error: `${SIMULATION_REFUSED}: InstructionError` }] });
    expect(sent).toEqual([]);
    expect(balance(receiver)).toBe(0n);
  });

  it("the sent transaction is simulated with its own compute limit", async () => {
    const pricer = () => stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 4_000n);
    const tight = await open(61n);
    const refusedSims: Base64EncodedWireTransaction[] = [];
    const refusedSends: Base64EncodedWireTransaction[] = [];
    const refused = await solve(pricer(), {
      simulate: async (wire, watch) => {
        refusedSims.push(wire);
        return budgetOf(wire, 2) === MAX_COMPUTE_UNITS ? simulated(wire, watch) : { err: "ComputationalBudgetExceeded", unitsConsumed: null, balances: [] };
      },
      send: async (wire) => {
        refusedSends.push(wire);
        return landed(wire);
      },
    });
    expect(refused).toEqual({
      filled: [],
      sent: [],
      skipped: [],
      failed: [{ intent: tight, error: `${SIMULATION_REFUSED}: ComputationalBudgetExceeded` }],
    });
    expect(refusedSims).toHaveLength(2);
    expect(refusedSends).toEqual([]);
    expect(balance(receiver)).toBe(0n);
    const sims: { wire: Base64EncodedWireTransaction; used: bigint | null }[] = [];
    const sent: Base64EncodedWireTransaction[] = [];
    const filled = await solve(pricer(), {
      simulate: async (wire, watch) => {
        const result = await simulated(wire, watch);
        sims.push({ wire, used: result.unitsConsumed });
        return result;
      },
      send: async (wire) => {
        sent.push(wire);
        return landed(wire);
      },
    });
    expect(filled.filled.map((f) => f.intent)).toEqual([tight]);
    const used = sims[0]?.used ?? 0n;
    expect(used).toBeGreaterThan(0n);
    expect(sims.map((s) => budgetOf(s.wire, 2))).toEqual([MAX_COMPUTE_UNITS, headroom(used)]);
    expect(sent).toEqual([sims[1]?.wire]);
    expect(balance(receiver)).toBe(MIN_OUT);
  });

  it("a fill that failed on chain is backed off", async () => {
    const intent = await open(62n);
    const interval = 5;
    let clock = 0;
    const held = backoff(interval, () => clock);
    const pricer = () => stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 4_000n);
    const flights = new Map<Address, Flight>();
    const signatures: string[] = [];
    let tried = 0;
    const run = async (at: bigint) => {
      const result = await solve(pricer(), {
        backoff: held,
        simulate: async (wire, watch) => {
          tried += 1;
          return simulated(wire, watch);
        },
        send: async () => {
          const signature = `lost-${signatures.length}`;
          signatures.push(signature);
          return { signature, confirmed: false };
        },
      });
      for (const { intent: address, signature } of result.sent) {
        flights.set(address, { until: at + 10n, signature });
      }
      return result;
    };
    const asked: string[] = [];
    const failedOnChain = async (signature: string) => {
      asked.push(signature);
      return signature.startsWith("lost-");
    };
    expect((await run(0n)).sent.map((s) => s.intent)).toEqual([intent]);
    expect(held.size()).toBe(0);
    expect(await landings(flights, 9n, await chain().intents(), failedOnChain, held)).toEqual([]);
    expect(asked).toEqual([]);
    expect(await landings(flights, 10n, await chain().intents(), failedOnChain, held)).toEqual([
      { intent, error: `${FAILED_ON_CHAIN}: lost-0` },
    ]);
    expect(flights.size).toBe(0);
    const triedBefore = tried;
    expect((await run(10n)).skipped).toEqual([{ intent, reason: backingOff(1, interval) }]);
    expect(tried).toBe(triedBefore);
    clock = interval * 1_000;
    expect((await run(20n)).sent.map((s) => s.intent)).toEqual([intent]);
    expect(await landings(flights, 30n, await chain().intents(), failedOnChain, held)).toEqual([
      { intent, error: `${FAILED_ON_CHAIN}: lost-1` },
    ]);
    expect((await run(30n)).skipped).toEqual([{ intent, reason: backingOff(2, 2 * interval) }]);
    expect(asked).toEqual(["lost-0", "lost-1"]);
    clock += 2 * interval * 1_000;
    expect((await run(40n)).sent.map((s) => s.intent)).toEqual([intent]);
    const listed = await chain().intents();
    expect(await landings(flights, 50n, listed, async () => false, held)).toEqual([]);
    expect(listed.map((entry) => held.waiting(entry.address, entry.intent))).toEqual([null]);
    expect(balance(receiver)).toBe(0n);
  });

  it("bids the priority price it is given and reports a bundle as sent, not filled, until it lands", async () => {
    const intent = await open(13n);
    const sent: Base64EncodedWireTransaction[] = [];
    const priced: (readonly unknown[])[] = [];
    const report = await solve(stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 4_000n), {
      unitPrice: async (instructions) => {
        priced.push(instructions);
        return 7_000n;
      },
      send: async (wire) => {
        sent.push(wire);
        return { signature: "bundle-1", confirmed: false };
      },
    });
    expect(report).toEqual({ filled: [], sent: [{ intent, profit: 4_000n, signature: "bundle-1" }], skipped: [], failed: [] });
    expect(priced).toHaveLength(1);
    expect(sent.map((wire) => budgetOf(wire, 3))).toEqual([7_000n]);
    const free = await solve(stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 4_000n), {
      send: async (wire) => {
        sent.push(wire);
        return landed(wire);
      },
    });
    expect(free.filled).toHaveLength(1);
    expect(budgetOf(sent[1] ?? ("" as Base64EncodedWireTransaction), 3)).toBeNull();
  });

  it("pays a bundle tip of exactly the lamports it is told to the account it is told, last, from the solver", async () => {
    const intent = await open(14n);
    const tipAccount = (await generateKeyPairSigner()).address;
    svm.airdrop(tipAccount, lamports(1_000_000_000n));
    const before = svm.getBalance(tipAccount) ?? 0n;
    const solverBefore = svm.getBalance(solver.address) ?? 0n;
    const sent: Base64EncodedWireTransaction[] = [];
    const report = await solve(stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 4_000n), {
      tip: { account: tipAccount, lamports: 12_345n },
      send: async (wire) => {
        sent.push(wire);
        return landed(wire);
      },
    });
    expect(report.filled).toEqual([{ intent, profit: 4_000n, signature: expect.any(String) }]);
    expect((svm.getBalance(tipAccount) ?? 0n) - before).toBe(12_345n);
    expect(solverBefore - (svm.getBalance(solver.address) ?? 0n)).toBeGreaterThanOrEqual(12_345n);
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(sent[0] ?? ("" as Base64EncodedWireTransaction)));
    const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const instructions = "instructions" in message ? message.instructions : [];
    const last = instructions.at(-1);
    expect(message.staticAccounts[last?.programAddressIndex ?? -1]).toBe(SYSTEM_PROGRAM_ADDRESS);
    expect(last?.accountIndices?.map((i) => message.staticAccounts[i])).toEqual([solver.address, tipAccount]);
  });

  it("skips a fill whose sol cost exceeds the cap", async () => {
    const intent = await open(30n);
    const sent: Base64EncodedWireTransaction[] = [];
    const pricer = () => stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 4_000n);
    const priced = (price: bigint): Partial<Parameters<typeof tick>[0]> => ({
      unitPrice: async () => price,
      simulate: async (wire, watch) => ({ ...(await simulated(wire, watch)), unitsConsumed: null }),
      send: async (wire) => {
        sent.push(wire);
        return landed(wire);
      },
    });
    const signers = 2n;
    const cost = signers * LAMPORTS_PER_SIGNATURE + (5_000_000n * BigInt(MAX_COMPUTE_UNITS)) / 1_000_000n;
    expect(cost).toBeLessThan(DEFAULT_MAX_SOL_COST);
    const capped = await solve(pricer(), { ...priced(5_000_000n), maxSolCost: cost - 1n });
    expect(capped).toEqual({ filled: [], sent: [], skipped: [{ intent, reason: tooCostly(cost, cost - 1n) }], failed: [] });
    const dear = signers * LAMPORTS_PER_SIGNATURE + (10_000_000n * BigInt(MAX_COMPUTE_UNITS)) / 1_000_000n;
    const unbounded = await solve(pricer(), priced(10_000_000n));
    expect(unbounded.skipped).toEqual([{ intent, reason: tooCostly(dear, DEFAULT_MAX_SOL_COST) }]);
    expect(sent).toEqual([]);
    expect(balance(receiver)).toBe(0n);
    const allowed = await solve(pricer(), { ...priced(5_000_000n), maxSolCost: cost });
    expect(allowed.filled).toEqual([{ intent, profit: 4_000n, signature: expect.any(String) }]);
    expect(sent.map((wire) => budgetOf(wire, 2))).toEqual([MAX_COMPUTE_UNITS]);
  });

  it("kept rent does not count against the sol cost", async () => {
    const intent = await open(31n);
    solver = await funded();
    const freshInput = await findAssociatedTokenAddress({ owner: solver.address, mint: inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const freshOutput = await findAssociatedTokenAddress({ owner: solver.address, mint: outputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    swapping.current = { mint: inputMint, from: freshInput, to: swapping.current?.to ?? freshInput, authority: solver };
    const tipAccount = (await generateKeyPairSigner()).address;
    svm.airdrop(tipAccount, lamports(1_000_000_000n));
    const rent = svm.minimumBalanceForRentExemption(BigInt(TOKEN_ACCOUNT_SPACE));
    expect(rentExempt(TOKEN_ACCOUNT_SPACE)).toBe(rent);
    const signers = 2n;
    const cost = signers * LAMPORTS_PER_SIGNATURE + 12_345n;
    const kept = 2n * rent;
    expect(kept).toBeLessThan(DEFAULT_MAX_RENT);
    const tipped = { tip: { account: tipAccount, lamports: 12_345n } };
    const pricer = () => stashMarket(stash, stashAccount, outputMint, freshOutput, () => MIN_OUT + 4_000n);
    const capped = await solve(pricer(), { ...tipped, maxSolCost: cost - 1n });
    expect(capped.skipped).toEqual([{ intent, reason: tooCostly(cost, cost - 1n), rent: kept }]);
    const stingy = await solve(pricer(), { ...tipped, maxSolCost: cost, maxRent: kept - 1n });
    expect(stingy.skipped).toEqual([{ intent, reason: tooMuchRent(kept, kept - 1n), rent: kept }]);
    expect([svm.getAccount(freshInput).exists, svm.getAccount(freshOutput).exists]).toEqual([false, false]);
    const before = svm.getBalance(solver.address) ?? 0n;
    const report = await solve(pricer(), { ...tipped, maxSolCost: cost });
    expect(report.filled).toEqual([{ intent, profit: 4_000n, signature: expect.any(String), rent: kept }]);
    expect(before - (svm.getBalance(solver.address) ?? 0n)).toBe(cost + kept);
    expect([svm.getBalance(freshInput), svm.getBalance(freshOutput)]).toEqual([rent, rent]);
  });

  it("backoff waits in seconds not ticks", async () => {
    const intent = await open(32n);
    const interval = 5;
    let clock = 0;
    const held = backoff(interval, () => clock);
    const pricer = () => stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 4_000n);
    let failing = true;
    let tried = 0;
    const moved: Chain = {
      ...chain(),
      intents: async () => (await chain().intents()).map((e) => ({ ...e, intent: { ...e.intent, expiresAt: e.intent.expiresAt + 1n } })),
    };
    const run = (extra: Partial<Parameters<typeof tick>[0]> = {}) =>
      solve(pricer(), {
        backoff: held,
        simulate: async (wire, watch) => {
          tried += 1;
          return failing ? { err: "InstructionError", unitsConsumed: null, balances: [] } : simulated(wire, watch);
        },
        ...extra,
      });
    const failedOnce = async (extra: Partial<Parameters<typeof tick>[0]> = {}) =>
      expect((await run(extra)).failed.map((f) => f.intent)).toEqual([intent]);
    await failedOnce();
    for (let i = 0; i < 40; i += 1) {
      expect((await run()).skipped).toEqual([{ intent, reason: backingOff(1, interval) }]);
    }
    expect(tried).toBe(1);
    clock = interval * 1_000 - 1;
    expect((await run()).skipped).toEqual([{ intent, reason: backingOff(1, 1) }]);
    clock = interval * 1_000;
    await failedOnce();
    expect((await run()).skipped).toEqual([{ intent, reason: backingOff(2, 2 * interval) }]);
    clock += 2 * interval * 1_000;
    await failedOnce();
    expect((await run()).skipped).toEqual([{ intent, reason: backingOff(3, 4 * interval) }]);
    expect(tried).toBe(3);
    await failedOnce({ chain: moved });
    expect(tried).toBe(4);
    expect((await run({ chain: moved })).skipped).toEqual([{ intent, reason: backingOff(1, interval) }]);
    clock += interval * 1_000;
    failing = false;
    expect((await run({ chain: moved })).filled.map((f) => f.intent)).toEqual([intent]);
    expect(held.size()).toBe(0);
    expect(balance(receiver)).toBe(MIN_OUT);
    const state = (await chain().intents())[0]?.intent;
    if (state === undefined) {
      throw new Error("intent missing");
    }
    const alone = backoff(interval, () => clock);
    for (let i = 0; i < 10; i += 1) {
      alone.failed(intent, state);
    }
    expect(alone.waiting(intent, state)).toEqual({ failures: 10, seconds: interval * BACKOFF_MAX_INTERVALS });
    alone.succeeded(intent);
    expect(alone.waiting(intent, state)).toBeNull();
    alone.failed(intent, state);
    expect(alone.waiting(intent, state)).toEqual({ failures: 1, seconds: interval });
  });

  it("backoff forgets intents that are no longer open", async () => {
    const opened = [await open(40n), await open(41n), await open(42n), await open(43n)];
    const listed = await chain().intents();
    const stateOf = (address: Address): Intent => {
      const found = listed.find((entry) => entry.address === address)?.intent;
      if (found === undefined) {
        throw new Error("intent missing");
      }
      return found;
    };
    const [kept, filled, expired, gone] = opened.map((address) => ({ address, intent: stateOf(address) }));
    if (kept === undefined || filled === undefined || expired === undefined || gone === undefined) {
      throw new Error("intents missing");
    }
    const held = backoff(5, () => 0);
    for (const { address, intent } of listed) {
      held.failed(address, intent);
    }
    expect(held.size()).toBe(4);
    held.retain(listed, NOW);
    expect(held.size()).toBe(4);
    held.retain(
      [
        kept,
        { ...filled, intent: { ...filled.intent, status: IntentStatus.Filled } },
        { ...expired, intent: { ...expired.intent, expiresAt: NOW } },
      ],
      NOW,
    );
    expect(held.size()).toBe(1);
    expect(held.waiting(kept.address, kept.intent)).toEqual({ failures: 1, seconds: 5 });
    for (const { address, intent } of [filled, expired, gone]) {
      expect(held.waiting(address, intent)).toBeNull();
    }
    held.retain([{ ...kept, intent: { ...kept.intent, status: IntentStatus.Cancelled } }], NOW);
    expect(held.size()).toBe(0);
  });

  it("asks the chain nothing about an intent it can tell from its own state that it will not fill", async () => {
    await open(1n);
    const asked: string[] = [];
    const counted = chain();
    const watched: Chain = {
      ...counted,
      tokenProgram: async (mint) => (asked.push("tokenProgram"), counted.tokenProgram(mint)),
      exists: async (address) => (asked.push("exists"), counted.exists(address)),
      blockhash: async () => (asked.push("blockhash"), counted.blockhash()),
      tokenAmount: async (address) => (asked.push("tokenAmount"), counted.tokenAmount(address)),
      lookupTables: async (addresses) => (asked.push("lookupTables"), counted.lookupTables(addresses)),
    };
    const none: Pricer = { quote: async () => null };
    const report = await solve(none, { chain: watched, strategy: { minProfit: new Map(), maxFeeBps: 100 } });
    expect(report.skipped).toEqual([{ intent: intents[0], reason: `no profit floor is set for ${outputMint}` }]);
    expect(asked).toEqual([]);
    await solve(none, { chain: watched });
    expect(asked.length).toBeGreaterThan(0);
  });

  it("skips an output token it has no profit floor for before asking the market", async () => {
    const intent = await open(14n);
    let asked = 0;
    const pricer: Pricer = {
      async quote() {
        asked += 1;
        return null;
      },
    };
    const report = await solve(pricer, { strategy: { minProfit: new Map(), maxFeeBps: 100 } });
    expect(report.skipped).toEqual([{ intent, reason: `no profit floor is set for ${outputMint}` }]);
    expect(asked).toBe(0);
  });

  it("opens its own input account for a token it has never received, inside the fill", async () => {
    const intent = await open(15n);
    solver = await funded();
    solverOutput = await ata(authority, solver.address, outputMint);
    const fresh = await findAssociatedTokenAddress({ owner: solver.address, mint: inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(svm.getAccount(fresh).exists).toBe(false);
    const stashInput = swapping.current?.to ?? fresh;
    swapping.current = { mint: inputMint, from: fresh, to: stashInput, authority: solver };
    const sold = balance(stashInput);
    const report = await solve(stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 4_000n));
    expect(report.failed).toEqual([]);
    expect(report.filled.map((f) => f.intent)).toEqual([intent]);
    expect(balance(fresh)).toBe(0n);
    expect(balance(stashInput) - sold).toBe(splitFees(AMOUNT, 5, 0, 0).net);
  });

  it("opens its own output account for a token it has never held, inside the fill", async () => {
    const intent = await open(17n);
    solver = await funded();
    solverInput = await ata(authority, solver.address, inputMint);
    const fresh = await findAssociatedTokenAddress({ owner: solver.address, mint: outputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(svm.getAccount(fresh).exists).toBe(false);
    swapping.current = { mint: inputMint, from: solverInput, to: swapping.current?.to ?? solverInput, authority: solver };
    const report = await solve(stashMarket(stash, stashAccount, outputMint, fresh, () => MIN_OUT + 4_000n));
    expect(report.failed).toEqual([]);
    expect(report.filled).toEqual([{ intent, profit: 4_000n, signature: expect.any(String), rent: rentExempt(TOKEN_ACCOUNT_SPACE) }]);
    expect(balance(fresh)).toBe(4_000n);
    expect(balance(receiver)).toBe(MIN_OUT);
  });

  it("checks that every payee can be paid before it spends a quote", async () => {
    const partner = await funded();
    const loner = await open(16n, partner.address);
    let asked = 0;
    const pricer: Pricer = {
      async quote() {
        asked += 1;
        return null;
      },
    };
    const report = await solve(pricer);
    expect(report.skipped).toEqual([{ intent: loner, reason: "no partner account to pay into" }]);
    expect(asked).toBe(0);
  });

  it("pays a partner its share when the intent names one", async () => {
    const partner = await funded();
    const partnerTo = await ata(authority, partner.address, inputMint);
    await send(authority, [
      await buildUpdateEconomics({
        admin: authority,
        economics: { kindFeeMask: 0, kindFeeBps: [0, 0, 0, 0], partnerCutBps: 2_000, crankBounty: 0, createFee: 0 },
      }),
    ]);
    await open(2n, partner.address);
    const report = await solve(stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 2_000n));
    expect(report.filled).toHaveLength(1);
    const fees = splitFees(AMOUNT, 5, 50, 2_000);
    expect(balance(partnerTo)).toBe(fees.partner);
    expect(balance(feeTo)).toBe(fees.protocol);
    expect([balance(solverInput), balance(swapping.current?.to ?? solverInput)]).toEqual([0n, fees.net]);
  });

  it("skips what does not pay and keeps going after a failure", async () => {
    const thin = await open(3n);
    const broken = await open(4n);
    const good = await open(5n);
    const outs = new Map<Address, bigint | "throw">([
      [thin, MIN_OUT + 999n],
      [broken, "throw"],
      [good, MIN_OUT + 5_000n],
    ]);
    let current = 0;
    const order = [thin, broken, good];
    const pricer: Pricer = {
      async quote(request) {
        const which = order[current];
        current += 1;
        const out = which === undefined ? undefined : outs.get(which);
        if (out === "throw") {
          throw new Error("market unavailable");
        }
        return stashMarket(stash, stashAccount, outputMint, solverOutput, () => out ?? null).quote(request);
      },
    };
    const report = await solve(pricer, { concurrency: 1 });
    expect(report.skipped).toEqual([{ intent: thin, reason: "profit 999 is below 1000" }]);
    expect(report.failed).toEqual([{ intent: broken, error: "market unavailable" }]);
    expect(report.filled.map((f) => f.intent)).toEqual([good]);
    expect(balance(receiver)).toBe(MIN_OUT);
  });

  it("rides a cyclic arbitrage on the spread in the same transaction", async () => {
    const intent = await open(6n);
    const arbStash = await funded();
    const arbAccount = await ata(authority, arbStash.address, outputMint, 1_000_000n);
    const cycle = async (_mint: Address, amount: bigint): Promise<Quote> =>
      stashMarket(arbStash, arbAccount, outputMint, solverOutput, () => 2_500n).quote({
        inputMint: outputMint,
        outputMint,
        amountIn: amount,
        taker: solver.address,
      }) as Promise<Quote>;
    const report = await solve(stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 2_000n), {
      strategy: {
        minProfit: floors(1_000n),
        maxFeeBps: 100,
        cycle: async (m, amount) => {
          const q = await cycle(m, amount);
          return { ...q, amountOut: amount + q.amountOut };
        },
      },
    });
    expect(report.filled).toEqual([{ intent, profit: 4_500n, signature: expect.any(String) }]);
    expect(balance(solverOutput)).toBe(4_500n);
    expect(balance(receiver)).toBe(MIN_OUT);
  });

  it("skips an intent whose fee or partner account does not exist yet", async () => {
    const partner = await funded();
    const loner = await open(8n, partner.address);
    const report = await solve(stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 9_000n));
    expect(report).toEqual({ filled: [], sent: [], skipped: [{ intent: loner, reason: "no partner account to pay into" }], failed: [] });
    const nofee = await mint(authority);
    await ata(authority, owner.address, nofee, 1_000_000n);
    await send(owner, [
      await buildCreateIntent({
        owner,
        treasury: feeRecipient.address,
        maxCreateFee: MAX_CREATE_FEE,
        maxBounty: MAX_CRANK_BOUNTY,
        nonce: 9n,
        params: { kind: Kind.SwapExactIn, amountIn: AMOUNT, minOut: MIN_OUT },
        expiresAt: NOW + 3_600n,
        inputMint: nofee,
        outputMint,
        inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        partner: { key: partner.address, bps: 50 },
      }),
    ]);
    const [both] = await findIntentPda({ owner: owner.address, nonce: 9n });
    intents.length = 0;
    intents.push(both);
    const again = await solve(stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 9_000n));
    expect(again.skipped).toEqual([{ intent: both, reason: "no fee or partner account to pay into" }]);
  });

  it("asks for a smaller route when a fill does not fit in one transaction, and skips it when none does", async () => {
    const intent = await open(17n);
    const unique = await Promise.all(Array.from({ length: 60 }, async () => ({ address: (await generateKeyPairSigner()).address, role: 0 })));
    const wide = { programAddress: TOKEN_PROGRAM_ADDRESS, accounts: unique, data: new Uint8Array([255]) };
    const long = { programAddress: TOKEN_PROGRAM_ADDRESS, accounts: [], data: new Uint8Array(1_000).fill(255) };
    let bloat: typeof wide | typeof long = long;
    const asked: (number | undefined)[] = [];
    const sized = (fits: (budget: number | undefined) => boolean): Pricer => ({
      async quote(request) {
        asked.push(request.maxAccounts);
        const q = await stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 4_000n).quote(request);
        return q === null || fits(request.maxAccounts) ? q : { ...q, instructions: [...q.instructions, bloat] };
      },
    });
    expect(ROUTE_ACCOUNT_BUDGETS).toEqual([40, 30, 20]);
    const smaller = await solve(sized((budget) => budget === 30));
    expect(asked).toEqual([40, 30]);
    expect(smaller.filled.map((f) => f.intent)).toEqual([intent]);
    const again = await open(18n);
    intents.length = 0;
    intents.push(again);
    asked.length = 0;
    bloat = wide;
    const never = await solve(sized(() => false));
    expect(asked).toEqual([40, 30, 20]);
    expect(never.filled).toEqual([]);
    expect(never.skipped).toHaveLength(1);
    expect(never.skipped[0]?.intent).toBe(again);
    expect(never.skipped[0]?.reason).toMatch(
      /^even the smallest route makes the fill lock \d+ accounts; a transaction holds 1232 bytes and 64 accounts$/,
    );
    expect(tooLarge(1300, 50)).toBe("even the smallest route makes the fill 1300 bytes with 50 accounts; a transaction holds 1232 bytes and 64 accounts");
    expect(tooLarge(null, 70)).toBe("even the smallest route makes the fill lock 70 accounts; a transaction holds 1232 bytes and 64 accounts");
    const third = await open(19n);
    intents.length = 0;
    intents.push(third);
    asked.length = 0;
    bloat = long;
    const heavy = await solve(sized(() => false));
    expect(asked).toEqual([40, 30, 20]);
    expect(heavy.skipped.map((s) => s.intent)).toEqual([third]);
    expect(heavy.skipped[0]?.reason).toMatch(/^even the smallest route makes the fill \d{4} bytes with \d+ accounts;/);
  });

  it("stops asking the market for the rest of a run once it is rate limited", async () => {
    const first = await open(20n);
    const second = await open(21n);
    let asked = 0;
    const limited: Pricer = {
      async quote() {
        asked += 1;
        throw new RateLimited();
      },
    };
    const report = await solve(limited, { concurrency: 1 });
    const reason = new RateLimited().message;
    expect(report).toEqual({
      filled: [],
      sent: [],
      skipped: [
        { intent: first, reason },
        { intent: second, reason },
      ],
      failed: [],
    });
    expect(asked).toBe(1);
  });

  const cachedMarket = (pay: { out: bigint }) => {
    const asked: (boolean | undefined)[] = [];
    const market = stashMarket(stash, stashAccount, outputMint, solverOutput, () => pay.out);
    const counted: Pricer = {
      quote: (request) => {
        asked.push(request.fresh);
        return market.quote(request);
      },
    };
    return { asked, pricer: cachedPricer(counted, { ttlMs: 10_000, clock: () => 0 }) };
  };

  const routeRequest = (): QuoteRequest => ({
    inputMint,
    outputMint,
    amountIn: splitFees(AMOUNT, 5, 0, 0).net,
    taker: solver.address,
    maxAccounts: ROUTE_ACCOUNT_BUDGETS[0],
  });

  it("builds a fill decided from a stored quote only from a fresh quote", async () => {
    const intent = await open(30n);
    const pay = { out: MIN_OUT + 4_000n };
    const { asked, pricer } = cachedMarket(pay);
    await pricer.quote(routeRequest());
    pay.out = MIN_OUT + 2_000n;
    const report = await solve(pricer);
    expect(report.failed).toEqual([]);
    expect(report.filled).toEqual([{ intent, profit: 2_000n, signature: expect.any(String) }]);
    expect(asked).toEqual([undefined, true]);
    expect([balance(receiver), balance(solverOutput)]).toEqual([MIN_OUT, 2_000n]);
  });

  it("skips a fill decided from a stored quote when the fresh quote no longer pays", async () => {
    const intent = await open(31n);
    const pay = { out: MIN_OUT + 4_000n };
    const { asked, pricer } = cachedMarket(pay);
    await pricer.quote(routeRequest());
    pay.out = MIN_OUT - 1n;
    const report = await solve(pricer);
    expect(report).toEqual({
      filled: [],
      sent: [],
      skipped: [{ intent, reason: `the route pays ${MIN_OUT - 1n}, less than the ${MIN_OUT} the intent requires` }],
      failed: [],
    });
    expect(asked).toEqual([undefined, true]);
    expect([balance(receiver), balance(solverOutput)]).toEqual([0n, 0n]);
  });

  it("asks the market once for a fill from a quote that was not stored", async () => {
    const intent = await open(32n);
    const { asked, pricer } = cachedMarket({ out: MIN_OUT + 4_000n });
    const report = await solve(pricer);
    expect(report.filled).toEqual([{ intent, profit: 4_000n, signature: expect.any(String) }]);
    expect(asked).toEqual([undefined]);
  });

  it("compresses the route through an on-chain lookup table", async () => {
    await open(7n);
    const table = (await generateKeyPairSigner()).address;
    const addresses = [stashAccount, outputMint, TOKEN_PROGRAM_ADDRESS, inputMint, receiver, feeTo];
    const data = new Uint8Array(56 + addresses.length * 32);
    new DataView(data.buffer).setUint32(0, 1, true);
    new DataView(data.buffer).setBigUint64(4, 0xffff_ffff_ffff_ffffn, true);
    addresses.forEach((a, i) => data.set(getAddressEncoder().encode(a), 56 + i * 32));
    svm.setAccount({
      address: table,
      data,
      executable: false,
      lamports: lamports(1_000_000_000n),
      programAddress: LOOKUP_PROGRAM,
      space: BigInt(data.length),
    });
    svm.warpToSlot(10n);
    const report = await solve(
      stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 3_000n, [table]),
    );
    expect(report.failed).toEqual([]);
    expect(report.filled).toHaveLength(1);
    expect(balance(receiver)).toBe(MIN_OUT);
  });

  it("fills exactly what the program accepts and never spends on what the program refuses", async () => {
    const partner = await funded();
    await ata(authority, partner.address, inputMint);
    await send(authority, [
      getMintToInstruction({ mint: outputMint, token: stashAccount, mintAuthority: authority, amount: 1_000_000_000_000n }),
      getMintToInstruction({
        mint: inputMint,
        token: await findAssociatedTokenAddress({ owner: owner.address, mint: inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
        mintAuthority: authority,
        amount: 1_000_000_000_000n,
      }),
    ]);
    const setNow = (unix: bigint) => {
      const clock = svm.getClock();
      clock.unixTimestamp = unix;
      svm.setClock(clock);
    };
    const seen = new Map<string, number>();
    const enforced = ["fills are paused", "expired", "fills of this kind are stopped"];
    let paused = false;
    let nonce = 10n;
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          kind: fc.constantFrom(Kind.SwapExactIn, Kind.LimitOrder, Kind.DutchAuction),
          amount: fc.bigInt({ min: 1_000n, max: 1_000_000n }),
          ratio: fc.bigInt({ min: 1n, max: 200n }),
          feeBps: fc.integer({ min: 0, max: 100 }),
          partnerBps: fc.constantFrom(0, 1, 50, 100),
          pause: fc.integer({ min: 0, max: 7 }).map((n) => n === 0),
          stop: fc.integer({ min: 0, max: 7 }).map((n) => n === 0),
          age: fc.oneof({ weight: 6, arbitrary: fc.bigInt({ min: 0n, max: 3_599n }) }, { weight: 1, arbitrary: fc.bigInt({ min: 3_600n, max: 7_200n }) }),
          delta: fc.oneof({ weight: 5, arbitrary: fc.bigInt({ min: 0n, max: 5_000n }) }, { weight: 2, arbitrary: fc.bigInt({ min: -3n, max: 3n }) }),
          floor: fc.oneof({ weight: 5, arbitrary: fc.bigInt({ min: 0n, max: 200n }) }, { weight: 1, arbitrary: fc.bigInt({ min: 201n, max: 6_000n }) }),
          maxFeeBps: fc.oneof({ weight: 6, arbitrary: fc.constant(220) }, { weight: 2, arbitrary: fc.integer({ min: 0, max: 50 }) }),
        }),
        async (s) => {
          setNow(NOW);
          await send(authority, [
            await buildUpdateConfig({
              admin: authority,
              update: {
                guardian: authority.address,
                feeRecipient: feeRecipient.address,
                enabledKinds: ALL_KINDS_MASK,
                feeBps: s.feeBps,
                fillDisabledKinds: s.stop ? kindBit(s.kind) : 0n,
              },
            }),
            ...(s.pause === paused
              ? []
              : [s.pause ? await buildRaisePause({ authority, flags: PAUSE_FILL }) : await buildLowerPause({ admin: authority, flags: PAUSE_FILL })]),
          ]);
          paused = s.pause;
          const out = (s.amount * s.ratio) / 100n + 1n;
          const params: IntentParams =
            s.kind === Kind.SwapExactIn
              ? { kind: Kind.SwapExactIn, amountIn: s.amount, minOut: out }
              : s.kind === Kind.LimitOrder
                ? { kind: Kind.LimitOrder, makeAmount: s.amount, takeAmount: out }
                : { kind: Kind.DutchAuction, amountIn: s.amount, startOut: 2n * out, endOut: out, startTs: NOW, endTs: NOW + 3_600n };
          nonce += 1n;
          await send(owner, [
            await buildCreateIntent({
              owner,
              treasury: feeRecipient.address,
              maxCreateFee: MAX_CREATE_FEE,
              maxBounty: MAX_CRANK_BOUNTY,
              nonce,
              params,
              expiresAt: NOW + 3_600n,
              inputMint,
              outputMint,
              inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
              outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
              ...(s.partnerBps === 0 ? {} : { partner: { key: partner.address, bps: s.partnerBps } }),
            }),
          ]);
          const [address] = await findIntentPda({ owner: owner.address, nonce });
          intents = [address];
          const now = NOW + s.age;
          setNow(now);
          const config = await chain().config();
          const listed = await chain().intents();
          const intent = listed[0]?.intent;
          if (intent === undefined) {
            throw new Error("intent missing");
          }
          const decoded = decodeParamsLoose(intent.kind, Uint8Array.from(intent.params)) as IntentParams;
          const amountIn = remainingOf(intent);
          const required = requiredOut(decoded, amountIn, now);
          const pricer = stashMarket(stash, stashAccount, outputMint, solverOutput, () => {
            const paid = required + s.delta;
            return paid > 0n ? paid : 0n;
          });
          const strategy = { minProfit: floors(s.floor), maxFeeBps: s.maxFeeBps };
          const decision = await decide(address, intent, config, now, pricer, solver.address, strategy);
          const outcome = decision.kind === "fill" ? "fill" : decision.reason.replace(/[0-9]+/g, "N");
          seen.set(outcome, (seen.get(outcome) ?? 0) + 1);
          const before = { receiver: balance(receiver), solver: balance(solverOutput) };
          const report = await solve(pricer, { strategy });
          expect(report.failed, outcome).toEqual([]);
          if (decision.kind === "fill") {
            expect(report.filled.map((f) => f.intent), outcome).toEqual([address]);
            expect(balance(receiver) - before.receiver).toBe(decision.plan.required);
            expect(balance(solverOutput) - before.solver).toBe(decision.plan.profit);
            return;
          }
          expect(report.filled, outcome).toEqual([]);
          expect(balance(solverOutput)).toBe(before.solver);
          if (enforced.includes(decision.reason)) {
            const feeBps = feeBpsFor(config, intent.kind);
            const fees = splitFees(amountIn, feeBps, intent.partnerBps, intent.partnerCutBps);
            const route = await stashMarket(stash, stashAccount, outputMint, solverOutput, () => required + 1_000n).quote({
              inputMint: intent.inputMint,
              outputMint: intent.outputMint,
              amountIn: fees.net,
              taker: solver.address,
            });
            if (route === null) {
              throw new Error("no forced route");
            }
            const forced = await fillInstructions(
              { address, intent, amountIn, required, feeBps, fees, route, arbitrage: null, profit: 0n },
              {
                solver,
                feeRecipient: config.feeRecipient,
                inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
                outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
                computeUnits: MAX_COMPUTE_UNITS,
                unitPrice: 0n,
                createSolverInput: false,
                createSolverOutput: false,
                tip: null,
              },
            );
            const wire = await compile(forced, solver, await chain().blockhash(), {});
            expect((await simulated(wire)).err, outcome).not.toBeNull();
          }
        },
      ),
      { numRuns: DIFFERENTIAL_RUNS },
    );
    const reached = [...seen.keys()];
    for (const want of ["fill", "expired", "fills are paused", "fills of this kind are stopped", "profit N is below N"]) {
      expect(reached, `never reached: ${want}`).toContain(want);
    }
    expect(reached.some((r) => r.startsWith("the route pays N, less than")), "never reached a short route").toBe(true);
    expect(reached.some((r) => r.startsWith("fees of N bps exceed")), "never reached the fee bound").toBe(true);
    expect(seen.get("fill") ?? 0).toBeGreaterThan(DIFFERENTIAL_RUNS / 12);
  }, 600_000);
});

describe("token 2022 accounts the solver opens", () => {
  const TRANSFER_FEE = Uint8Array.from([26, 0, 0, 0, 50, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  const NON_TRANSFERABLE = Uint8Array.from([32]);
  const MINT_SPACE = { transferFee: 112, nonTransferable: 4, transferHook: 68 };

  async function mint2022(payer: KeyPairSigner, extensions: { data: Uint8Array; space: number }[]): Promise<Address> {
    const m = await generateKeyPairSigner();
    const space = BigInt(extensions.length === 0 ? getMintSize() : TOKEN_ACCOUNT_SPACE + 1 + extensions.reduce((sum, e) => sum + e.space, 0));
    const mintData = new Uint8Array(35);
    mintData.set([20, 6]);
    mintData.set(getAddressEncoder().encode(payer.address), 2);
    const only = (data: Uint8Array): Instruction => ({
      programAddress: TOKEN_2022_PROGRAM,
      accounts: [{ address: m.address, role: AccountRole.WRITABLE }],
      data,
    });
    await send(payer, [
      getCreateAccountInstruction({
        payer,
        newAccount: m,
        lamports: svm.minimumBalanceForRentExemption(space),
        space,
        programAddress: TOKEN_2022_PROGRAM,
      }),
      ...extensions.map((e) => only(e.data)),
      only(mintData),
    ]);
    return m.address;
  }

  it("token 2022 rent follows the mint extensions", async () => {
    svm = new LiteSVM();
    const payer = await funded();
    const hookData = new Uint8Array(66);
    hookData.set([36, 0]);
    hookData.set(getAddressEncoder().encode(payer.address), 2);
    hookData.set(getAddressEncoder().encode((await generateKeyPairSigner()).address), 34);
    const fee = { data: TRANSFER_FEE, space: MINT_SPACE.transferFee };
    const cases = [
      { mint: await mint2022(payer, []), space: TOKEN_2022_ACCOUNT_SPACE },
      { mint: await mint2022(payer, [fee]), space: TOKEN_2022_ACCOUNT_SPACE + 12 },
      {
        mint: await mint2022(payer, [
          fee,
          { data: hookData, space: MINT_SPACE.transferHook },
          { data: NON_TRANSFERABLE, space: MINT_SPACE.nonTransferable },
        ]),
        space: TOKEN_2022_ACCOUNT_SPACE + 12 + 5 + 4,
      },
    ];
    const reads: Address[] = [];
    const unused = () => Promise.reject(new Error("unused"));
    const chain = remembering({
      config: unused,
      intents: unused,
      now: unused,
      tokenProgram: unused,
      exists: unused,
      lookupTables: unused,
      blockhash: unused,
      tokenAmount: unused,
      mintData: async (m) => {
        reads.push(m);
        const account = svm.getAccount(m);
        return account.exists ? new Uint8Array(account.data) : null;
      },
    });
    for (const { mint: m, space } of cases) {
      const owner = (await generateKeyPairSigner()).address;
      const create = await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner, mint: m, tokenProgram: TOKEN_2022_PROGRAM });
      const rent = await createdRent([create, create], async () => false, (address) => chain.mintData?.(address) ?? Promise.resolve(null));
      expect(await createdRent([create], async () => false, (address) => chain.mintData?.(address) ?? Promise.resolve(null))).toBe(rent);
      await send(payer, [create]);
      const opened = svm.getAccount(await findAssociatedTokenAddress({ owner, mint: m, tokenProgram: TOKEN_2022_PROGRAM }));
      if (!opened.exists) {
        throw new Error("token account missing");
      }
      expect(opened.data.length).toBe(space);
      expect(rent).toBe(opened.lamports);
      expect(rent).toBe(rentExempt(space));
      expect(tokenAccountSpace(TOKEN_2022_PROGRAM, (await chain.mintData?.(m)) ?? null)).toBe(space);
    }
    expect(reads).toEqual(cases.map((c) => c.mint));
    expect(tokenAccountSpace(TOKEN_PROGRAM_ADDRESS, null)).toBe(TOKEN_ACCOUNT_SPACE);
    expect(tokenAccountSpace(TOKEN_2022_PROGRAM, null)).toBe(TOKEN_2022_ACCOUNT_SPACE);
  });
});
