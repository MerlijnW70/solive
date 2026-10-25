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
import { findAssociatedTokenAddress, type Intent, IntentStatus, Kind } from "@intent-engine/core";
import {
  ALL_KINDS_MASK,
  buildCreateIntent,
  buildInitUser,
  findConfigPda,
  findEventAuthorityPda,
  findIntentPda,
  getConfigDecoder,
  getInitConfigInstructionAsync,
  getIntentDecoder,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  MAX_CRANK_BOUNTY,
  MAX_CREATE_FEE,
  splitFee,
} from "@intent-engine/core/internal";
import { type Chain, inventoryPricer, type Pricer, type Report, type Simulated, tick } from "../src/index.js";

const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111" as Address;
const NOW = 1_700_000_000n;
const FEE_BPS = 5;
const AMOUNT = 100_000n;
const MIN_OUT = 90_000n;
const PROFIT = 1_000n;
const OWNERS = 4;
const PER_OWNER = 50;
const CONTESTED = 60;
const enginePath =
  process.env["INTENT_ENGINE_SO"] ?? fileURLToPath(new URL("../../../target/deploy/intent_engine.so", import.meta.url));

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
  return account.exists ? getTokenDecoder().decode(account.data).amount : 0n;
}

describe("the solver under load", () => {
  let authority: KeyPairSigner;
  let feeRecipient: KeyPairSigner;
  let inputMint: Address;
  let outputMint: Address;
  let feeTo: Address;
  let owners: { key: KeyPairSigner; receiver: Address }[];
  let intents: Address[];

  type Solver = { key: KeyPairSigner; input: Address; output: Address; stash: KeyPairSigner; stashAccount: Address };

  async function solverWithStash(): Promise<Solver> {
    const key = await funded();
    const stash = await funded();
    return {
      key,
      stash,
      input: await ata(authority, key.address, inputMint),
      output: await ata(authority, key.address, outputMint),
      stashAccount: await ata(authority, stash.address, outputMint, 1_000_000_000n),
    };
  }

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
    now: async () => svm.getClock().unixTimestamp,
    tokenProgram: async () => TOKEN_PROGRAM_ADDRESS,
    exists: async (address) => svm.getAccount(address).exists,
    lookupTables: async () => ({}),
    blockhash: async () => ({ blockhash: svm.latestBlockhash() as Blockhash, lastValidBlockHeight: 0n }),
    tokenAmount: async (address) => balance(address),
  });

  const stashPricer = (solver: Solver): Pricer => ({
    async quote(request) {
      const amountOut = MIN_OUT + PROFIT;
      return {
        amountIn: request.amountIn,
        amountOut,
        lookupTables: [],
        instructions: [
          getTransferCheckedInstruction({
            source: solver.stashAccount,
            mint: outputMint,
            destination: solver.output,
            authority: solver.stash,
            amount: amountOut,
            decimals: 6,
          }),
        ],
      };
    },
  });

  const simulate = async (wire: Base64EncodedWireTransaction, watch: readonly Address[] = []): Promise<Simulated> => {
    const result = svm.simulateTransaction(getTransactionDecoder().decode(getBase64Encoder().encode(wire)));
    if (result instanceof FailedTransactionMetadata) {
      return { err: String(result.err()), unitsConsumed: null, balances: [] };
    }
    const post = new Map(result.postAccounts().map((a) => [a.address, a]));
    return {
      err: null,
      unitsConsumed: result.meta().computeUnitsConsumed(),
      balances: watch.map((address) => {
        const after = post.get(address);
        return after === undefined ? balance(address) : getTokenDecoder().decode(after.data).amount;
      }),
    };
  };

  const land = async (wire: Base64EncodedWireTransaction) => {
    const result = svm.sendTransaction(getTransactionDecoder().decode(getBase64Encoder().encode(wire)));
    if (result instanceof FailedTransactionMetadata) {
      throw new Error(`${String(result.err())}\n${result.meta().logs().join("\n")}`);
    }
    return { signature: result.signature().toString(), confirmed: true };
  };

  const solve = (solver: Solver, hooks: { simulate?: typeof simulate } = {}): Promise<Report> =>
    tick({
      chain: chain(),
      pricer: stashPricer(solver),
      solver: solver.key,
      strategy: { minProfit: new Map([[outputMint, 1n]]), maxFeeBps: 100 },
      tip: null,
      unitPrice: async () => 0n,
      simulate: hooks.simulate ?? simulate,
      send: land,
    });

  async function openMany(perOwner: number) {
    for (const owner of owners) {
      for (let nonce = 0n; nonce < BigInt(perOwner); nonce++) {
        await send(owner.key, [
          await buildCreateIntent({
            owner: owner.key,
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
        intents.push((await findIntentPda({ owner: owner.key.address, nonce }))[0]);
      }
    }
  }

  const statusOf = (address: Address) => {
    const account = svm.getAccount(address);
    return account.exists ? getIntentDecoder().decode(account.data).status : null;
  };

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
        feeBps: FEE_BPS,
        paused: 0,
      }),
    ]);
    inputMint = await mint(authority);
    outputMint = await mint(authority);
    feeTo = await ata(authority, feeRecipient.address, inputMint);
    owners = [];
    for (let i = 0; i < OWNERS; i++) {
      const key = await funded();
      await ata(authority, key.address, inputMint, AMOUNT * BigInt(PER_OWNER));
      owners.push({ key, receiver: await ata(authority, key.address, outputMint) });
      await send(key, [await buildInitUser({ owner: key })]);
    }
    intents = [];
  });

  it(`fills ${OWNERS * PER_OWNER} open intents in one round, paying every owner exactly once and the protocol exactly its fee`, async () => {
    await openMany(PER_OWNER);
    const solver = await solverWithStash();
    const started = performance.now();
    const report = await solve(solver);
    const perFill = (performance.now() - started) / intents.length;
    console.log(`load: ${intents.length} fills in one round, ${perFill.toFixed(1)} ms per fill`);
    expect([report.filled.length, report.sent.length, report.skipped, report.failed]).toEqual([intents.length, 0, [], []]);
    expect(new Set(report.filled.map((f) => f.intent))).toEqual(new Set(intents));
    expect(intents.map(statusOf).every((s) => s === IntentStatus.Filled)).toBe(true);
    for (const owner of owners) {
      expect(balance(owner.receiver)).toBe(MIN_OUT * BigInt(PER_OWNER));
    }
    const { fee, net } = splitFee(AMOUNT, FEE_BPS);
    expect(balance(feeTo)).toBe(fee * BigInt(intents.length));
    expect([balance(solver.input), balance(solver.output)]).toEqual([net * BigInt(intents.length), PROFIT * BigInt(intents.length)]);
    expect(perFill).toBeLessThan(250);
  }, 300_000);

  it("fills a real intent from the solver's own tokens and pays the receiver at least what the intent requires", async () => {
    await openMany(1);
    const solver = await solverWithStash();
    await send(authority, [
      getMintToInstruction({ mint: outputMint, token: solver.output, mintAuthority: authority, amount: AMOUNT * BigInt(OWNERS) }),
    ]);
    const report = await tick({
      chain: chain(),
      pricer: inventoryPricer(
        [{ inputMint, outputMint, outputTokenProgram: TOKEN_PROGRAM_ADDRESS, out: 1n, in: 1n }],
        async () => balance(solver.output),
      ),
      solver: solver.key,
      strategy: { minProfit: new Map([[outputMint, 1n]]), maxFeeBps: 100 },
      tip: null,
      unitPrice: async () => 0n,
      simulate,
      send: land,
    });
    expect([report.filled.length, report.sent, report.skipped, report.failed]).toEqual([OWNERS, [], [], []]);
    expect(intents.map(statusOf).every((s) => s === IntentStatus.Filled)).toBe(true);
    for (const owner of owners) {
      expect(balance(owner.receiver)).toBeGreaterThanOrEqual(MIN_OUT);
    }
    const { net } = splitFee(AMOUNT, FEE_BPS);
    expect([balance(solver.input), balance(solver.output), balance(solver.stashAccount)]).toEqual([
      net * BigInt(OWNERS),
      (AMOUNT - MIN_OUT) * BigInt(OWNERS),
      1_000_000_000n,
    ]);
  });

  it(`lets two solvers race for the same ${CONTESTED} intents: each fills once, owners are paid once, and the loser keeps every token`, async () => {
    await openMany(CONTESTED / OWNERS);
    const [a, b] = [await solverWithStash(), await solverWithStash()];
    const held = (s: Solver) => [balance(s.input), balance(s.output), balance(s.stashAccount)];
    const before = { a: held(a), b: held(b) };
    let waiting: (() => void) | undefined;
    let arrived = 0;
    const together = async () => {
      arrived++;
      if (arrived % 2 === 1) {
        await new Promise<void>((resolve) => (waiting = resolve));
      } else {
        waiting?.();
      }
    };
    const paired = async (wire: Base64EncodedWireTransaction, watch: readonly Address[] = []) => {
      const result = await simulate(wire, watch);
      await together();
      return result;
    };
    const [ra, rb] = await Promise.all([solve(a, { simulate: paired }), solve(b, { simulate: paired })]);
    const wins = [...ra.filled, ...rb.filled].map((f) => f.intent);
    expect(wins.toSorted()).toEqual([...intents].toSorted());
    expect(new Set(wins).size).toBe(intents.length);
    expect(intents.map(statusOf).every((s) => s === IntentStatus.Filled)).toBe(true);
    for (const owner of owners) {
      expect(balance(owner.receiver)).toBe(MIN_OUT * BigInt(CONTESTED / OWNERS));
    }
    const lost = [...ra.failed, ...rb.failed];
    console.log(`race: solver a filled ${ra.filled.length}, solver b filled ${rb.filled.length}, ${lost.length} lost attempts`);
    expect(lost.length).toBeGreaterThan(0);
    expect([...ra.sent, ...rb.sent]).toEqual([]);
    const { net } = splitFee(AMOUNT, FEE_BPS);
    for (const [solver, report, start] of [
      [a, ra, before.a],
      [b, rb, before.b],
    ] as const) {
      const fills = BigInt(report.filled.length);
      expect(held(solver)).toEqual([
        (start[0] ?? 0n) + net * fills,
        (start[1] ?? 0n) + PROFIT * fills,
        (start[2] ?? 0n) - (MIN_OUT + PROFIT) * fills,
      ]);
    }
  }, 300_000);
});
