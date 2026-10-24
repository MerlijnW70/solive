import { createHash } from "node:crypto";
import {
  type Address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  type Instruction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type TransactionSigner,
} from "@solana/kit";
import { expect } from "vitest";
import { attestedResult, COMPUTE_BUDGET_ADDRESS, DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import { type Client, createClient, type Plan } from "../src/index.js";
import type { TestWallet, TestWorld } from "../src/testing.js";

export const PAY = 1_000_000n;

export const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

export const workUrl = (name = "work.tar"): string => "https://" + "example.org/" + name;

export const SPEC = new Uint8Array(createHash("sha256").update("the plan spec").digest());

export const proofParams = (attestor: Address, amountIn = PAY, judgeFee = 0n) =>
  attestedResult({ amountIn, minResult: 1n, maxResult: 1n, attestor, specHash: SPEC, judgeFee });

export async function sendByKit(world: TestWorld, instructions: readonly Instruction[], payer: TransactionSigner): Promise<string> {
  world.svm.expireBlockhash();
  const latest = await world.transport.latestBlockhash();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return world.transport.sendWire(getBase64EncodedWireTransaction(await signTransactionMessageWithSigners(message)), latest);
}

export type Batched = Plan & { batches?: Instruction[][] };

export const transactionsOf = (plan: Batched): Instruction[][] => [
  ...(plan.setup.length === 0 ? [] : [plan.setup]),
  ...(plan.batches ?? (plan.instructions.length === 0 ? [] : [plan.instructions])),
];

export async function sendPlan(world: TestWorld, plan: Batched, payer: TransactionSigner): Promise<void> {
  expect(payer.address).toBe(plan.payer);
  for (const instructions of transactionsOf(plan)) {
    await sendByKit(world, instructions, payer);
  }
}

export function recording(world: TestWorld): { client: Client; sent: Instruction[][] } {
  const sent: Instruction[][] = [];
  const transport = {
    ...world.transport,
    send: async (instructions: readonly Instruction[], payer: TransactionSigner) => {
      sent.push(instructions.filter(({ programAddress }) => programAddress !== COMPUTE_BUDGET_ADDRESS));
      return world.transport.send(instructions, payer);
    },
  };
  return { client: createClient({ url: world.client.url, transport }), sent };
}

export type PlanCase<L> = {
  lane(world: TestWorld): Promise<L>;
  before?(world: TestWorld): void;
  plan(client: Client, lane: L): Promise<Batched>;
  write(client: Client, lane: L): Promise<unknown>;
  payer(lane: L): TransactionSigner;
  observe(world: TestWorld, lane: L): Promise<unknown>;
};

export async function checkCase<L>(world: TestWorld, plan: PlanCase<L>): Promise<{ written: unknown; planned: unknown }> {
  const [byWrite, byPlan] = [await plan.lane(world), await plan.lane(world)];
  plan.before?.(world);
  const { client, sent } = recording(world);
  const expected = await plan.plan(client, byWrite);
  expect(sent).toEqual([]);
  await plan.write(client, byWrite);
  expect(sent).toEqual(transactionsOf(expected));
  const own = await plan.plan(world.client, byPlan);
  await sendPlan(world, own, plan.payer(byPlan));
  const [written, planned] = [await plan.observe(world, byWrite), await plan.observe(world, byPlan)];
  expect(planned).toEqual(written);
  return { written, planned };
}

export type Escrow = { owner: TestWallet; judge: TestWallet; intent: Address; nonce: bigint };

export async function escrow(world: TestWorld, attestor?: Address): Promise<Escrow> {
  const [owner, judge] = [await world.wallet(), await world.wallet()];
  const made = await world.client.createIntent({ signer: owner, inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT, params: proofParams(attestor ?? judge.address) });
  return { owner, judge, intent: made.intent, nonce: made.nonce };
}

export async function delivered(world: TestWorld, intent: Address, worker: TestWallet, work = sha("the planned work"), url = workUrl()) {
  const made = await world.client.announce({ worker, intent, sha256: work, url });
  return { announcement: made.announcement, opening: { sha256: work, salt: made.salt } };
}

export const statusOf = async (world: TestWorld, intent: Address): Promise<number | null> => (await world.client.intent(intent))?.intent.status ?? null;
