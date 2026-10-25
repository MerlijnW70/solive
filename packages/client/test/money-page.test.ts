import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { attestedResult, DEVNET_TEST_MINT, findAssociatedTokenAddress, IntentStatus, NATIVE_MINT, parseAmount, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import { delivery, deliveryBookAddress } from "@intent-engine/core/internal";
import { createTestWorld, type TestWallet, type TestWorld } from "../src/testing.js";
import { MONEY_SECTION } from "./doc-sections.js";
import { workUrl } from "./work.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const SECTION = MONEY_SECTION.exec(readFileSync(`${ROOT}/docs/sdk-client.md`, "utf8"))?.[0] ?? "";
const SIGNATURE_FEE = 5_000n;
const DAY = 86_400n;
const AMOUNT = parseAmount("0.5", 9);
const JUDGE_FEE = parseAmount("0.01", 9);

const CLAIMS = {
  wrapped:
    "A release of a proof escrow in SOL pays the worker and the judge in wrapped SOL, into their token accounts for `NATIVE_MINT`; `unwrap` closes that account and returns its balance and its rent to the wallet as SOL.",
  rent: "`announce` takes the announcement's rent from the worker's own wallet, and on the first announcement to an escrow the delivery book's rent too, unless `payer` names another wallet to pay them.",
  reclaim: `\`reclaim\` returns an announcement's rent to whoever paid it, for an unpaid one once the escrow is no longer open and for the paid one ${delivery.REFUTE_WINDOW_SECS / DAY} days after the release; \`closeBook\` then returns the delivery book's rent to whoever paid it.`,
  escrowed:
    "After a release the intent reads `Filled`, and `escrowed` and `filled` both read the amount escrowed at create; the `net` of its `IntentAttested` event is what the worker received.",
};

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const solOf = (world: TestWorld, wallet: TestWallet): bigint => world.svm.getBalance(wallet.address) ?? 0n;

async function escrow(world: TestWorld) {
  const [owner, judge] = [await world.wallet(), await world.wallet()];
  const specHash = Uint8Array.from(createHash("sha256").update("the spec").digest());
  const params = attestedResult({ amountIn: AMOUNT, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash, judgeFee: JUDGE_FEE });
  const { intent } = await world.client.createIntent({ signer: owner, inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT, params });
  return { owner, judge, intent };
}

async function released(world: TestWorld) {
  const job = await escrow(world);
  const worker = await world.wallet();
  const made = await world.client.announce({ worker, intent: job.intent, sha256: sha("the work"), url: workUrl() });
  const first = await world.client.firstOpening({ intent: job.intent, sha256: sha("the work"), keypair: job.judge.keypair });
  await world.client.settleProof({ judge: job.judge, intent: job.intent, announcement: first.announcement, opening: first, result: 1n });
  const attested = (await world.client.history(job.intent)).events.find(({ name }) => name === "IntentAttested");
  return { ...job, worker, made, net: attested?.name === "IntentAttested" ? attested.fields.net : -1n };
}

const lamportsOf = async (world: TestWorld, address: Parameters<TestWorld["transport"]["getAccount"]>[0]) => (await world.transport.getAccount(address))?.lamports ?? 0n;

describe("the section of the client page on what a release moves", () => {
  it("states exactly the claims these tests assert", () => {
    expect([...SECTION.matchAll(/^- (.+)$/gm)].map((m) => m[1])).toEqual(Object.values(CLAIMS));
  });

  it(CLAIMS.wrapped, async () => {
    const world = await createTestWorld();
    const job = await escrow(world);
    const worker = await world.wallet();
    await world.client.announce({ worker, intent: job.intent, sha256: sha("the work"), url: workUrl() });
    const first = await world.client.firstOpening({ intent: job.intent, sha256: sha("the work"), keypair: job.judge.keypair });
    const [workerSol, judgeSol] = [solOf(world, worker), solOf(world, job.judge)];
    await world.client.settleProof({ judge: job.judge, intent: job.intent, announcement: first.announcement, opening: first, result: 1n, payer: job.owner });
    expect([solOf(world, worker), solOf(world, job.judge)]).toEqual([workerSol, judgeSol]);
    const net = await world.tokenBalance(worker.address, NATIVE_MINT);
    expect(net).toBeGreaterThan(0n);
    expect(await world.tokenBalance(job.judge.address, NATIVE_MINT)).toBe(JUDGE_FEE);
    const account = await findAssociatedTokenAddress({ owner: worker.address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const held = await lamportsOf(world, account);
    expect(held).toBe(net + world.svm.minimumBalanceForRentExemption(165n));
    await world.client.unwrap(worker);
    expect(await world.transport.getAccount(account)).toBeNull();
    expect(solOf(world, worker) - workerSol).toBe(held - SIGNATURE_FEE);
  });

  it(CLAIMS.rent, async () => {
    const world = await createTestWorld();
    const { owner, intent } = await escrow(world);
    const [first, second, relayed] = [await world.wallet(), await world.wallet(), await world.wallet()];
    const before = solOf(world, first);
    const made = await world.client.announce({ worker: first, intent, sha256: sha("one"), url: workUrl() });
    const book = await lamportsOf(world, await deliveryBookAddress(intent));
    expect(before - solOf(world, first)).toBe((await lamportsOf(world, made.announcement)) + book + SIGNATURE_FEE);
    const secondBefore = solOf(world, second);
    const next = await world.client.announce({ worker: second, intent, sha256: sha("two"), url: workUrl() });
    expect(secondBefore - solOf(world, second)).toBe((await lamportsOf(world, next.announcement)) + SIGNATURE_FEE);
    const [relayedBefore, ownerBefore] = [solOf(world, relayed), solOf(world, owner)];
    const paidFor = await world.client.announce({ worker: relayed, payer: owner, intent, sha256: sha("three"), url: workUrl() });
    expect(solOf(world, relayed)).toBe(relayedBefore);
    expect(ownerBefore - solOf(world, owner)).toBe((await lamportsOf(world, paidFor.announcement)) + 2n * SIGNATURE_FEE);
  });

  it(CLAIMS.reclaim, async () => {
    const world = await createTestWorld();
    const unpaid = await escrow(world);
    const idle = await world.wallet();
    const made = await world.client.announce({ worker: idle, intent: unpaid.intent, sha256: sha("idle"), url: workUrl() });
    const rent = await lamportsOf(world, made.announcement);
    expect((await world.client.plan.reclaim({ worker: idle })).kept).toEqual([made.announcement]);
    await world.client.cancel(unpaid.owner, unpaid.intent);
    const idleBefore = solOf(world, idle);
    expect((await world.client.reclaim({ worker: idle })).closed).toEqual([made.announcement]);
    expect(solOf(world, idle) - idleBefore).toBe(rent - SIGNATURE_FEE);

    const paid = await released(world);
    const paidRent = await lamportsOf(world, paid.made.announcement);
    world.warp(delivery.REFUTE_WINDOW_SECS - 1n);
    expect((await world.client.plan.reclaim({ worker: paid.worker })).kept).toEqual([paid.made.announcement]);
    world.warp(1);
    const workerBefore = solOf(world, paid.worker);
    expect((await world.client.reclaim({ worker: paid.worker })).closed).toEqual([paid.made.announcement]);
    expect(solOf(world, paid.worker) - workerBefore).toBe(paidRent - SIGNATURE_FEE);

    const book = await lamportsOf(world, await deliveryBookAddress(paid.intent));
    const bookBefore = solOf(world, paid.worker);
    await world.client.closeBook(paid.intent, paid.owner);
    expect(solOf(world, paid.worker) - bookBefore).toBe(book);
  });

  it(CLAIMS.escrowed, async () => {
    const world = await createTestWorld();
    const { intent, worker, net } = await released(world);
    const held = await world.client.intent(intent);
    expect(held?.intent).toMatchObject({ status: IntentStatus.Filled, escrowed: AMOUNT, filled: AMOUNT });
    expect(net).toBe(await world.tokenBalance(worker.address, NATIVE_MINT));
    expect(net).toBeLessThan(AMOUNT - JUDGE_FEE);
  });
});
