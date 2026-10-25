import { fileURLToPath } from "node:url";
import {
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
import { findAssociatedTokenAddress, type Intent, Kind } from "@intent-engine/core";
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
} from "@intent-engine/core/internal";
import {
  type Chain,
  COMPUTE_BUDGET_ADDRESS,
  decodeLookupTable,
  type Pricer,
  type Simulated,
  tick,
} from "../src/index.js";

export const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111" as Address;
export const LOOKUP_PROGRAM = "AddressLookupTab1e1111111111111111111111111" as Address;
export const NOW = 1_700_000_000n;
export const DIFFERENTIAL_RUNS = Math.min(Number(process.env["SOLVER_FUZZ_RUNS"] ?? 100), 150);
export const AMOUNT = 100_000n;
export const MIN_OUT = 90_000n;
export const enginePath =
  process.env["INTENT_ENGINE_SO"] ??
  fileURLToPath(new URL("../../../target/deploy/intent_engine.so", import.meta.url));

export function svmTools(at: () => LiteSVM) {
  async function send(payer: KeyPairSigner, ixs: Instruction[]) {
    const svm = at();
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
    at().airdrop(kp.address, lamports(100_000_000_000n));
    return kp;
  }

  async function mint(payer: KeyPairSigner): Promise<Address> {
    const m = await generateKeyPairSigner();
    const space = BigInt(getMintSize());
    await send(payer, [
      getCreateAccountInstruction({
        payer,
        newAccount: m,
        lamports: at().minimumBalanceForRentExemption(space),
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
    const account = at().getAccount(address);
    return account.exists ? getTokenDecoder().decode(account.data).amount : -1n;
  }

  return { send, funded, mint, ata, balance };
}

export const swapping: { current: { mint: Address; from: Address; to: Address; authority: KeyPairSigner } | null } = { current: null };

export function stashMarket(
  stash: KeyPairSigner,
  stashAccount: Address,
  outputMint: Address,
  solverOutput: Address,
  pay: (amountIn: bigint) => bigint | null,
  tables: Address[] = [],
  decimals = 6,
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
            decimals,
          }),
        ],
      };
    },
  };
}

export type Engine = {
  svm: LiteSVM;
  authority: KeyPairSigner;
  feeRecipient: KeyPairSigner;
  owner: KeyPairSigner;
  solver: KeyPairSigner;
  stash: KeyPairSigner;
  inputMint: Address;
  outputMint: Address;
  receiver: Address;
  solverInput: Address;
  solverOutput: Address;
  stashAccount: Address;
  feeTo: Address;
  intents: Address[];
};

export async function deployEngine(): Promise<Engine> {
  const svm = new LiteSVM().withPrecompiles();
  const { send, funded, mint, ata } = svmTools(() => svm);
  svm.addProgramFromFile(INTENT_ENGINE_PROGRAM_ADDRESS, enginePath);
  const clock = svm.getClock();
  clock.unixTimestamp = NOW;
  svm.setClock(clock);
  const authority = await funded();
  const feeRecipient = await funded();
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
  const owner = await funded();
  const solver = await funded();
  const stash = await funded();
  const inputMint = await mint(authority);
  const outputMint = await mint(authority);
  await ata(authority, owner.address, inputMint, 10_000_000n);
  const receiver = await ata(authority, owner.address, outputMint);
  const solverInput = await ata(authority, solver.address, inputMint);
  const solverOutput = await ata(authority, solver.address, outputMint);
  const stashAccount = await ata(authority, stash.address, outputMint, 10_000_000n);
  swapping.current = { mint: inputMint, from: solverInput, to: await ata(authority, stash.address, inputMint), authority: solver };
  const feeTo = await ata(authority, feeRecipient.address, inputMint);
  const intents: Address[] = [];
  await send(owner, [await buildInitUser({ owner })]);
  return { svm, authority, feeRecipient, owner, solver, stash, inputMint, outputMint, receiver, solverInput, solverOutput, stashAccount, feeTo, intents };
}

type Extra = Partial<Parameters<typeof tick>[0]>;

export type EngineTools = ReturnType<typeof svmTools> & {
  chain: () => Chain;
  submit: (wire: Base64EncodedWireTransaction) => Promise<string>;
  open: (nonce: bigint, partner?: Address) => Promise<Address>;
  simulated: (wire: Base64EncodedWireTransaction, watch?: readonly Address[]) => Promise<Simulated>;
  landed: (wire: Base64EncodedWireTransaction) => Promise<{ signature: string; confirmed: boolean }>;
  floors: (raw: bigint) => Map<Address, bigint>;
  solve: (pricer: Pricer, extra?: Extra) => ReturnType<typeof tick>;
  budgetOf: (wire: Base64EncodedWireTransaction, op: number) => number | bigint | null;
  accountsIn: (wire: Base64EncodedWireTransaction) => Address[];
  tipOf: (wire: Base64EncodedWireTransaction) => Address | null;
  bundled: (
    count: number,
    extra?: Extra,
    first?: number,
  ) => Promise<{ opened: Address[]; tipAccount: Address; bundles: Base64EncodedWireTransaction[][]; report: Awaited<ReturnType<typeof tick>>; tipped: bigint }>;
};

