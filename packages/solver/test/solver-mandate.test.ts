import { type Address, generateKeyPairSigner, lamports } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { Kind, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import {
  buildAdvanceEpoch,
  buildApproveDelegate,
  buildCreateIntentByAgent,
  buildCreateMandate,
  buildRevokeMandate,
  decodeIntentAccount,
  decodeMandateAccount,
  findIntentPda,
  findMandatePda,
  MANDATE_KINDS,
  MANDATE_NONCE_BIT,
  MAX_CRANK_BOUNTY,
  MAX_CREATE_FEE,
} from "@intent-engine/core/internal";
import { type Chain, MANDATE_GONE, mandateEpochPassed, mandateReplaced } from "../src/index.js";
import { AMOUNT, deployEngine, type Engine, engineTools, MIN_OUT, NOW, stashMarket } from "./solver-engine.js";
import { airdropped } from "./airdrop.js";

const AGENT_FEE = 10n;
const LANE = MANDATE_NONCE_BIT | (1n << 32n);

let e: Engine;
const tools = engineTools(() => e);
const { send, ata, balance } = tools;

beforeEach(async () => {
  e = await deployEngine();
});

const reading = (): Chain => ({
  ...tools.chain(),
  async account(address: Address) {
    const found = e.svm.getAccount(address);
    return found.exists && found.data.length > 0 ? new Uint8Array(found.data) : null;
  },
});

const market = () => stashMarket(e.stash, e.stashAccount, e.outputMint, e.solverOutput, () => MIN_OUT + 4_000n);

async function grant(agent: Address, id = 0n) {
  await send(e.owner, [
    await buildApproveDelegate({ owner: e.owner, mint: e.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS, amount: 10n * (AMOUNT + AGENT_FEE), decimals: 6 }),
    await buildCreateMandate({
      owner: e.owner,
      inputMint: e.inputMint,
      outputMint: e.outputMint,
      inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      mandate: {
        id,
        agent,
        kinds: MANDATE_KINDS,
        perIntent: AMOUNT + AGENT_FEE,
        total: 4n * (AMOUNT + AGENT_FEE),
        maxIntents: 4,
        maxTtl: 3_600n,
        validUntil: NOW + 86_400n,
        floorOut: 1n,
        floorIn: AMOUNT,
        agentFee: AGENT_FEE,
      },
    }),
  ]);
}

async function agentIntent() {
  const agent = await generateKeyPairSigner();
  airdropped(e.svm, agent.address, lamports(10_000_000_000n));
  const agentAccount = await ata(e.authority, agent.address, e.inputMint);
  await grant(agent.address);
  await send(agent, [
    await buildCreateIntentByAgent({
      agent,
      owner: e.owner.address,
      mandateId: 0n,
      treasury: e.feeRecipient.address,
      maxCreateFee: MAX_CREATE_FEE,
      maxBounty: MAX_CRANK_BOUNTY,
      nonce: LANE,
      params: { kind: Kind.SwapExactIn, amountIn: AMOUNT, minOut: MIN_OUT },
      expiresAt: NOW + 3_600n,
      inputMint: e.inputMint,
      outputMint: e.outputMint,
      inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
    }),
  ]);
  const [intent] = await findIntentPda({ owner: e.owner.address, nonce: LANE });
  e.intents.push(intent);
  const [mandate] = await findMandatePda({ owner: e.owner.address, agent: agent.address, id: 0n });
  return { agent, agentAccount, intent, mandate };
}

const stored = (intent: Address) => {
  const found = e.svm.getAccount(intent);
  if (!found.exists) throw new Error("intent missing");
  return decodeIntentAccount(new Uint8Array(found.data));
};

describe("the solver checks an agent intent's mandate before it fills", () => {
  it("fills an intent whose mandate is live and pays the agent its fee", async () => {
    const { agentAccount, intent } = await agentIntent();
    const report = await tools.solve(market(), { chain: reading() });
    expect(report.skipped).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(report.filled.map((fill) => fill.intent)).toEqual([intent]);
    expect(balance(agentAccount)).toBe(AGENT_FEE);
  });

  it("skips an intent whose mandate was revoked, and says why", async () => {
    const { agent, agentAccount, intent } = await agentIntent();
    await send(e.owner, [await buildRevokeMandate({ owner: e.owner, agent: agent.address, id: 0n })]);
    const report = await tools.solve(market(), { chain: reading() });
    expect(report.skipped).toEqual([{ intent, reason: MANDATE_GONE }]);
    expect(report.filled).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(balance(agentAccount)).toBe(0n);
  });

  it("skips an intent whose mandate was revoked and granted again under a new serial", async () => {
    const { agent, intent, mandate } = await agentIntent();
    await send(e.owner, [await buildRevokeMandate({ owner: e.owner, agent: agent.address, id: 0n })]);
    await grant(agent.address);
    const regranted = e.svm.getAccount(mandate);
    if (!regranted.exists) throw new Error("the mandate was not granted again");
    const recorded = stored(intent).mandateSerial;
    const serial = decodeMandateAccount(new Uint8Array(regranted.data)).serial;
    expect(serial).not.toBe(recorded);
    const report = await tools.solve(market(), { chain: reading() });
    expect(report.skipped).toEqual([{ intent, reason: mandateReplaced(serial, recorded) }]);
    expect(report.filled).toEqual([]);
  });

  it("skips an intent whose owner advanced the epoch past its mandate", async () => {
    const { intent } = await agentIntent();
    await send(e.owner, [await buildAdvanceEpoch({ owner: e.owner, epoch: 1n })]);
    const report = await tools.solve(market(), { chain: reading() });
    expect(report.skipped).toEqual([{ intent, reason: mandateEpochPassed(1n, 0n) }]);
    expect(report.filled).toEqual([]);
  });
});
