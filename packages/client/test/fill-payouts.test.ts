import { type Address, type KeyPairSigner } from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstructionAsync, getMintToInstruction } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, Kind, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import {
  buildApproveDelegate,
  buildCreateIntentByAgent,
  buildCreateIntentSigned,
  buildCreateMandate,
  buildFlashFill,
  decodeEvent,
  EVENT_IX_TAG,
  findMandatePda,
  getAgentPaidEventEncoder,
  buildInitUser,
  encodeParams,
  findIntentPda,
  MANDATE_KINDS,
  MANDATE_NONCE_BIT,
  MAX_CRANK_BOUNTY,
  MAX_CREATE_FEE,
  signedIntentMessage,
  signEd25519Instruction,
} from "@intent-engine/core/internal";
import { createClient, type EngineTransaction, type Transport } from "../src/index.js";
import { FEE_BPS, funded, NOW, world } from "./svm.js";

const LOCAL = "http://127.0.0.1:8899";
const DOMAIN = new Uint8Array(32).fill(0x11);
const ESCROW = 400n;
const MIN_OUT = 30n;
const AGENT_FEE = 20n;
const RELAYER_FEE = 15n;
const LANE = MANDATE_NONCE_BIT | (1n << 32n);
const SIGNED_NONCE = 4n;

