import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Address, generateKeyPairSigner, type KeyPairSigner, lamports, type Signature } from "@solana/kit";
import { parseAmount } from "@intent-engine/core";
import type { LiteSVM } from "litesvm";
import type { Transport } from "../src/index.js";
import { createTestWorld, ECONOMICS_UNSET, TEST_WALLET_SOL, type TestWorld } from "../src/testing.js";

export const NOW = 1_700_000_000n;
export const FEE_BPS = 5;
const DOMAIN = new Uint8Array(32).fill(0x11);
const SOL = 1_000_000_000n;
const FUNDED_SOL = 100n;
const enginePath =
  process.env["INTENT_ENGINE_SO"] ?? fileURLToPath(new URL("../../../target/deploy/intent_engine.so", import.meta.url));

export type Chain = {
  svm: LiteSVM;
  transport: Transport;
  sent: string[];
};

export type World = {
  chain: Chain;
  test: TestWorld;
  authority: KeyPairSigner;
  feeRecipient: KeyPairSigner;
  owner: KeyPairSigner;
  inputMint: Address;
  outputMint: Address;
};

export async function funded(chain: Chain): Promise<KeyPairSigner> {
  const signer = await generateKeyPairSigner();
  chain.svm.airdrop(signer.address, lamports(FUNDED_SOL * SOL));
  return signer;
}

export const COLLECT_EVERY = 8;
let built = 0;

export function collectDropped(): void {
  built++;
  if (built % COLLECT_EVERY === 0) {
    (globalThis as { gc?: () => void }).gc?.();
  }
}

export async function world(): Promise<World> {
  collectDropped();
  const test = await createTestWorld({ start: NOW, fees: { ...ECONOMICS_UNSET, feeBps: FEE_BPS }, domain: DOMAIN, devnetMints: false, program: new Uint8Array(readFileSync(enginePath)) });
  const { svm, transport: inner } = test;
  const sent: string[] = [];
  const recorded = async (pending: Promise<Signature>) => {
    const signature = await pending;
    sent.push(signature);
    return signature;
  };
  const chain: Chain = {
    svm,
    sent,
    transport: {
      ...inner,
      offline: false,
      send: (instructions, payer) => recorded(inner.send(instructions, payer)),
      sendWire: (wire, latest) => recorded(inner.sendWire(wire, latest)),
      submitWire: (wire) => recorded(inner.submitWire(wire)),
    },
  };
  for (const topped of [test.admin, test.feeRecipient]) {
    svm.airdrop(topped.address, lamports(FUNDED_SOL * SOL - parseAmount(TEST_WALLET_SOL, 9)));
  }
  const owner = await funded(chain);
  const inputMint = await test.mint(6);
  const outputMint = await test.mint(6);
  await test.tokens(owner.address, inputMint, 1_000n);
  await test.tokens(owner.address, outputMint, 0n);
  return { chain, test, authority: test.admin, feeRecipient: test.feeRecipient, owner, inputMint, outputMint };
}
