import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Address, createNoopSigner, type Instruction } from "@solana/kit";
import { Kind } from "../src/index.js";
import {
  buildAdvanceEpoch,
  buildAdvanceNonce,
  buildCancelIntent,
  buildCloseIntent,
  buildCreateIntent,
  buildExpireIntent,
  buildFillIntent,
  buildInitUser,
  type IdlLike,
  MAX_CRANK_BOUNTY,
  MAX_CREATE_FEE,
} from "../src/internal.js";

export const read = (rel: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")) as unknown;
export const idl = read("../generated/idl.json") as IdlLike;
export const vectors = read("./golden/vectors.json") as {
  keys: Record<"owner" | "input_mint" | "output_mint" | "fee_recipient", Address>;
  pdas: { name: string; nonce?: string; address: Address; vault?: Address }[];
};

export const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;
export const { owner, input_mint: inputMint, output_mint: outputMint, fee_recipient: feeRecipient } =
  vectors.keys;
export const ownerSigner = createNoopSigner(owner);
export const solver = createNoopSigner("So1ver1111111111111111111111111111111111111" as Address);
export const swap = { kind: Kind.SwapExactIn, amountIn: 400n, minOut: 300n } as const;
export const golden42 = vectors.pdas.find((p) => p.name === "intent" && p.nonce === "42");
export const announced = {
  announcement: "SysvarS1otHashes111111111111111111111111111" as Address,
  opening: { delivered: new Uint8Array(32).fill(0xd1), salt: new Uint8Array(16).fill(0x5a) },
};

export const meta = (ix: Instruction, i: number) => {
  const m = ix.accounts?.[i];
  if (!m) {
    throw new Error(`no account ${i}`);
  }
  return m;
};

export async function everyBuilt(): Promise<Record<string, Instruction>> {
  const ref = { owner, nonce: 42n, inputMint, tokenProgram: TOKEN };
  return {
    init_user: await buildInitUser({ owner: ownerSigner }),
    advance_nonce: await buildAdvanceNonce({ owner: ownerSigner, nonceBase: 9n }),
    advance_epoch: await buildAdvanceEpoch({ owner: ownerSigner, epoch: 9n }),
    create_intent: await buildCreateIntent({
      owner: ownerSigner,
      treasury: feeRecipient,
      maxCreateFee: MAX_CREATE_FEE,
      maxBounty: MAX_CRANK_BOUNTY,
      nonce: 42n,
      params: swap,
      expiresAt: 1_700_003_600n,
      inputMint,
      outputMint,
      inputTokenProgram: TOKEN,
      outputTokenProgram: TOKEN_2022,
    }),
    cancel_intent: await buildCancelIntent({ ...ref, owner: ownerSigner }),
    expire_intent: await buildExpireIntent({ ...ref, cranker: solver }),
    close_intent: await buildCloseIntent({ ...ref, cranker: solver }),
    fill_intent: await buildFillIntent({
      solver,
      owner,
      nonce: 42n,
      inputMint,
      outputMint,
      inputTokenProgram: TOKEN,
      outputTokenProgram: TOKEN_2022,
      receiver: owner,
      solverOutput: solver.address,
      solverInput: solver.address,
      feeRecipient,
      amountIn: 400n,
      amountOut: 300n,
      maxFeeBps: 100,
    }),
  };
}

export function splitWeights(count: number): number[] {
  const each = Math.floor(10_000 / count);
  return Array.from({ length: count }, (_, i) => (i === 0 ? 10_000 - each * (count - 1) : each));
}
