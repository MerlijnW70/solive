import { describe, expect, it } from "vitest";
import { Kind, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import {
  buildApproveDelegate,
  buildCreateIntentByAgent,
  buildCreateMandate,
  buildInitUser,
  buildRevokeMandate,
  findIntentPda,
  MANDATE_KINDS,
  MANDATE_NONCE_BIT,
  MAX_CRANK_BOUNTY,
  MAX_CREATE_FEE,
} from "@intent-engine/core/internal";
import { MANDATE_GONE } from "@intent-engine/solver";
import { EXIT_OK } from "../src/main.js";
import { ata, cli, funded, h, NOW, send, world } from "./harness.js";

const AMOUNT = 400n;
const AGENT_FEE = 10n;
const LANE = MANDATE_NONCE_BIT | (1n << 32n);

describe("solve checks an agent intent's mandate on chain before it fills", () => {
  it("skips an intent whose mandate its owner revoked, and says why", async () => {
    const { authority, feeRecipient, owner, inputMint, outputMint } = await world();
    h.watched.length = 0;
    h.watched.push(owner.address);
    const agent = await funded();
    await ata(authority, agent.address, inputMint);
    const tokens = { inputMint, outputMint, inputTokenProgram: TOKEN_PROGRAM_ADDRESS, outputTokenProgram: TOKEN_PROGRAM_ADDRESS };
    await send(owner, [
      await buildInitUser({ owner }),
      await buildApproveDelegate({ owner, mint: inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS, amount: AMOUNT + AGENT_FEE, decimals: 6 }),
      await buildCreateMandate({
        owner,
        ...tokens,
        mandate: {
          id: 0n,
          agent: agent.address,
          kinds: MANDATE_KINDS,
          perIntent: AMOUNT + AGENT_FEE,
          total: AMOUNT + AGENT_FEE,
          maxIntents: 1,
          maxTtl: 3_600n,
          validUntil: NOW + 86_400n,
          floorOut: 1n,
          floorIn: AMOUNT,
          agentFee: AGENT_FEE,
        },
      }),
    ]);
    await send(agent, [
      await buildCreateIntentByAgent({
        agent,
        owner: owner.address,
        mandateId: 0n,
        treasury: feeRecipient.address,
        maxCreateFee: MAX_CREATE_FEE,
        maxBounty: MAX_CRANK_BOUNTY,
        nonce: LANE,
        params: { kind: Kind.SwapExactIn, amountIn: AMOUNT, minOut: 2n },
        expiresAt: NOW + 3_600n,
        ...tokens,
      }),
    ]);
    await send(owner, [await buildRevokeMandate({ owner, agent: agent.address, id: 0n })]);
    const [intent] = await findIntentPda({ owner: owner.address, nonce: LANE });
    h.fetched.length = 0;
    const solver = await funded();
    const result = await cli(["solve", "--keypair", "s.json", "--jupiter", "https://quote.example/swap/v1/", "--min-profit", `${outputMint}=1`, "--concurrency", "1"], {
      "s.json": solver,
    });
    expect(result.code).toBe(EXIT_OK);
    expect(result.json()).toMatchObject({ filled: [], sent: [], skipped: [{ intent, reason: MANDATE_GONE }], failed: [] });
    expect(h.fetched).toEqual([]);
  });
});
