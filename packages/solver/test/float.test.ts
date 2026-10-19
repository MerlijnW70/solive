import { fileURLToPath } from "node:url";
import {
  type Address,
  appendTransactionMessageInstructions,
  type Base64EncodedWireTransaction,
  type Blockhash,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
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
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  getApproveInstruction,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  getTokenDecoder,
  getTransferInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ALL_KINDS_MASK,
  buildCreateIntent,
  buildInitUser,
  findAssociatedTokenAddress,
  findConfigPda,
  findEventAuthorityPda,
  findIntentPda,
  getConfigDecoder,
  getInitConfigInstructionAsync,
  getIntentDecoder,
  type Intent,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  Kind,
  MAX_CRANK_BOUNTY,
  MAX_CREATE_FEE,
  splitFees,
} from "@intent-engine/core";
import {
  ALLOWANCE_LOW,
  ALLOWANCE_SPENT,
  allowanceOf,
  type Chain,
  decodeLookupTable,
  INVENTORY_ONLY,
  inventoryPricer,
  NO_ALLOWANCE_READER,
  OWNER_IS_SOLVER,
  type Pricer,
  type Simulated,
  spendable,
  tick,
  TOKEN_ACCOUNT_BASE,
} from "../src/index.js";

const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111" as Address;
const NOW = 1_700_000_000n;
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

const ataOf = (owner: Address, m: Address) => findAssociatedTokenAddress({ owner, mint: m, tokenProgram: TOKEN_PROGRAM_ADDRESS });

