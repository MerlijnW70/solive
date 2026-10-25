import { fileURLToPath } from "node:url";
import {
  type Address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
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
import { FailedTransactionMetadata, LiteSVM, type TransactionMetadata } from "litesvm";
import { beforeEach, describe, expect, it } from "vitest";
import { splitFees, findAssociatedTokenAddress, Kind } from "../src/index.js";
import {
  ALL_KINDS_MASK,
  attestedFillMessage,
  buildApproveDelegate,
  buildAdvanceEpoch,
  getIntentSize,
  buildUpdateEconomics,
  buildCreateIntentSigned,
  buildCreateIntentByAgent,
  buildCreateMandate,
  buildRevokeMandate,
  findMandatePda,
  MANDATE_KINDS,
  MANDATE_NONCE_BIT,
  buildFillAttested,
  signedIntentMessage,
  signEd25519Instruction,
  buildCloseIntent,
  buildCreateIntent,
  buildFillIntent,
  buildFlashFill,
  decodeEvent,
  buildInitUser,
  findEventAuthorityPda,
  findIntentPda,
  findVaultPda,
  getInitConfigInstructionAsync,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  encodeParams,
  splitFee,
  MAX_CRANK_BOUNTY,
  MAX_CREATE_FEE,
} from "../src/internal.js";

const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111" as Address;
const NOW = 1_700_000_000n;
const ESCROW = 400n;
const MIN_OUT = 300n;
const FEE_BPS = 5;
const INSUFFICIENT_OUTPUT = 6008;
const SIG_MESSAGE = 6035;
const MANDATE_BUDGET = 6069;
const MANDATE_MISMATCH = 6073;
const FIRST_LANE = MANDATE_NONCE_BIT | (1n << 32n);
const MANDATE_PRICE = 6071;
const MANDATE_REVOKED = 6072;
const FEE_ACCOUNT_MISSING = 6030;
const DOMAIN = new Uint8Array(32).fill(0x11);
const enginePath =
  process.env["INTENT_ENGINE_SO"] ??
  fileURLToPath(new URL("../../../target/deploy/intent_engine.so", import.meta.url));

let svm: LiteSVM;

async function attempt(
  payer: KeyPairSigner,
  ixs: Instruction[],
): Promise<TransactionMetadata | FailedTransactionMetadata> {
  svm.expireBlockhash();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  return svm.sendTransaction(await signTransactionMessageWithSigners(message));
}

function customCode(result: TransactionMetadata | FailedTransactionMetadata): number | undefined {
  if (!(result instanceof FailedTransactionMetadata)) {
    return undefined;
  }
  const failure = result.err();
  if (typeof failure !== "object" || !("err" in failure)) {
    return undefined;
  }
  const inner = failure.err();
  return typeof inner === "object" && "code" in inner ? inner.code : undefined;
}

async function send(payer: KeyPairSigner, ixs: Instruction[]): Promise<TransactionMetadata> {
  const result = await attempt(payer, ixs);
  if (result instanceof FailedTransactionMetadata) {
    throw new Error(`${String(result.err())}\n${result.meta().logs().join("\n")}`);
  }
  return result;
}

async function funded(): Promise<KeyPairSigner> {
  const kp = await generateKeyPairSigner();
  svm.airdrop(kp.address, lamports(100_000_000_000n));
  return kp;
}

async function makeUpgradeAuthority(authority: Address): Promise<Address> {
  const [programData] = await getProgramDerivedAddress({
    programAddress: LOADER,
    seeds: [getAddressEncoder().encode(INTENT_ENGINE_PROGRAM_ADDRESS)],
  });
  const account = svm.getAccount(programData);
  if (!account.exists) {
    throw new Error("program data missing");
  }
  const data = new Uint8Array(account.data);
  data[12] = 1;
  data.set(getAddressEncoder().encode(authority), 13);
  svm.setAccount({ ...account, data });
  return programData;
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
  const ix = await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner, mint: m });
  const address = await findAssociatedTokenAddress({
    owner,
    mint: m,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const extra =
    amount > 0n
      ? [getMintToInstruction({ mint: m, token: address, mintAuthority: payer, amount })]
      : [];
  await send(payer, [ix, ...extra]);
  return address;
}

function balance(address: Address): bigint {
  const account = svm.getAccount(address);
  return account.exists ? getTokenDecoder().decode(account.data).amount : -1n;
}

describe("end to end against the deployed engine, using only the package's builders", () => {
  let authority: KeyPairSigner;
  let feeRecipient: KeyPairSigner;

  beforeEach(async () => {
    svm = new LiteSVM().withPrecompiles();
    svm.addProgramFromFile(INTENT_ENGINE_PROGRAM_ADDRESS, enginePath);
    const clock = svm.getClock();
    clock.unixTimestamp = NOW;
    svm.setClock(clock);
    authority = await funded();
    feeRecipient = await funded();
    const [eventAuthority] = await findEventAuthorityPda();
    await send(authority, [
      await getInitConfigInstructionAsync({
        authority,
        engineProgram: INTENT_ENGINE_PROGRAM_ADDRESS,
        programData: await makeUpgradeAuthority(authority.address),
        eventAuthority,
        program: INTENT_ENGINE_PROGRAM_ADDRESS,
        domain: DOMAIN,
        guardian: authority.address,
        feeRecipient: feeRecipient.address,
        enabledKinds: ALL_KINDS_MASK,
        feeBps: FEE_BPS,
        paused: 0,
      }),
    ]);
  });

  it("creates, fills and closes a swap intent with exact balances and rent returned", async () => {
    const owner = await funded();
    const solver = await funded();
    const inputMint = await mint(authority);
    const outputMint = await mint(authority);
    const ownerInput = await ata(authority, owner.address, inputMint, 1_000n);
    const receiver = await ata(authority, owner.address, outputMint);
    const solverOutput = await ata(authority, solver.address, outputMint, 10_000n);
    const solverInput = await ata(authority, solver.address, inputMint);
    const feeTo = await ata(authority, feeRecipient.address, inputMint);
    const common = {
      inputMint,
      outputMint,
      inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
    };

    await send(owner, [await buildInitUser({ owner })]);
    await send(owner, [
      await buildCreateIntent({
        treasury: feeRecipient.address,
        maxCreateFee: MAX_CREATE_FEE,
        maxBounty: MAX_CRANK_BOUNTY,
        ...common,
        owner,
        nonce: 7n,
        params: { kind: Kind.SwapExactIn, amountIn: ESCROW, minOut: MIN_OUT },
        expiresAt: NOW + 3_600n,
      }),
    ]);
    expect(balance(ownerInput)).toBe(1_000n - ESCROW);

    const filled = await send(solver, [
      await buildFillIntent({
        ...common,
        solver,
        owner: owner.address,
        nonce: 7n,
        receiver,
        solverOutput,
        solverInput,
        feeRecipient: feeRecipient.address,
        amountIn: ESCROW,
        amountOut: MIN_OUT,
        maxFeeBps: 100,
      }),
    ]);
    const { fee, net } = splitFee(ESCROW, FEE_BPS);
    const emitted = filled
      .innerInstructions()
      .flat()
      .map((inner) => decodeEvent(inner.instruction().data()))
      .filter((event) => event !== null);
    const [filledIntent] = await findIntentPda({ owner: owner.address, nonce: 7n });
    expect(emitted).toEqual([
      {
        name: "IntentFilled",
        notable: false,
        fields: expect.objectContaining({
          intent: filledIntent,
          solver: solver.address,
          receiver,
          fee,
          net,
          amountIn: ESCROW,
          filled: ESCROW,
          remaining: 0n,
        }),
      },
    ]);
    expect(balance(receiver)).toBe(MIN_OUT);
    expect(balance(solverOutput)).toBe(10_000n - MIN_OUT);
    expect(balance(solverInput)).toBe(net);
    expect(balance(feeTo)).toBe(fee);

    const [intent] = await findIntentPda({ owner: owner.address, nonce: 7n });
    const before = svm.getBalance(owner.address) ?? 0n;
    const rent = (svm.getBalance(intent) ?? 0n) + svm.minimumBalanceForRentExemption(165n);
    await send(solver, [
      await buildCloseIntent({
        cranker: solver,
        owner: owner.address,
        nonce: 7n,
        inputMint,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      }),
    ]);
    expect(svm.getAccount(intent).exists).toBe(false);
    expect(svm.getBalance(owner.address)).toBe(before + rent);
  });

  it("charges the configured economics and pays a partner its share on fill", async () => {
    const owner = await funded();
    const solver = await funded();
    const partner = await funded();
    const inputMint = await mint(authority);
    const outputMint = await mint(authority);
    await ata(authority, owner.address, inputMint, 1_000_000n);
    const receiver = await ata(authority, owner.address, outputMint);
    const solverOutput = await ata(authority, solver.address, outputMint, 10_000n);
    const solverInput = await ata(authority, solver.address, inputMint);
    const feeTo = await ata(authority, feeRecipient.address, inputMint);
    const partnerTo = await ata(authority, partner.address, inputMint);
    const common = {
      inputMint,
      outputMint,
      inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
    };
    await send(authority, [
      await buildUpdateEconomics({
        admin: authority,
        economics: { kindFeeMask: 0b10, kindFeeBps: [7, 0, 0, 0], partnerCutBps: 2_000, crankBounty: 60_000, createFee: 15_000 },
      }),
    ]);
    const treasury = svm.getBalance(feeRecipient.address) ?? 0n;
    const amountIn = 100_000n;
    await send(owner, [await buildInitUser({ owner })]);
    await send(owner, [
      await buildCreateIntent({
        ...common,
        owner,
        treasury: feeRecipient.address,
        maxCreateFee: MAX_CREATE_FEE,
        maxBounty: MAX_CRANK_BOUNTY,
        nonce: 1n,
        params: { kind: Kind.SwapExactIn, amountIn, minOut: MIN_OUT },
        expiresAt: NOW + 3_600n,
        partner: { key: partner.address, bps: 50 },
      }),
    ]);
    expect(svm.getBalance(feeRecipient.address)).toBe(treasury + 15_000n);
    const [intent] = await findIntentPda({ owner: owner.address, nonce: 1n });
    const rent = svm.minimumBalanceForRentExemption(BigInt(getIntentSize()));
    expect(svm.getBalance(intent)).toBe(rent + 60_000n);
    const fees = splitFees(amountIn, 7, 50, 2_000);
    await send(solver, [
      await buildFillIntent({
        ...common,
        solver,
        owner: owner.address,
        nonce: 1n,
        receiver,
        solverOutput,
        solverInput,
        feeRecipient: feeRecipient.address,
        partner: partner.address,
        amountIn,
        amountOut: MIN_OUT,
        maxFeeBps: 57,
      }),
    ]);
    expect(fees).toEqual({ protocol: 170n, partner: 400n, net: 99_430n });
    expect(balance(feeTo)).toBe(fees.protocol);
    expect(balance(partnerTo)).toBe(fees.partner);
    expect(balance(solverInput)).toBe(fees.net);
    const before = svm.getBalance(solver.address) ?? 0n;
    await send(solver, [
      await buildCloseIntent({
        cranker: solver,
        owner: owner.address,
        nonce: 1n,
        inputMint,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      }),
    ]);
    expect(svm.getBalance(solver.address)).toBe(before + 60_000n - 5_000n);
  });

  it("rejects a fill below the minimum and leaves every balance untouched", async () => {
    const owner = await funded();
    const solver = await funded();
    const inputMint = await mint(authority);
    const outputMint = await mint(authority);
    await ata(authority, owner.address, inputMint, 1_000n);
    const receiver = await ata(authority, owner.address, outputMint);
    const solverOutput = await ata(authority, solver.address, outputMint, 10_000n);
    const solverInput = await ata(authority, solver.address, inputMint);
    await ata(authority, feeRecipient.address, inputMint);
    const common = {
      inputMint,
      outputMint,
      inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
    };
    await send(owner, [await buildInitUser({ owner })]);
    await send(owner, [
      await buildCreateIntent({
        treasury: feeRecipient.address,
        maxCreateFee: MAX_CREATE_FEE,
        maxBounty: MAX_CRANK_BOUNTY,
        ...common,
        owner,
        nonce: 0n,
        params: { kind: Kind.SwapExactIn, amountIn: ESCROW, minOut: MIN_OUT },
        expiresAt: NOW + 3_600n,
      }),
    ]);
    const fill = await buildFillIntent({
      ...common,
      solver,
      owner: owner.address,
      nonce: 0n,
      receiver,
      solverOutput,
      solverInput,
      feeRecipient: feeRecipient.address,
      amountIn: ESCROW,
      amountOut: MIN_OUT - 1n,
      maxFeeBps: 100,
    });
    expect(customCode(await attempt(solver, [fill]))).toBe(INSUFFICIENT_OUTPUT);
    expect(balance(receiver)).toBe(0n);
    expect(balance(solverOutput)).toBe(10_000n);
    expect(balance(solverInput)).toBe(0n);
  });

  it("lets a relayer submit an intent the owner only signed offline", async () => {
    const owner = await funded();
    const relayer = await funded();
    const inputMint = await mint(authority);
    const outputMint = await mint(authority);
    const ownerInput = await ata(authority, owner.address, inputMint, 1_000n);
    const receiver = await ata(authority, owner.address, outputMint);
    await send(owner, [
      await buildInitUser({ owner }),
      await buildApproveDelegate({
        owner,
        mint: inputMint,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        amount: ESCROW,
        decimals: 6,
      }),
    ]);
    const params = { kind: Kind.SwapExactIn, amountIn: ESCROW, minOut: MIN_OUT } as const;
    const expiresAt = NOW + 3_600n;
    const submitBy = NOW + 600n;
    const signed = (epoch: bigint) =>
      signedIntentMessage({
        domain: DOMAIN,
        owner: owner.address,
        ownerInput,
        submitBy,
        inputMint,
        outputMint,
        receiver,
        nonce: 3n,
        expiresAt,
        kind: Kind.SwapExactIn,
        params: encodeParams(params),
        epoch,
      });
    const create = await buildCreateIntentSigned({
      treasury: feeRecipient.address,
      maxCreateFee: MAX_CREATE_FEE,
      maxBounty: MAX_CRANK_BOUNTY,
      payer: relayer,
      owner: owner.address,
      submitBy,
      nonce: 3n,
      params,
      expiresAt,
      inputMint,
      outputMint,
      inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const stale = await signed(0n);
    await send(owner, [await buildAdvanceEpoch({ owner, epoch: 1n })]);
    expect(customCode(await attempt(relayer, [await signEd25519Instruction(owner, stale), create]))).toBe(
      SIG_MESSAGE,
    );
    const ownerBefore = svm.getBalance(owner.address);
    await send(relayer, [await signEd25519Instruction(owner, await signed(1n)), create]);
    expect(balance(ownerInput)).toBe(1_000n - ESCROW);
    expect(svm.getBalance(owner.address)).toBe(ownerBefore);
    const [intent] = await findIntentPda({ owner: owner.address, nonce: 3n });
    expect(svm.getAccount(intent).exists).toBe(true);
  });

  it("pays a relayer exactly the fee the owner signed for, in the input token", async () => {
    const owner = await funded();
    const relayer = await funded();
    const inputMint = await mint(authority);
    const outputMint = await mint(authority);
    const ownerInput = await ata(authority, owner.address, inputMint, 1_000n);
    const receiver = await ata(authority, owner.address, outputMint);
    const relayerAccount = await ata(authority, relayer.address, inputMint);
    const fee = 15n;
    await send(owner, [
      await buildInitUser({ owner }),
      await buildApproveDelegate({ owner, mint: inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS, amount: ESCROW + fee, decimals: 6 }),
    ]);
    const params = { kind: Kind.SwapExactIn, amountIn: ESCROW, minOut: MIN_OUT } as const;
    const expiresAt = NOW + 3_600n;
    const submitBy = NOW + 600n;
    const message = (relayerFee: bigint) =>
      signedIntentMessage({
        domain: DOMAIN,
        owner: owner.address,
        ownerInput,
        submitBy,
        inputMint,
        outputMint,
        receiver,
        nonce: 4n,
        expiresAt,
        kind: Kind.SwapExactIn,
        params: encodeParams(params),
        epoch: 0n,
        relayerFee,
      });
    const create = (relayerFee: bigint) =>
      buildCreateIntentSigned({
        treasury: feeRecipient.address,
        maxCreateFee: MAX_CREATE_FEE,
        maxBounty: MAX_CRANK_BOUNTY,
        payer: relayer,
        owner: owner.address,
        submitBy,
        nonce: 4n,
        params,
        expiresAt,
        inputMint,
        outputMint,
        inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        relayerFee,
      });
    const signature = await signEd25519Instruction(owner, await message(fee));
    expect(customCode(await attempt(relayer, [signature, await create(fee + 1n)]))).toBe(SIG_MESSAGE);
    const meta = await send(relayer, [signature, await create(fee)]);
    expect(balance(ownerInput)).toBe(1_000n - ESCROW - fee);
    expect(balance(relayerAccount)).toBe(fee);
    const [intent] = await findIntentPda({ owner: owner.address, nonce: 4n });
    const paid = meta
      .innerInstructions()
      .flat()
      .map((inner) => decodeEvent(inner.instruction().data()))
      .find((event) => event?.name === "RelayerPaid");
    expect(paid?.fields).toMatchObject({ intent, relayer: relayer.address, account: relayerAccount, fee });
  });

  it("holds an agent's fee with the escrow and pays it only when the intent fills", async () => {
    const owner = await funded();
    const agent = await funded();
    const solver = await funded();
    const inputMint = await mint(authority);
    const outputMint = await mint(authority);
    const ownerInput = await ata(authority, owner.address, inputMint, 1_000n);
    const receiver = await ata(authority, owner.address, outputMint);
    const agentAccount = await ata(authority, agent.address, inputMint);
    const solverOutput = await ata(authority, solver.address, outputMint, 10_000n);
    const solverInput = await ata(authority, solver.address, inputMint);
    await ata(authority, feeRecipient.address, inputMint);
    const fee = 20n;
    await send(owner, [
      await buildInitUser({ owner }),
      await buildApproveDelegate({ owner, mint: inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS, amount: 1_000n, decimals: 6 }),
      await buildCreateMandate({
        owner,
        inputMint,
        outputMint,
        inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        mandate: {
          id: 0n,
          agent: agent.address,
          kinds: MANDATE_KINDS,
          perIntent: ESCROW + fee,
          total: ESCROW + fee,
          maxIntents: 2,
          maxTtl: 3_600n,
          validUntil: NOW + 86_400n,
          floorOut: 1n,
          floorIn: 1_000n,
          agentFee: fee,
        },
      }),
    ]);
    const byAgent = (nonce: bigint) =>
      buildCreateIntentByAgent({
        agent,
        owner: owner.address,
        mandateId: 0n,
        treasury: feeRecipient.address,
        maxCreateFee: MAX_CREATE_FEE,
        maxBounty: MAX_CRANK_BOUNTY,
        nonce,
        params: { kind: Kind.SwapExactIn, amountIn: ESCROW, minOut: 1n },
        expiresAt: NOW + 3_600n,
        inputMint,
        outputMint,
        inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
    await send(agent, [await byAgent(FIRST_LANE)]);
    const [intent] = await findIntentPda({ owner: owner.address, nonce: FIRST_LANE });
    const [vault] = await findVaultPda({ intent });
    expect(balance(ownerInput)).toBe(1_000n - ESCROW - fee);
    expect(balance(vault)).toBe(ESCROW + fee);
    expect(balance(agentAccount)).toBe(0n);
    expect(customCode(await attempt(agent, [await byAgent(FIRST_LANE | 1n)]))).toBe(MANDATE_BUDGET);
    const [mandate] = await findMandatePda({ owner: owner.address, agent: agent.address, id: 0n });
    const fill = (paid: boolean) =>
      buildFillIntent({
        solver,
        owner: owner.address,
        nonce: FIRST_LANE,
        inputMint,
        outputMint,
        inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        receiver,
        solverOutput,
        solverInput,
        feeRecipient: feeRecipient.address,
        mandate,
        ...(paid ? { agent: agent.address } : {}),
        amountIn: ESCROW,
        amountOut: 1n,
        maxFeeBps: 100,
      });
    expect(customCode(await attempt(solver, [await fill(false)]))).toBe(FEE_ACCOUNT_MISSING);
    const filled = await send(solver, [await fill(true)]);
    expect(balance(agentAccount)).toBe(fee);
    expect(balance(vault)).toBe(0n);
    const paid = filled
      .innerInstructions()
      .flat()
      .map((inner) => decodeEvent(inner.instruction().data()))
      .find((event) => event?.name === "AgentPaid");
    expect(paid?.fields).toMatchObject({ intent, agent: agent.address, account: agentAccount, fee });
  });

  it("lets an agent create intents only within the mandate its owner granted", async () => {
    const owner = await funded();
    const agent = await funded();
    const solver = await funded();
    const inputMint = await mint(authority);
    const outputMint = await mint(authority);
    const ownerInput = await ata(authority, owner.address, inputMint, 1_000n);
    const receiver = await ata(authority, owner.address, outputMint);
    const solverOutput = await ata(authority, solver.address, outputMint, 10_000n);
    const solverInput = await ata(authority, solver.address, inputMint);
    await ata(authority, feeRecipient.address, inputMint);
    const mandate = {
      id: 1n,
      agent: agent.address,
      kinds: MANDATE_KINDS,
      perIntent: ESCROW,
      total: 2n * ESCROW,
      maxIntents: 2,
      maxTtl: 3_600n,
      validUntil: NOW + 86_400n,
      floorOut: 3n,
      floorIn: 4n,
    };
    await send(owner, [
      await buildInitUser({ owner }),
      await buildApproveDelegate({ owner, mint: inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS, amount: 1_000n, decimals: 6 }),
      await buildCreateMandate({
        owner,
        inputMint,
        outputMint,
        inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        mandate,
      }),
    ]);
    const byAgent = (nonce: bigint, minOut: bigint) =>
      buildCreateIntentByAgent({
        agent,
        owner: owner.address,
        mandateId: 1n,
        treasury: feeRecipient.address,
        maxCreateFee: MAX_CREATE_FEE,
        maxBounty: MAX_CRANK_BOUNTY,
        nonce,
        params: { kind: Kind.SwapExactIn, amountIn: ESCROW, minOut },
        expiresAt: NOW + 3_600n,
        inputMint,
        outputMint,
        inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
    expect(customCode(await attempt(agent, [await byAgent(MANDATE_NONCE_BIT, 300n)]))).toBe(MANDATE_MISMATCH);
    expect(customCode(await attempt(agent, [await byAgent(FIRST_LANE + (1n << 32n), 300n)]))).toBe(MANDATE_MISMATCH);
    expect(customCode(await attempt(agent, [await byAgent(FIRST_LANE, 299n)]))).toBe(MANDATE_PRICE);
    const ownerBefore = svm.getBalance(owner.address);
    await send(agent, [await byAgent(FIRST_LANE, 300n)]);
    expect(balance(ownerInput)).toBe(1_000n - ESCROW);
    expect(svm.getBalance(owner.address)).toBe(ownerBefore);
    await send(agent, [await byAgent(FIRST_LANE | 1n, 300n)]);
    expect(customCode(await attempt(agent, [await byAgent(FIRST_LANE | 2n, 300n)]))).toBe(MANDATE_BUDGET);
    const [address] = await findMandatePda({ owner: owner.address, agent: agent.address, id: 1n });
    const fill = (nonce: bigint, named: boolean) =>
      buildFillIntent({
        solver,
        owner: owner.address,
        nonce,
        inputMint,
        outputMint,
        inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        receiver,
        solverOutput,
        solverInput,
        feeRecipient: feeRecipient.address,
        ...(named ? { mandate: address } : {}),
        amountIn: ESCROW,
        amountOut: 300n,
        maxFeeBps: 100,
      });
    expect(customCode(await attempt(solver, [await fill(FIRST_LANE, false)]))).toBe(MANDATE_REVOKED);
    await send(solver, [await fill(FIRST_LANE, true)]);
    expect(balance(receiver)).toBe(300n);
    await send(owner, [await buildRevokeMandate({ owner, agent: agent.address, id: 1n })]);
    expect(svm.getAccount(address).exists).toBe(false);
    expect(customCode(await attempt(solver, [await fill(FIRST_LANE | 1n, true)]))).toBe(MANDATE_REVOKED);
  });

  it("releases an attested intent's escrow to the payee the attestor named", async () => {
    const owner = await funded();
    const solver = await funded();
    const attestor = await generateKeyPairSigner();
    const inputMint = await mint(authority);
    const outputMint = await mint(authority);
    await ata(authority, owner.address, inputMint, 1_000n);
    await ata(authority, owner.address, outputMint);
    const payee = await ata(authority, solver.address, inputMint);
    const feeTo = await ata(authority, feeRecipient.address, inputMint);
    await send(owner, [await buildInitUser({ owner })]);
    await send(owner, [
      await buildCreateIntent({
        treasury: feeRecipient.address,
        maxCreateFee: MAX_CREATE_FEE,
        maxBounty: MAX_CRANK_BOUNTY,
        owner,
        nonce: 0n,
        params: {
          kind: Kind.AttestedResult,
          amountIn: ESCROW,
          minResult: 10n,
          maxResult: 20n,
          attestor: attestor.address,
          specHash: new Uint8Array(32),
          judgeFee: 0n,
        },
        expiresAt: NOW + 3_600n,
        inputMint,
        outputMint,
        inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      }),
    ]);
    const [intent] = await findIntentPda({ owner: owner.address, nonce: 0n });
    const fill = await buildFillAttested({
      solver,
      owner: owner.address,
      nonce: 0n,
      inputMint,
      inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      payee,
      feeRecipient: feeRecipient.address,
      amountIn: ESCROW,
      result: 15n,
      maxFeeBps: FEE_BPS,
    });
    await send(solver, [
      await signEd25519Instruction(
        attestor,
        await attestedFillMessage(attestor.address, {
          domain: DOMAIN,
          intent,
          payee,
          amountIn: ESCROW,
          result: 15n,
          maxFeeBps: FEE_BPS,
        }),
      ),
      fill,
    ]);
    const { fee, net } = splitFee(ESCROW, FEE_BPS);
    expect(balance(payee)).toBe(net);
    expect(balance(feeTo)).toBe(fee);
  });

  it("flash fills an intent with routing between begin and end", async () => {
    const owner = await funded();
    const solver = await funded();
    const inputMint = await mint(authority);
    const outputMint = await mint(authority);
    await ata(authority, owner.address, inputMint, 1_000n);
    const receiver = await ata(authority, owner.address, outputMint);
    const solverInput = await ata(authority, solver.address, inputMint);
    const solverOutput = await ata(authority, solver.address, outputMint);
    const stash = await generateKeyPairSigner();
    const stashAccount = await ata(authority, stash.address, outputMint, MIN_OUT);
    const feeTo = await ata(authority, feeRecipient.address, inputMint);
    const common = {
      inputMint,
      outputMint,
      inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
    };
    await send(owner, [await buildInitUser({ owner })]);
    await send(owner, [
      await buildCreateIntent({
        treasury: feeRecipient.address,
        maxCreateFee: MAX_CREATE_FEE,
        maxBounty: MAX_CRANK_BOUNTY,
        ...common,
        owner,
        nonce: 0n,
        params: { kind: Kind.SwapExactIn, amountIn: ESCROW, minOut: MIN_OUT },
        expiresAt: NOW + 3_600n,
      }),
    ]);
    const route = getTransferCheckedInstruction({
      source: stashAccount,
      mint: outputMint,
      destination: solverOutput,
      authority: stash,
      amount: MIN_OUT,
      decimals: 6,
    });
    const ixs = await buildFlashFill({
      ...common,
      solver,
      owner: owner.address,
      nonce: 0n,
      receiver,
      solverOutput,
      solverInput,
      feeRecipient: feeRecipient.address,
      amountIn: ESCROW,
      amountOut: MIN_OUT,
      maxFeeBps: 100,
      route: [route],
    });
    await send(solver, ixs);
    const { fee, net } = splitFee(ESCROW, FEE_BPS);
    expect(balance(receiver)).toBe(MIN_OUT);
    expect(balance(solverInput)).toBe(net);
    expect(balance(feeTo)).toBe(fee);
    expect(balance(solverOutput)).toBe(0n);
  });
});