async function setup() {
  const w = await world();
  const client = createClient({ url: LOCAL, transport: w.chain.transport });
  const solver = await funded(w.chain);
  const owner = await funded(w.chain);
  const ownerInput = await w.test.tokens(owner.address, w.inputMint, 1_000n);
  const receiver = await w.test.tokens(owner.address, w.outputMint, 0n);
  await w.chain.transport.send([await buildInitUser({ owner })], owner);
  const swap = { kind: Kind.SwapExactIn, amountIn: ESCROW, minOut: MIN_OUT } as const;
  const route = async () => [
    getMintToInstruction({
      mint: w.outputMint,
      token: await findAssociatedTokenAddress({ owner: solver.address, mint: w.outputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
      mintAuthority: w.authority,
      amount: MIN_OUT,
    }),
  ];
  const approve = async (amount: bigint) =>
    w.chain.transport.send([await buildApproveDelegate({ owner, mint: w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS, amount, decimals: 6 })], owner);
  const fill = async (nonce: bigint) => client.fill({ solver, intent: { owner: owner.address, nonce }, route: await route() });
  return { w, client, solver, owner, ownerInput, receiver, swap, route, approve, fill };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function byAgent(s: Setup, agent: KeyPairSigner): Promise<Address> {
  const { w, owner, swap } = s;
  await s.approve(ESCROW + AGENT_FEE);
  const terms = { inputMint: w.inputMint, outputMint: w.outputMint, inputTokenProgram: TOKEN_PROGRAM_ADDRESS, outputTokenProgram: TOKEN_PROGRAM_ADDRESS };
  await w.chain.transport.send(
    [
      await buildCreateMandate({
        owner,
        ...terms,
        mandate: {
          id: 0n,
          agent: agent.address,
          kinds: MANDATE_KINDS,
          perIntent: ESCROW + AGENT_FEE,
          total: ESCROW + AGENT_FEE,
          maxIntents: 1,
          maxTtl: 3_600n,
          validUntil: NOW + 86_400n,
          floorOut: 1n,
          floorIn: ESCROW,
          agentFee: AGENT_FEE,
        },
      }),
    ],
    owner,
  );
  await w.chain.transport.send(
    [
      await buildCreateIntentByAgent({
        agent,
        owner: owner.address,
        mandateId: 0n,
        treasury: w.feeRecipient.address,
        maxCreateFee: MAX_CREATE_FEE,
        maxBounty: MAX_CRANK_BOUNTY,
        nonce: LANE,
        params: swap,
        expiresAt: NOW + 3_600n,
        ...terms,
      }),
    ],
    agent,
  );
  return (await findIntentPda({ owner: owner.address, nonce: LANE }))[0];
}

async function relayed(s: Setup, relayer: KeyPairSigner): Promise<Address> {
  const { w, owner, ownerInput, receiver, swap } = s;
  await s.approve(ESCROW + RELAYER_FEE);
  const expiresAt = NOW + 3_600n;
  const submitBy = NOW + 600n;
  const terms = { inputMint: w.inputMint, outputMint: w.outputMint, nonce: SIGNED_NONCE, expiresAt, submitBy, relayerFee: RELAYER_FEE };
  const message = await signedIntentMessage({
    ...terms,
    domain: DOMAIN,
    owner: owner.address,
    ownerInput,
    receiver,
    kind: Kind.SwapExactIn,
    params: encodeParams(swap),
    epoch: 0n,
  });
  await w.chain.transport.send(
    [
      await signEd25519Instruction(owner, message),
      await buildCreateIntentSigned({
        ...terms,
        treasury: w.feeRecipient.address,
        maxCreateFee: MAX_CREATE_FEE,
        maxBounty: MAX_CRANK_BOUNTY,
        payer: relayer,
        owner: owner.address,
        params: swap,
        inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      }),
    ],
    relayer,
  );
  return (await findIntentPda({ owner: owner.address, nonce: SIGNED_NONCE }))[0];
}

describe("a fill receipt names every payout the program made for the intent", () => {
  it("shows the agent's fee on an intent an agent created under a mandate", async () => {
    const s = await setup();
    const agent = await funded(s.w.chain);
    const agentAccount = await s.w.test.tokens(agent.address, s.w.inputMint, 0n);
    const intent = await byAgent(s, agent);
    const signature = await s.fill(LANE);
    const fill = await s.client.fillOf(intent);
    expect(fill).toMatchObject({ steps: 1, signature, agentPaid: { agent: agent.address, account: agentAccount, fee: AGENT_FEE }, relayerPaid: null });
    expect(await s.w.test.tokenBalance(agent.address, s.w.inputMint)).toBe(AGENT_FEE);
  });

  it("shows the relayer's fee on an intent a relayer submitted for its owner", async () => {
    const s = await setup();
    const relayer = await funded(s.w.chain);
    const relayerAccount = await s.w.test.tokens(relayer.address, s.w.inputMint, 0n);
    const intent = await relayed(s, relayer);
    const signature = await s.fill(SIGNED_NONCE);
    const fill = await s.client.fillOf(intent);
    expect(fill).toMatchObject({ steps: 1, signature, agentPaid: null, relayerPaid: { relayer: relayer.address, account: relayerAccount, fee: RELAYER_FEE } });
    expect(await s.w.test.tokenBalance(relayer.address, s.w.inputMint)).toBe(RELAYER_FEE);
  });

  it("shows neither on an intent its owner created and no one relayed", async () => {
    const s = await setup();
    const created = await s.client.createIntent({ signer: s.owner, inputMint: s.w.inputMint, outputMint: s.w.outputMint, params: s.swap });
    await s.fill(created.nonce);
    expect(await s.client.fillOf(created.intent)).toMatchObject({ steps: 1, agentPaid: null, relayerPaid: null });
  });
});

describe("a fill receipt takes each payout from the transaction that made it", () => {
  it("shows the agent's fee on a two-step fill of an agent's intent", async () => {
    const s = await setup();
    const { w, solver, owner } = s;
    const agent = await funded(w.chain);
    const agentAccount = await w.test.tokens(agent.address, w.inputMint, 0n);
    const intent = await byAgent(s, agent);
    const [mandate] = await findMandatePda({ owner: owner.address, agent: agent.address, id: 0n });
    const ataOf = (holder: Address, mint: Address) => findAssociatedTokenAddress({ owner: holder, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const flash = await buildFlashFill({
      solver,
      owner: owner.address,
      nonce: LANE,
      inputMint: w.inputMint,
      outputMint: w.outputMint,
      inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      receiver: s.receiver,
      solverInput: await ataOf(solver.address, w.inputMint),
      solverOutput: await ataOf(solver.address, w.outputMint),
      feeRecipient: w.feeRecipient.address,
      mandate,
      agent: agent.address,
      amountIn: ESCROW,
      amountOut: MIN_OUT,
      maxFeeBps: FEE_BPS,
      prefix: await Promise.all(
        [
          [solver.address, w.inputMint],
          [solver.address, w.outputMint],
          [w.feeRecipient.address, w.inputMint],
        ].map(([holder, mint]) => getCreateAssociatedTokenIdempotentInstructionAsync({ payer: solver, owner: holder as Address, mint: mint as Address })),
      ),
      route: await s.route(),
    });
    const signature = await s.client.send(flash, solver);
    expect(await s.client.fillOf(intent)).toMatchObject({ steps: 2, signature, agentPaid: { agent: agent.address, account: agentAccount, fee: AGENT_FEE }, relayerPaid: null });
  });

  it("names no agent payout that its fill transaction did not make", async () => {
    const s = await setup();
    const { w } = s;
    const agent = await funded(w.chain);
    const agentAccount = await w.test.tokens(agent.address, w.inputMint, 0n);
    const intent = await byAgent(s, agent);
    await s.fill(LANE);
    const inner = w.chain.transport;
    const decoy = new Uint8Array([...EVENT_IX_TAG, ...getAgentPaidEventEncoder().encode({ intent, agent: agent.address, account: agentAccount, fee: 999n })]);
    const named = (tx: EngineTransaction, name: string) => tx.emitted.some((data) => decodeEvent(data)?.name === name);
    const moved = (tx: EngineTransaction): EngineTransaction => {
      if (named(tx, "IntentFilled")) {
        const kept = tx.emitted.map((data, i) => ({ data, accounts: tx.emittedAccounts?.[i] })).filter(({ data }) => decodeEvent(data)?.name !== "AgentPaid");
        return { ...tx, emitted: kept.map(({ data }) => data), ...(tx.emittedAccounts === undefined ? {} : { emittedAccounts: kept.map(({ accounts }) => accounts ?? []) }) };
      }
      if (named(tx, "IntentCreated")) {
        return { ...tx, emitted: [...tx.emitted, decoy], ...(tx.emittedAccounts === undefined ? {} : { emittedAccounts: [...tx.emittedAccounts, tx.emittedAccounts[0] ?? []] }) };
      }
      return tx;
    };
    const transactionsOf = inner.transactionsOf;
    const shifted: Transport = {
      ...inner,
      engineTransactions: async (...args) => (await inner.engineTransactions(...args)).map(moved),
      ...(transactionsOf === undefined ? {} : { transactionsOf: async (listed) => (await transactionsOf.call(inner, listed)).map(moved) }),
    };
    expect(await s.client.fillOf(intent)).toMatchObject({ agentPaid: { fee: AGENT_FEE } });
    expect(await createClient({ url: LOCAL, transport: shifted }).fillOf(intent)).toMatchObject({ steps: 1, agentPaid: null, relayerPaid: null });
  });
});