async function ata(payer: KeyPairSigner, owner: Address, m: Address, amount = 0n) {
  const address = await ataOf(owner, m);
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

function dataOf(address: Address): Uint8Array | null {
  const account = svm.getAccount(address);
  return account.exists ? new Uint8Array(account.data) : null;
}

describe("a solver that fills from an inventory owner's float", () => {
  let authority: KeyPairSigner;
  let feeRecipient: KeyPairSigner;
  let owner: KeyPairSigner;
  let holder: KeyPairSigner;
  let solver: KeyPairSigner;
  let inputMint: Address;
  let outputMint: Address;
  let receiver: Address;
  let holderOutput: Address;
  let holderInput: Address;
  let feeTo: Address;
  let intents: Address[];
  let allowanceReads: Address[];

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
    async allowance(address, delegate) {
      allowanceReads.push(address);
      return allowanceOf(dataOf(address), delegate);
    },
  });

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

  let sends: number;

  const landed = async (wire: Base64EncodedWireTransaction) => {
    sends += 1;
    const result = svm.sendTransaction(getTransactionDecoder().decode(getBase64Encoder().encode(wire)));
    if (result instanceof FailedTransactionMetadata) {
      throw new Error(`${String(result.err())}\n${result.meta().logs().join("\n")}`);
    }
    return { signature: result.signature().toString(), confirmed: true };
  };

  const rate = () => [{ inputMint, outputMint, outputTokenProgram: TOKEN_PROGRAM_ADDRESS, out: 1n, in: 1n }];

  const floatPricer = (): Pricer =>
    inventoryPricer(rate(), async () => spendable(balance(holderOutput), allowanceOf(dataOf(holderOutput), solver.address)));

  const plenty = (): Pricer => inventoryPricer(rate(), async () => 10n * AMOUNT);

  function solve(pricer: Pricer, extra: Partial<Parameters<typeof tick>[0]> = {}) {
    return tick({
      chain: chain(),
      pricer,
      solver,
      inventoryOwner: holder.address,
      strategy: { minProfit: new Map([[outputMint, 1_000n]]), maxFeeBps: 100 },
      tip: null,
      unitPrice: async () => 0n,
      simulate: simulated,
      send: landed,
      ...extra,
    });
  }

  async function open(nonce: bigint) {
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
      }),
    ]);
    const [intent] = await findIntentPda({ owner: owner.address, nonce });
    intents.push(intent);
    return intent;
  }

  const float = (amount: bigint) => send(holder, [getApproveInstruction({ source: holderOutput, delegate: solver.address, owner: holder, amount })]);

  const allowance = (account: Address) => getTokenDecoder().decode(dataOf(account) ?? new Uint8Array()).delegatedAmount;

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
    holder = await funded();
    solver = await funded();
    inputMint = await mint(authority);
    outputMint = await mint(authority);
    await ata(authority, owner.address, inputMint, 10_000_000n);
    receiver = await ata(authority, owner.address, outputMint);
    holderOutput = await ata(authority, holder.address, outputMint, 10n * AMOUNT);
    holderInput = await ataOf(holder.address, inputMint);
    feeTo = await ata(authority, feeRecipient.address, inputMint);
    intents = [];
    allowanceReads = [];
    sends = 0;
    await send(owner, [await buildInitUser({ owner })]);
  });

  it("fills as the owner's delegate: the owner's tokens move, the owner's account is paid, and the solver holds nothing", async () => {
    const intent = await open(1n);
    await float(2n * AMOUNT);
    const fees = splitFees(AMOUNT, 5, 0, 0);
    const report = await solve(floatPricer());
    expect(report).toEqual({ filled: [{ intent, profit: fees.net - MIN_OUT, cost: expect.any(BigInt), signature: expect.any(String), rent: expect.any(BigInt) }], sent: [], skipped: [], failed: [] });
    expect([balance(receiver), balance(holderOutput), balance(holderInput), balance(feeTo)]).toEqual([MIN_OUT, 10n * AMOUNT - MIN_OUT, fees.net, fees.protocol]);
    expect(allowance(holderOutput)).toBe(2n * AMOUNT - MIN_OUT);
    expect([balance(await ataOf(solver.address, inputMint)), balance(await ataOf(solver.address, outputMint))]).toEqual([-1n, -1n]);
    expect(allowanceReads).toEqual([holderOutput]);
  });

  it("skips a fill above the remaining allowance without sending it, and says the allowance runs low", async () => {
    const intent = await open(1n);
    await float(MIN_OUT - 1n);
    const report = await solve(plenty());
    expect(report).toEqual({
      filled: [],
      sent: [],
      skipped: [{ intent, reason: `${ALLOWANCE_SPENT}: ${MIN_OUT - 1n} left, ${MIN_OUT} needed` }],
      failed: [],
      low: [{ account: holderOutput, left: MIN_OUT - 1n, needed: MIN_OUT, warning: `${ALLOWANCE_LOW}: ${MIN_OUT - 1n} left, ${MIN_OUT} needed` }],
    });
    expect(sends).toBe(0);
    expect([balance(receiver), balance(holderOutput), allowance(holderOutput)]).toEqual([0n, 10n * AMOUNT, MIN_OUT - 1n]);
  });

  it("spends one allowance across the fills of a tick and warns once what is left cannot cover another", async () => {
    const opened = [await open(1n), await open(2n)];
    await float(MIN_OUT + MIN_OUT / 2n);
    const report = await solve(plenty(), { send: async (wire) => ({ ...(await landed(wire)), confirmed: false }) });
    expect([report.filled, report.failed]).toEqual([[], []]);
    expect(report.sent).toHaveLength(1);
    expect(report.skipped.map((s) => s.reason)).toEqual([`${ALLOWANCE_SPENT}: ${MIN_OUT / 2n} left, ${MIN_OUT} needed`]);
    expect(new Set([...report.sent.map((s) => s.intent), ...report.skipped.map((s) => s.intent)])).toEqual(new Set(opened));
    expect(report.low).toEqual([{ account: holderOutput, left: MIN_OUT / 2n, needed: MIN_OUT, warning: `${ALLOWANCE_LOW}: ${MIN_OUT / 2n} left, ${MIN_OUT} needed` }]);
    expect(sends).toBe(1);
    await open(3n);
    await float(3n * MIN_OUT);
    const roomy = await solve(plenty());
    expect(roomy.filled).toHaveLength(2);
    expect("low" in roomy).toBe(false);
  });

  it("counts what unlanded fills still hold against the allowance", async () => {
    const intent = await open(1n);
    await float(2n * MIN_OUT);
    const report = await solve(plenty(), { held: (account) => (account === holderOutput ? MIN_OUT + 1n : 0n) });
    expect(report.skipped).toEqual([{ intent, reason: `${ALLOWANCE_SPENT}: ${MIN_OUT - 1n} left, ${MIN_OUT} needed` }]);
    expect(sends).toBe(0);
  });

  it("lets the delegate key alone move at most the allowance, and nothing from the owner's other accounts", async () => {
    await float(500n);
    const elsewhere = await ata(authority, solver.address, outputMint);
    const moving = (source: Address, amount: bigint) => send(solver, [getTransferInstruction({ source, destination: elsewhere, authority: solver, amount })]);
    await expect(moving(holderOutput, 501n)).rejects.toThrow();
    await moving(holderOutput, 300n);
    await expect(moving(holderOutput, 201n)).rejects.toThrow();
    await moving(holderOutput, 200n);
    await expect(moving(holderOutput, 1n)).rejects.toThrow();
    const other = await ata(authority, holder.address, inputMint, 1_000n);
    await expect(send(solver, [getTransferInstruction({ source: other, destination: await ata(authority, solver.address, inputMint), authority: solver, amount: 1n })])).rejects.toThrow();
    expect([balance(holderOutput), balance(elsewhere), balance(other), allowance(holderOutput)]).toEqual([10n * AMOUNT - 500n, 500n, 1_000n, 0n]);
  });

  it("fills only from inventory with an owner: a route or an arbitrage is skipped and nothing is sent", async () => {
    const intent = await open(1n);
    await float(2n * AMOUNT);
    const routed: Pricer = { quote: async (request) => ({ amountIn: request.amountIn, amountOut: MIN_OUT + 4_000n, instructions: [], lookupTables: [] }) };
    expect((await solve(routed)).skipped).toEqual([{ intent, reason: INVENTORY_ONLY }]);
    const cycle = async () => ({ amountIn: 1n, amountOut: 2n, instructions: [], lookupTables: [] });
    const cycling = await solve(plenty(), { strategy: { minProfit: new Map([[outputMint, 1_000n]]), maxFeeBps: 100, cycle } });
    expect(cycling.skipped).toEqual([{ intent, reason: INVENTORY_ONLY }]);
    expect(sends).toBe(0);
  });

  it("refuses an inventory owner that is the solver itself or a chain that cannot read allowances", async () => {
    await open(1n);
    await expect(solve(plenty(), { inventoryOwner: solver.address })).rejects.toThrow(OWNER_IS_SOLVER);
    const { allowance: _, ...blind } = chain();
    await expect(solve(plenty(), { chain: blind })).rejects.toThrow(NO_ALLOWANCE_READER);
    expect(sends).toBe(0);
  });

  it("without an inventory owner fills from the solver's own account and never reads an allowance", async () => {
    const intent = await open(1n);
    await float(2n * AMOUNT);
    const ownOutput = await ata(authority, solver.address, outputMint, AMOUNT);
    const ownInput = await ata(authority, solver.address, inputMint);
    const fees = splitFees(AMOUNT, 5, 0, 0);
    const report = await tick({
      chain: chain(),
      pricer: inventoryPricer(rate(), async () => balance(ownOutput)),
      solver,
      strategy: { minProfit: new Map([[outputMint, 1_000n]]), maxFeeBps: 100 },
      tip: null,
      unitPrice: async () => 0n,
      simulate: simulated,
      send: landed,
    });
    expect(report).toEqual({ filled: [{ intent, profit: fees.net - MIN_OUT, cost: expect.any(BigInt), signature: expect.any(String) }], sent: [], skipped: [], failed: [] });
    expect([balance(ownOutput), balance(ownInput), balance(holderOutput), allowance(holderOutput)]).toEqual([AMOUNT - MIN_OUT, fees.net, 10n * AMOUNT, 2n * AMOUNT]);
    expect(allowanceReads).toEqual([]);
  });
});

