import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Address, generateKeyPairSigner, type KeyPairSigner, lamports } from "@solana/kit";
import { getMintToInstruction } from "@solana-program/token";
import { findAssociatedTokenAddress, Kind, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import {
  buildApproveDelegate,
  buildCreateIntentByAgent,
  buildCreateIntentSigned,
  buildCreateMandate,
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
import { createClient, type EngineTransaction } from "@intent-engine/client";
import { createTestWorld, ECONOMICS_UNSET } from "@intent-engine/client/testing";

export const NOW = 1_700_000_000n;
export const ESCROW = 400n;
export const MIN_OUT = 30n;
export const AGENT_FEE = 20n;
export const RELAYER_FEE = 15n;
export const AGENT_LANE = MANDATE_NONCE_BIT | (1n << 32n);
export const SIGNED_NONCE = 4n;
const DOMAIN = new Uint8Array(32).fill(0x11);
const SOL = 1_000_000_000n;
const FROZEN_AT = 108;
const FROZEN = 2;
const enginePath = process.env["INTENT_ENGINE_SO"] ?? fileURLToPath(new URL("../../../target/deploy/intent_engine.so", import.meta.url));

export type PayoutChain = Awaited<ReturnType<typeof payoutChain>>;

export async function payoutChain() {
  const test = await createTestWorld({ start: NOW, fees: { ...ECONOMICS_UNSET, feeBps: 5 }, domain: DOMAIN, devnetMints: false, program: new Uint8Array(readFileSync(enginePath)) });
  const { svm, transport } = test;
  const client = createClient({ url: "http://127.0.0.1:8899", transport });
  const funded = async (): Promise<KeyPairSigner> => {
    const signer = await generateKeyPairSigner();
    svm.airdrop(signer.address, lamports(100n * SOL));
    return signer;
  };
  const inputMint = await test.mint(6);
  const outputMint = await test.mint(6);
  const solver = await funded();
  const owner = await funded();
  const ownerInput = await test.tokens(owner.address, inputMint, 1_000n);
  const receiver = await test.tokens(owner.address, outputMint, 0n);
  await transport.send([await buildInitUser({ owner })], owner);
  const swap = { kind: Kind.SwapExactIn, amountIn: ESCROW, minOut: MIN_OUT } as const;
  const terms = { inputMint, outputMint, inputTokenProgram: TOKEN_PROGRAM_ADDRESS, outputTokenProgram: TOKEN_PROGRAM_ADDRESS };
  const approve = async (amount: bigint) =>
    transport.send([await buildApproveDelegate({ owner, mint: inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS, amount, decimals: 6 })], owner);

  const fill = async (nonce: bigint) =>
    client.fill({
      solver,
      intent: { owner: owner.address, nonce },
      route: [
        getMintToInstruction({
          mint: outputMint,
          token: await findAssociatedTokenAddress({ owner: solver.address, mint: outputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
          mintAuthority: test.admin,
          amount: MIN_OUT,
        }),
      ],
    });

  const byAgent = async (frozen: boolean): Promise<{ intent: Address; agent: Address; account: Address }> => {
    const agent = await funded();
    const account = await test.tokens(agent.address, inputMint, 0n);
    if (frozen) {
      const held = svm.getAccount(account);
      if (!held.exists) {
        throw new Error("the agent account is missing");
      }
      const data = new Uint8Array(held.data);
      data[FROZEN_AT] = FROZEN;
      svm.setAccount({ ...held, data });
    }
    await approve(ESCROW + AGENT_FEE);
    await transport.send(
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
    await transport.send(
      [
        await buildCreateIntentByAgent({
          agent,
          owner: owner.address,
          mandateId: 0n,
          treasury: test.feeRecipient.address,
          maxCreateFee: MAX_CREATE_FEE,
          maxBounty: MAX_CRANK_BOUNTY,
          nonce: AGENT_LANE,
          params: swap,
          expiresAt: NOW + 3_600n,
          ...terms,
        }),
      ],
      agent,
    );
    return { intent: (await findIntentPda({ owner: owner.address, nonce: AGENT_LANE }))[0], agent: agent.address, account };
  };

  const byRelayer = async (): Promise<{ intent: Address; relayer: Address; account: Address }> => {
    const relayer = await funded();
    const account = await test.tokens(relayer.address, inputMint, 0n);
    await approve(ESCROW + RELAYER_FEE);
    const expiresAt = NOW + 3_600n;
    const submitBy = NOW + 600n;
    const message = await signedIntentMessage({
      inputMint,
      outputMint,
      nonce: SIGNED_NONCE,
      expiresAt,
      submitBy,
      relayerFee: RELAYER_FEE,
      domain: DOMAIN,
      owner: owner.address,
      ownerInput,
      receiver,
      kind: Kind.SwapExactIn,
      params: encodeParams(swap),
      epoch: 0n,
    });
    await transport.send(
      [
        await signEd25519Instruction(owner, message),
        await buildCreateIntentSigned({
          inputMint,
          outputMint,
          nonce: SIGNED_NONCE,
          expiresAt,
          submitBy,
          relayerFee: RELAYER_FEE,
          treasury: test.feeRecipient.address,
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
    return { intent: (await findIntentPda({ owner: owner.address, nonce: SIGNED_NONCE }))[0], relayer: relayer.address, account };
  };

  const transactions = (): Promise<EngineTransaction[]> => transport.engineTransactions(100);

  return { test, client, owner, solver, inputMint, outputMint, fill, byAgent, byRelayer, transactions };
}
