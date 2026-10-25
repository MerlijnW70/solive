import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Address } from "@solana/kit";
import { afterEach, describe, expect, it } from "vitest";
import { attestedResult, DEVNET_TEST_MINT, NATIVE_MINT, parseAmount } from "@intent-engine/core";
import { blobLayout, buildAnnounceDelivery, sealDeliveryV4 } from "@intent-engine/core/internal";
import { DEFAULT_EXPIRES_IN } from "../src/client-types.js";
import { connect, FirstOpeningRefused } from "../src/index.js";
import { createTestWorld, type TestWallet, type TestWorld } from "../src/testing.js";
import { serve, type Served } from "./local-server.js";
import { workUrl } from "./work.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const SIMPLE_PAGE = readFileSync(`${ROOT}/docs/sdk.md`, "utf8");
const SPEC = "The work is one line of text about rain.\n";
const WORK = "rain on the tin roof\n";

const DELIVERIES =
  "- `deliveries`: the announcements on an escrow in seq order, each with its `worker`, `announcement` and `seq`; `opened` is true and `url` holds the work url once it opens with the `keypair` you pass, and `sha256` names the work it commits to once the `sha256` you pass, or the work a release paid, opens it\n";
const OPENINGS = "- `openings`: as the judge, the earliest delivery that opens with your `keypair`, with its work url, as the full client's `openings` walks it\n";

const hashOf = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function posted(world: TestWorld, specUrl: string): Promise<{ owner: TestWallet; judge: TestWallet; intent: Address }> {
  const [owner, judge] = [await world.wallet(), await world.wallet()];
  const specHash = Uint8Array.from(Buffer.from(hashOf(SPEC), "hex"));
  const params = attestedResult({ amountIn: parseAmount("0.5", 9), minResult: 1n, maxResult: 1n, attestor: judge.address, specHash, judgeFee: 0n });
  const { intent } = await world.client.createIntent({ signer: owner, inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT, params, specUrl });
  return { owner, judge, intent };
}

async function griefed(world: TestWorld, intent: Address, judge: TestWallet) {
  const griefer = await world.wallet();
  const blob = await sealDeliveryV4({ source: crypto.getRandomValues(new Uint8Array(32)), url: workUrl("grief"), recipients: [judge.address] }, intent, griefer.address);
  const wrapped = blobLayout(1, blob.length).wrapped;
  blob[wrapped] = (blob[wrapped] ?? 0) ^ 0xff;
  const { announcement, instruction } = await buildAnnounceDelivery({ worker: griefer, intent, attestor: judge.address, commitment: new Uint8Array(32).fill(7), blob });
  await world.client.send([instruction], griefer);
  return { griefer, announcement };
}