describe("the allowance a token account gives a delegate", () => {
  const account = (delegate: Address | null, delegated: bigint, length = TOKEN_ACCOUNT_BASE) => {
    const data = new Uint8Array(length);
    const view = new DataView(data.buffer);
    view.setBigUint64(64, 7n, true);
    if (delegate !== null) {
      view.setUint32(72, 1, true);
      data.set(getAddressEncoder().encode(delegate), 76);
    }
    view.setBigUint64(121, delegated, true);
    return data;
  };

  it("is the delegated amount only for the named delegate", async () => {
    const delegate = (await generateKeyPairSigner()).address;
    const other = (await generateKeyPairSigner()).address;
    expect(allowanceOf(account(delegate, 40n), delegate)).toBe(40n);
    expect(allowanceOf(account(delegate, 40n, TOKEN_ACCOUNT_BASE + 30), delegate)).toBe(40n);
    expect(allowanceOf(account(delegate, 40n), other)).toBe(0n);
    expect(allowanceOf(account(null, 40n), delegate)).toBe(0n);
    expect(allowanceOf(account(delegate, 40n).subarray(0, TOKEN_ACCOUNT_BASE - 1), delegate)).toBe(0n);
    expect(allowanceOf(null, delegate)).toBe(0n);
  });

  it("lets the delegate spend the lesser of the balance and the allowance", () => {
    expect([spendable(10n, 3n), spendable(3n, 10n), spendable(5n, 5n), spendable(0n, 9n)]).toEqual([3n, 3n, 5n, 0n]);
  });
});
