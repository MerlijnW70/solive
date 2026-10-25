import { fileURLToPath } from "node:url";
import {
  appendTransactionMessageInstruction,
  createTransactionMessage,
  generateKeyPairSigner,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";
import { describe, expect, it } from "vitest";
import { INTENT_ENGINE_PROGRAM_ADDRESS } from "../src/internal.js";

const ANCHOR_INSTRUCTION_FALLBACK_NOT_FOUND = 101;
const FEE_BUDGET = lamports(1_000_000_000n);
const enginePath =
  process.env["INTENT_ENGINE_SO"] ??
  fileURLToPath(new URL("../../../target/deploy/intent_engine.so", import.meta.url));

async function rejectionCode(data: Uint8Array): Promise<number> {
  const svm = new LiteSVM();
  svm.addProgramFromFile(INTENT_ENGINE_PROGRAM_ADDRESS, enginePath);
  const payer = await generateKeyPairSigner();
  svm.airdrop(payer.address, FEE_BUDGET);
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
    (m) =>
      appendTransactionMessageInstruction(
        { programAddress: INTENT_ENGINE_PROGRAM_ADDRESS, data },
        m,
      ),
  );
  const result = svm.sendTransaction(await signTransactionMessageWithSigners(message));
  if (!(result instanceof FailedTransactionMetadata)) {
    throw new Error("engine accepted an instruction it does not declare");
  }
  const failure = result.err();
  if (typeof failure !== "object" || !("err" in failure)) {
    throw new Error(`expected an instruction error, got ${String(failure)}`);
  }
  const inner = failure.err();
  if (typeof inner !== "object" || !("code" in inner)) {
    throw new Error(`expected a custom error, got ${String(inner)}`);
  }
  return inner.code;
}

describe("generated program address", () => {
  it("routes to the deployed engine, which rejects an unknown discriminator with fallback-not-found", async () => {
    expect(await rejectionCode(new Uint8Array(8))).toBe(ANCHOR_INSTRUCTION_FALLBACK_NOT_FOUND);
  });
});