describe("openings for a judge that holds only its key", () => {
  let served: Served | undefined;

  afterEach(async () => {
    await served?.close();
    served = undefined;
  });

  it("takes the work url from openings, fetches the work from a local server, hashes it and releases", async () => {
    const world = await createTestWorld();
    served = await serve({ "/spec.md": SPEC, "/work.txt": WORK });
    const { judge, intent } = await posted(world, served.host + "/spec.md");
    const worker = await world.wallet();
    const made = await world.client.announce({ worker, intent, sha256: hashOf(WORK), url: served.host + "/work.txt" });

    expect(await world.client.spec(intent)).toMatchObject({ text: SPEC, matches: true });
    const { opening, skipped } = await world.client.openings({ intent, keypair: judge.keypair });
    expect(opening).toEqual({ announcement: made.announcement, seq: 1n, worker: worker.address, salt: made.salt, url: served.host + "/work.txt" });
    expect(skipped).toEqual([]);
    const work = new Uint8Array(await (await fetch(opening?.url ?? "")).arrayBuffer());
    expect(new TextDecoder().decode(work)).toContain("rain");
    const first = await world.client.firstOpening({ intent, sha256: hashOf(work), keypair: judge.keypair });
    expect(first).toMatchObject({ announcement: opening?.announcement, salt: opening?.salt, url: opening?.url });
    const signature = await world.client.settleProof({ judge, intent, announcement: first.announcement, opening: first, result: 1n });

    const released = (await world.client.history(intent)).events.find(({ name }) => name === "IntentAttested");
    expect(released).toMatchObject({ signature, deliveredSha256: hashOf(WORK) });
    expect(await world.tokenBalance(worker.address, NATIVE_MINT)).toBeGreaterThan(0n);
    expect(served.asked).toEqual(["/spec.md", "/work.txt"]);
  });

  it("passes over a griefer's blob that does not open, and refuses like firstOpening while the key is not given or the list is incomplete", async () => {
    const world = await createTestWorld();
    const { judge, intent } = await posted(world, workUrl("spec.md"));
    const { griefer, announcement: grief } = await griefed(world, intent, judge);
    expect(await world.client.openings({ intent, keypair: judge.keypair })).toEqual({ intent, opening: null, skipped: [{ announcement: grief, seq: 1n, worker: griefer.address, reason: "does-not-open" }] });
    const honest = await world.wallet();
    const made = await world.client.announce({ worker: honest, intent, sha256: hashOf(WORK), url: workUrl() });

    const walked = await world.client.openings({ intent, keypair: judge.keypair });
    expect(walked).toEqual({
      intent,
      opening: { announcement: made.announcement, seq: 2n, worker: honest.address, salt: made.salt, url: workUrl() },
      skipped: [{ announcement: grief, seq: 1n, worker: griefer.address, reason: "does-not-open" }],
    });
    const first = await world.client.firstOpening({ intent, sha256: hashOf(WORK), keypair: judge.keypair });
    expect(walked.skipped).toEqual(first.skipped);

    const unkeyed = await world.client.openings({ intent }).catch((error: unknown) => error);
    const unkeyedFirst = await world.client.firstOpening({ intent, sha256: hashOf(WORK) }).catch((error: unknown) => error);
    expect(unkeyed).toBeInstanceOf(FirstOpeningRefused);
    expect(unkeyedFirst).toBeInstanceOf(FirstOpeningRefused);
    const { sha256: _, message: __, ...same } = unkeyedFirst as FirstOpeningRefused;
    expect(unkeyed).toMatchObject({ ...same, reason: "key-not-given", announcement: grief, seq: 1n, worker: griefer.address, sha256: null });
    expect((unkeyed as Error).message).toContain("so the earliest delivery cannot be known; pass that key; nothing was sent");

    await world.client.settleProof({ judge, intent, announcement: first.announcement, opening: first, result: 1n });
    const closed = await world.client.openings({ intent, keypair: judge.keypair }).catch((error: unknown) => error);
    expect(closed).toBeInstanceOf(FirstOpeningRefused);
    expect(closed).toMatchObject({ reason: "incomplete", closed: true, sha256: null });
  });

  it("lists an open escrow nobody announced to as complete and empty, so a judge polling it hears nothing yet, and a closed one as closed", async () => {
    const world = await createTestWorld();
    const { judge, intent } = await posted(world, workUrl("spec.md"));
    const reviewer = await connect({ cluster: "devnet", signer: judge, transport: world.transport });
    expect(await world.client.announcements(intent)).toMatchObject({ announcements: [], nextSeq: 1n, complete: true, closed: false, missing: [] });
    expect(await world.client.openings({ intent, keypair: judge.keypair })).toEqual({ intent, opening: null, skipped: [] });
    expect(await reviewer.openings({ escrow: intent, keypair: judge.keypair })).toEqual({ intent, opening: null, skipped: [] });
    const first = await world.client.firstOpening({ intent, sha256: hashOf(WORK), keypair: judge.keypair }).catch((error: unknown) => error);
    expect(first).toBeInstanceOf(FirstOpeningRefused);
    expect(first).toMatchObject({ reason: "nothing-opens", closed: false, missing: [] });

    world.warp(DEFAULT_EXPIRES_IN + 1n);
    expect(await world.client.announcements(intent)).toMatchObject({ announcements: [], complete: false, closed: true });
    const closed = await world.client.openings({ intent, keypair: judge.keypair }).catch((error: unknown) => error);
    expect(closed).toMatchObject({ reason: "incomplete", closed: true, sha256: null });
    expect((closed as Error).message).toContain("is no longer open, so its announcements may have been closed");
    expect(await world.client.firstOpening({ intent, sha256: hashOf(WORK), keypair: judge.keypair }).catch((error: unknown) => error)).toMatchObject({ reason: "incomplete", closed: true });
  });

  it("gives the simple layer the same openings and, with the key alone, each delivery's url without its hash", async () => {
    expect(SIMPLE_PAGE).toContain(DELIVERIES);
    expect(SIMPLE_PAGE).toContain(OPENINGS);
    const world = await createTestWorld();
    served = await serve({ "/work.txt": WORK });
    const { judge, intent } = await posted(world, workUrl("spec.md"));
    const worker = await world.wallet();
    const made = await world.client.announce({ worker, intent, sha256: hashOf(WORK), url: served.host + "/work.txt" });
    const reviewer = await connect({ cluster: "devnet", signer: judge, transport: world.transport });
    const keypair = judge.keypair;

    const delivery = { worker: worker.address, announcement: made.announcement, seq: 1n };
    expect(await reviewer.deliveries({ escrow: intent, keypair })).toEqual([{ ...delivery, sha256: null, url: served.host + "/work.txt", opened: true }]);
    expect(await reviewer.deliveries({ escrow: intent })).toEqual([{ ...delivery, sha256: null, url: null, opened: false }]);
    expect(await reviewer.openings({ escrow: intent, keypair })).toEqual(await world.client.openings({ intent, keypair }));

    const [listed] = await reviewer.deliveries({ escrow: intent, keypair });
    const work = new Uint8Array(await (await fetch(listed?.url ?? "")).arrayBuffer());
    expect(await reviewer.deliveries({ escrow: intent, keypair, sha256: hashOf(work) })).toEqual([{ ...delivery, sha256: hashOf(WORK), url: served.host + "/work.txt", opened: true }]);
    await reviewer.release({ escrow: intent, deliveredSha256: hashOf(work), keypair });
    expect(await reviewer.deliveries({ escrow: intent })).toEqual([{ ...delivery, sha256: hashOf(WORK), url: null, opened: false }]);
  });
});
