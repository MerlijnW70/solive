import { type Address, type KeyPairSigner } from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstructionAsync, getMintToInstruction } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, Kind, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import {
  buildAdvanceEpoch,
  buildApproveDelegate,
  buildCreateIntentByAgent,
  buildCreateIntentSigned,
  buildCreateMandate,
  buildFlashFill,
  decodeEvent,
  EVENT_IX_TAG,
  findConfigPda,
  findMandatePda,
  getConfigDecoder,
  getConfigEncoder,
  kindBit,
  PAUSE_FILL,
  getAgentPaidEventEncoder,
  buildInitUser,
  buildRevokeMandate,
  encodeParams,
  findIntentPda,
  MANDATE_KINDS,
  MANDATE_NONCE_BIT,
  MAX_CRANK_BOUNTY,
  MAX_CREATE_FEE,
  signedIntentMessage,
  signEd25519Instruction,
} from "@intent-engine/core/internal";
import { createClient, type EngineTransaction, NotFillable, type Transport } from "../src/index.js";
import { MANDATE_GONE, mandateEpochPassed } from "@intent-engine/core/internal";
import { FEE_BPS, funded, NOW, world } from "./svm.js";

const LOCAL = "http://127.0.0.1:8899";
const DOMAIN = new Uint8Array(32).fill(0x11);
const ESCROW = 400n;
const MIN_OUT = 30n;
const AGENT_FEE = 20n;
const RELAYER_FEE = 15n;
const LANE = MANDATE_NONCE_BIT | (1n << 32n);
const SIGNED_NONCE = 4n;
const MANDATE_VERSION_AT = 307;
const INTENT_VERSION_AT = 164;
const FROZEN_AT = 108;
const FROZEN = 2;

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
    expect(fill).toMatchObject({ steps: 1, signature, agentPaid: { agent: agent.address, account: agentAccount, fee: AGENT_FEE }, relayerPaid: null, withheld: [], payoutsComplete: true });
    expect(await s.w.test.tokenBalance(agent.address, s.w.inputMint)).toBe(AGENT_FEE);
  });

  it("shows the relayer's fee on an intent a relayer submitted for its owner", async () => {
    const s = await setup();
    const relayer = await funded(s.w.chain);
    const relayerAccount = await s.w.test.tokens(relayer.address, s.w.inputMint, 0n);
    const intent = await relayed(s, relayer);
    const signature = await s.fill(SIGNED_NONCE);
    const fill = await s.client.fillOf(intent);
    expect(fill).toMatchObject({ steps: 1, signature, agentPaid: null, relayerPaid: { relayer: relayer.address, account: relayerAccount, fee: RELAYER_FEE }, payoutsComplete: true });
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

describe("a fill receipt names an agent fee the program withheld", () => {
  it("shows the agent role as withheld when the agent's account cannot take its fee", async () => {
    const s = await setup();
    const agent = await funded(s.w.chain);
    const agentAccount = await s.w.test.tokens(agent.address, s.w.inputMint, 0n);
    const held = s.w.chain.svm.getAccount(agentAccount);
    if (!held.exists) {
      throw new Error("the agent account is missing");
    }
    const frozen = new Uint8Array(held.data);
    frozen[FROZEN_AT] = FROZEN;
    s.w.chain.svm.setAccount({ ...held, data: frozen });
    const intent = await byAgent(s, agent);
    await s.fill(LANE);
    expect(await s.client.fillOf(intent)).toMatchObject({
      agentPaid: null,
      withheld: [{ role: "agent", payee: agent.address, account: agentAccount, amount: AGENT_FEE }],
    });
    expect(await s.w.test.tokenBalance(agent.address, s.w.inputMint)).toBe(0n);
  });
});

describe("a fill receipt says when the intent's creation was not reached", () => {
  it("marks the payouts incomplete when the scan never reaches the creating transaction", async () => {
    const s = await setup();
    const relayer = await funded(s.w.chain);
    await s.w.test.tokens(relayer.address, s.w.inputMint, 0n);
    const intent = await relayed(s, relayer);
    await s.fill(SIGNED_NONCE);
    const inner = s.w.chain.transport;
    const created = (tx: EngineTransaction) => tx.emitted.some((data) => decodeEvent(data)?.name === "IntentCreated");
    const bare = Object.fromEntries(Object.entries(inner).filter(([name]) => name !== "signaturesOf" && name !== "transactionsOf")) as Transport;
    const cut: Transport = { ...bare, engineTransactions: async (...args) => (await inner.engineTransactions(...args)).filter((tx) => !created(tx)) };
    expect(await s.client.fillOf(intent)).toMatchObject({ relayerPaid: { fee: RELAYER_FEE }, payoutsComplete: true });
    expect(await createClient({ url: LOCAL, transport: cut }).fillOf(intent)).toMatchObject({ relayerPaid: null, payoutsComplete: false });
  });
});

describe("client.fill checks the mandate before it builds a fill", () => {
  it("refuses an intent whose mandate its owner revoked, and sends nothing", async () => {
    const s = await setup();
    const agent = await funded(s.w.chain);
    await s.w.test.tokens(agent.address, s.w.inputMint, 0n);
    const intent = await byAgent(s, agent);
    await s.w.chain.transport.send([await buildRevokeMandate({ owner: s.owner, agent: agent.address, id: 0n })], s.owner);
    const sent = s.w.chain.sent.length;
    const refused = await s.fill(LANE).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(NotFillable);
    expect(refused).toMatchObject({ reason: "mandate-revoked", intent, message: `intent ${intent} ${MANDATE_GONE}` });
    expect(s.w.chain.sent).toHaveLength(sent);
    expect(await s.client.fillOf(intent)).toBeNull();
  });

  it("refuses an intent whose owner advanced the epoch past its mandate", async () => {
    const s = await setup();
    const agent = await funded(s.w.chain);
    await s.w.test.tokens(agent.address, s.w.inputMint, 0n);
    const intent = await byAgent(s, agent);
    await s.w.chain.transport.send([await buildAdvanceEpoch({ owner: s.owner, epoch: 1n })], s.owner);
    const sent = s.w.chain.sent.length;
    const refused = await s.fill(LANE).catch((error: unknown) => error);
    expect(refused).toMatchObject({ reason: "mandate-revoked", message: `intent ${intent} ${mandateEpochPassed(1n, 0n)}` });
    expect(s.w.chain.sent).toHaveLength(sent);
  });
});

describe("client.fill refuses what the program refuses, and sends nothing", () => {
  async function plain(s: Setup) {
    const created = await s.client.createIntent({ signer: s.owner, inputMint: s.w.inputMint, outputMint: s.w.outputMint, params: s.swap });
    return created;
  }

  async function configure(s: Setup, change: { paused?: number; fillDisabledKinds?: bigint }) {
    const [address] = await findConfigPda();
    const held = s.w.chain.svm.getAccount(address);
    if (!held.exists) {
      throw new Error("config missing");
    }
    const config = getConfigDecoder().decode(held.data);
    s.w.chain.svm.setAccount({ ...held, data: new Uint8Array(getConfigEncoder().encode({ ...config, ...change })) });
  }

  async function refusal(s: Setup, run: () => Promise<unknown>) {
    const sent = s.w.chain.sent.length;
    const refused = await run().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(NotFillable);
    expect(s.w.chain.sent).toHaveLength(sent);
    return refused as NotFillable;
  }

  it("refuses while fills are paused", async () => {
    const s = await setup();
    const created = await plain(s);
    await configure(s, { paused: PAUSE_FILL });
    expect((await refusal(s, () => s.fill(created.nonce))).reason).toBe("fill-paused");
  });

  it("refuses a kind whose fills the admin stopped", async () => {
    const s = await setup();
    const created = await plain(s);
    await configure(s, { fillDisabledKinds: kindBit(Kind.SwapExactIn) });
    expect((await refusal(s, () => s.fill(created.nonce))).reason).toBe("kind-disabled");
  });

  it("refuses an intent that is open but past its expiry", async () => {
    const s = await setup();
    const created = await plain(s);
    s.w.test.warp(10 * 86_400);
    const refused = await refusal(s, () => s.fill(created.nonce));
    expect(refused.reason).toBe("expired");
    expect(refused.message).toBe(`intent ${created.intent} has expired and can no longer be filled`);
  });

  it("refuses a solver that is the intent's owner, and one that is the receiver's owner", async () => {
    const s = await setup();
    const other = await funded(s.w.chain);
    const created = await s.client.createIntent({ signer: s.owner, inputMint: s.w.inputMint, outputMint: s.w.outputMint, params: s.swap, payTo: other.address });
    const intent = { owner: s.owner.address, nonce: created.nonce };
    expect((await refusal(s, () => s.client.fill({ solver: s.owner, intent, route: [] }))).reason).toBe("solver-output");
    expect((await refusal(s, () => s.client.fill({ solver: other, intent, route: [] }))).reason).toBe("solver-output");
  });

  it("refuses at exactly its expiry second and fills one second before it", async () => {
    const s = await setup();
    const created = await plain(s);
    const expiresAt = (await s.client.intent({ owner: s.owner.address, nonce: created.nonce }))?.intent.expiresAt ?? 0n;
    s.w.test.warp(expiresAt - s.w.test.now());
    expect(s.w.test.now()).toBe(expiresAt);
    expect((await refusal(s, () => s.fill(created.nonce))).reason).toBe("expired");
    const fresh = await setup();
    const open = await plain(fresh);
    const until = (await fresh.client.intent({ owner: fresh.owner.address, nonce: open.nonce }))?.intent.expiresAt ?? 0n;
    fresh.w.test.warp(until - fresh.w.test.now() - 1n);
    await expect(fresh.fill(open.nonce)).resolves.toBeTypeOf("string");
  });

  it("refuses an intent of an older version", async () => {
    const s = await setup();
    const created = await plain(s);
    const held = s.w.chain.svm.getAccount(created.intent);
    if (!held.exists) {
      throw new Error("intent missing");
    }
    const data = new Uint8Array(held.data);
    data[8 + INTENT_VERSION_AT] = 1;
    s.w.chain.svm.setAccount({ ...held, data });
    expect((await refusal(s, () => s.fill(created.nonce))).reason).toBe("intent-outdated");
  });

  it("refuses an amount other than the whole remaining one", async () => {
    const s = await setup();
    const created = await plain(s);
    const refused = await refusal(s, () => s.client.fill({ solver: s.solver, intent: { owner: s.owner.address, nonce: created.nonce }, amountIn: ESCROW - 1n, route: [] }));
    expect(refused.reason).toBe("amount-mismatch");
    expect(refused.message).toBe(`intent ${created.intent} can only be filled for its whole remaining ${ESCROW}, not ${ESCROW - 1n}`);
  });

  it("names a mandate account of another version as outdated, not revoked", async () => {
    const s = await setup();
    const agent = await funded(s.w.chain);
    await s.w.test.tokens(agent.address, s.w.inputMint, 0n);
    await byAgent(s, agent);
    const [mandate] = await findMandatePda({ owner: s.owner.address, agent: agent.address, id: 0n });
    const held = s.w.chain.svm.getAccount(mandate);
    if (!held.exists) {
      throw new Error("mandate missing");
    }
    const data = new Uint8Array(held.data);
    data[8 + MANDATE_VERSION_AT] = 9;
    s.w.chain.svm.setAccount({ ...held, data });
    expect((await refusal(s, () => s.fill(LANE))).reason).toBe("mandate-outdated");
  });
});
