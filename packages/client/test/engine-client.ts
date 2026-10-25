import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Kind } from "@intent-engine/core";
import { buildCancelIntent, buildCreateIntent } from "@intent-engine/core/internal";
import { createClient, type Transport } from "../src/index.js";
import { NOW, type World } from "./svm.js";

export const ESCROW = 400n;
export const LOCAL = "http://127.0.0.1:8899";

export async function create(w: World, client: ReturnType<typeof createClient>, nonce: bigint, expiresAt = NOW + 3_600n) {
  const config = await client.config();
  return buildCreateIntent({
    owner: w.owner,
    treasury: config.feeRecipient,
    maxCreateFee: config.createFee,
    maxBounty: config.crankBounty,
    nonce,
    params: { kind: Kind.SwapExactIn, amountIn: ESCROW, minOut: 50n },
    expiresAt,
    inputMint: w.inputMint,
    outputMint: w.outputMint,
    inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
    outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
}

export const cancel = (w: World, nonce: bigint) =>
  buildCancelIntent({ owner: w.owner, nonce, inputMint: w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });

export const until = async (check: () => boolean) => {
  for (let tries = 0; !check(); tries++) {
    if (tries > 500) {
      throw new Error("condition never held");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

export function countingReads(inner: Transport) {
  let reads = 0;
  const transport: Transport = {
    ...inner,
    intents: async (...args) => {
      reads++;
      return inner.intents(...args);
    },
  };
  return { transport, reads: () => reads };
}

export const twoMoreReads = async (counted: { reads: () => number }) => {
  const at = counted.reads();
  await until(() => counted.reads() >= at + 2);
};
