import { createHash } from "node:crypto";
import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { attestedResult, DEVNET_TEST_MINT, NATIVE_MINT, parseAmount } from "@intent-engine/core";
import { buildAnnounceDelivery, delivery, keyFingerprintV4, sealDeliveryV4, x25519PublicOf } from "@intent-engine/core/internal";
import { FirstOpeningRefused } from "../../src/index.js";
import { createTestWorld, type TestWallet, type TestWorld } from "../../src/testing.js";
import { workUrl } from "../work.js";

const SPEC = "One line about a forged wallet slot.\n";
const WORK = "the honest worker's line\n";

const hashOf = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

async function posted(world: TestWorld): Promise<{ judge: TestWallet; intent: Address }> {
  const [owner, judge] = [await world.wallet(), await world.wallet()];
  const specHash = Uint8Array.from(Buffer.from(hashOf(SPEC), "hex"));
  const params = attestedResult({ amountIn: parseAmount("0.5", 9), minResult: 1n, maxResult: 1n, attestor: judge.address, specHash, judgeFee: 0n });
  const { intent } = await world.client.createIntent({ signer: owner, inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT, params, specUrl: workUrl("spec.md") });
  return { judge, intent };
}

async function forged(world: TestWorld, intent: Address, judge: TestWallet) {
  const griefer = await world.wallet();
  const blob = await sealDeliveryV4({ source: crypto.getRandomValues(new Uint8Array(32)), url: workUrl("grief"), recipients: [griefer.address] }, intent, griefer.address);
  const { announcement, instruction } = await buildAnnounceDelivery({ worker: griefer, intent, attestor: judge.address, commitment: new Uint8Array(32).fill(7), blob });
  await world.client.send([instruction], griefer);
  return { griefer, announcement, blob };
}

describe("a third party's first announcement whose wallet slot names a key that is not the judge's wallet key", () => {
  it("DC-1 firstOpening refuses with key-not-given forever, though the judge gave its wallet key and the earliest announcement that opens to the work is the honest worker's", async () => {
    const world = await createTestWorld();
    const { judge, intent } = await posted(world);
    const { griefer, announcement: grief, blob } = await forged(world, intent, judge);
    const head = delivery.blobHead(blob);
    expect(head.count).toBe(1);
    expect(head.mask).toBe(0);
    expect(hexOf(head.fps[0] ?? new Uint8Array())).toBe(hexOf(await keyFingerprintV4(x25519PublicOf(griefer.address))));
    expect(hexOf(head.fps[0] ?? new Uint8Array())).not.toBe(hexOf(await keyFingerprintV4(x25519PublicOf(judge.address))));

    const honest = await world.wallet();
    const made = await world.client.announce({ worker: honest, intent, sha256: hashOf(WORK), url: workUrl() });
    const listed = await world.client.announcements(intent);
    expect(listed).toMatchObject({ complete: true, closed: false });
    expect(listed.announcements.map(({ address }) => address)).toEqual([grief, made.announcement]);

    const first = await world.client.firstOpening({ intent, sha256: hashOf(WORK), keypair: judge.keypair }).catch((error: unknown) => error);
    expect(first instanceof FirstOpeningRefused ? { reason: first.reason, announcement: first.announcement } : null).toBeNull();
    expect(first).toMatchObject({ announcement: made.announcement, seq: 2n, worker: honest.address });
  });

  it("DC-1 openings throws key-not-given naming the judge's own wallet slot as unopened, so the judge can never reach the honest worker's announcement before expiry", async () => {
    const world = await createTestWorld();
    const { judge, intent } = await posted(world);
    const { announcement: grief } = await forged(world, intent, judge);
    const honest = await world.wallet();
    const made = await world.client.announce({ worker: honest, intent, sha256: hashOf(WORK), url: workUrl() });

    expect((await world.client.announcements(intent)).announcements.map(({ address }) => address)).toEqual([grief, made.announcement]);

    const walked = await world.client.openings({ intent, keypair: judge.keypair }).catch((error: unknown) => error);
    const refusal = walked instanceof FirstOpeningRefused ? { reason: walked.reason, announcement: walked.announcement, sealedTo: walked.sealedTo.map(({ wallet, kind }) => ({ wallet, kind })) } : null;
    expect(refusal).toBeNull();
    expect(walked).toMatchObject({ intent, opening: { announcement: made.announcement, seq: 2n, worker: honest.address, url: workUrl() } });
  });
});