export function engineTools(at: () => Engine): EngineTools {
  const tools = svmTools(() => at().svm);
  const { send, balance } = tools;

  const chain = (): Chain => ({
    async config() {
      const [address] = await findConfigPda();
      const account = at().svm.getAccount(address);
      if (!account.exists) {
        throw new Error("config missing");
      }
      return getConfigDecoder().decode(account.data);
    },
    async intents() {
      const out: { address: Address; intent: Intent }[] = [];
      for (const address of at().intents) {
        const account = at().svm.getAccount(address);
        if (account.exists) {
          out.push({ address, intent: getIntentDecoder().decode(account.data) });
        }
      }
      return out;
    },
    async now() {
      return at().svm.getClock().unixTimestamp;
    },
    async tokenProgram() {
      return TOKEN_PROGRAM_ADDRESS;
    },
    async exists(address) {
      return at().svm.getAccount(address).exists;
    },
    async lookupTables(addresses) {
      const out: Record<Address, Address[]> = {};
      for (const address of addresses) {
        const account = at().svm.getAccount(address);
        if (!account.exists) {
          throw new Error(`lookup table ${address} missing`);
        }
        out[address] = decodeLookupTable(new Uint8Array(account.data));
      }
      return out;
    },
    async blockhash() {
      return { blockhash: at().svm.latestBlockhash() as Blockhash, lastValidBlockHeight: 0n };
    },
    async tokenAmount(address) {
      const held = balance(address);
      return held < 0n ? 0n : held;
    },
  });

  const submit = async (wire: Base64EncodedWireTransaction) => {
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
    const result = at().svm.sendTransaction(tx);
    if (result instanceof FailedTransactionMetadata) {
      throw new Error(`${String(result.err())}\n${result.meta().logs().join("\n")}`);
    }
    return result.signature().toString();
  };

  async function open(nonce: bigint, partner?: Address) {
    await send(at().owner, [
      await buildCreateIntent({
        owner: at().owner,
        treasury: at().feeRecipient.address,
        maxCreateFee: MAX_CREATE_FEE,
        maxBounty: MAX_CRANK_BOUNTY,
        nonce,
        params: { kind: Kind.SwapExactIn, amountIn: AMOUNT, minOut: MIN_OUT },
        expiresAt: NOW + 3_600n,
        inputMint: at().inputMint,
        outputMint: at().outputMint,
        inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        ...(partner === undefined ? {} : { partner: { key: partner, bps: 50 } }),
      }),
    ]);
    const [intent] = await findIntentPda({ owner: at().owner.address, nonce });
    at().intents.push(intent);
    return intent;
  }

  const simulated = async (wire: Base64EncodedWireTransaction, watch: readonly Address[] = []): Promise<Simulated> => {
    const result = at().svm.simulateTransaction(getTransactionDecoder().decode(getBase64Encoder().encode(wire)));
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

  const floors = (raw: bigint) => new Map([[at().outputMint, raw]]);

  function solve(pricer: Pricer, extra: Partial<Parameters<typeof tick>[0]> = {}) {
    return tick({
      chain: chain(),
      pricer,
      solver: at().solver,
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

  const accountsIn = (wire: Base64EncodedWireTransaction): Address[] =>
    getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(getBase64Encoder().encode(wire)).messageBytes).staticAccounts;

  function tipOf(wire: Base64EncodedWireTransaction): Address | null {
    const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(getBase64Encoder().encode(wire)).messageBytes);
    const last = ("instructions" in message ? message.instructions : []).at(-1);
    if (message.staticAccounts[last?.programAddressIndex ?? -1] !== SYSTEM_PROGRAM_ADDRESS) {
      return null;
    }
    return message.staticAccounts[last?.accountIndices?.[1] ?? -1] ?? null;
  }

  async function bundled(count: number, extra: Partial<Parameters<typeof tick>[0]> = {}, first = 1) {
    const opened: Address[] = [];
    for (let i = 0; i < count; i += 1) {
      opened.push(await open(BigInt(first + i)));
    }
    const tipAccount = (await generateKeyPairSigner()).address;
    at().svm.airdrop(tipAccount, lamports(1_000_000_000n));
    const before = at().svm.getBalance(tipAccount) ?? 0n;
    const bundles: Base64EncodedWireTransaction[][] = [];
    const report = await solve(stashMarket(at().stash, at().stashAccount, at().outputMint, at().solverOutput, () => MIN_OUT + 4_000n), {
      tip: { account: tipAccount, lamports: 12_345n },
      send: async () => {
        throw new Error("a bundling solver sent a single transaction");
      },
      sendBundle: async (wires) => {
        bundles.push([...wires]);
        for (const wire of wires) {
          await submit(wire);
        }
        return `bundle-${bundles.length}`;
      },
      ...extra,
    });
    return { opened, tipAccount, bundles, report, tipped: (at().svm.getBalance(tipAccount) ?? 0n) - before };
  }

  return { ...tools, chain, submit, open, simulated, landed, floors, solve, budgetOf, accountsIn, tipOf, bundled };
}
