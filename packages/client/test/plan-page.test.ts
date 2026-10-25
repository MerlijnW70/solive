import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEVNET_TEST_MINT, IntentStatus, NATIVE_MINT, swapExactIn } from "@intent-engine/core";
import { MAX_PARTNER_BPS } from "@intent-engine/core/internal";
import { type Client, InvalidInput } from "../src/index.js";
import { checkedQuery, PAY_TO_NOT_ATTESTED, RECLAIM_BATCH } from "../src/internal.js";
import { createTestWorld } from "../src/testing.js";
import { PLAN_SECTION } from "./doc-sections.js";
import { checkCase, delivered, escrow, proofParams, sha, statusOf, workUrl } from "./plan-driver.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const PAGE = readFileSync(`${ROOT}/docs/sdk-client.md`, "utf8");
const SECTION = PLAN_SECTION.exec(PAGE)?.[0] ?? "";
const BLOCKS = [...SECTION.matchAll(/^```ts\n([\s\S]*?)^```$/gm)].map((m) => m[1] ?? "");
const PRINTED = [...SECTION.matchAll(/\bprints `([^`]+)`/g)].map((m) => m[1] ?? "");
const ENTRY = { "@intent-engine/client/testing": "../src/testing.js", "@intent-engine/client": "../src/index.js" };
const pageModule = fileURLToPath(new URL(`./.plan-page-${process.pid}.ts`, import.meta.url));

const WRITES = [
  "createIntent",
  "cancel",
  "fill",
  "expire",
  "close",
  "settleProof",
  "settleCommittee",
  "settleSplit",
  "announce",
  "refute",
  "reclaim",
  "closeBook",
  "feedback",
  "createCommittee",
  "unwrap",
] as const;

const CLAIMS = {
  methods: `\`client.plan\` has one method per write: ${WRITES.slice(0, -1).map((name) => `\`${name}\``).join(", ")} and \`${WRITES.at(-1)}\`.`,
  shape: "A plan names the `payer`, the `setup` instructions that land first, the `instructions`, the signers each one needs in `setupSigners` and `signers`, and the `lookupTables` it relies on, which are none.",
  sends: "Each write sends its own plan, `setup` first, and refuses a signer that is not the plan's `payer`.",
  empty: "`reclaim` splits its instructions into `batches`, one transaction each. A plan with no instructions sends nothing: `unwrap` with nothing wrapped, `createCommittee` for a committee that exists, `announce` for an announcement made before.",
  ref: "Every call that names one intent takes its address or `{ owner, nonce }`.",
  terms: `\`createIntent\` takes \`partner\` with \`partnerBps\`, from 1 to ${MAX_PARTNER_BPS}, a partner fee each fill pays, and \`payTo\`, the wallet that receives what a swap, limit order or auction buys; a proof escrow takes no \`payTo\`.`,
  amounts: "`amount` turns decimal text into base units at the mint's decimals and refuses a negative, a non-number or too many decimals with `InvalidInput`; `format` turns base units back into text.",
};

const READS = {
  intents: `- \`intents\` returns the intents that match every field its filter gives of ${Object.keys(checkedQuery({}))
    .slice(0, -1)
    .map((name) => `\`${name}\``)
    .join(", ")} and \`attestor\`; the node applies the filter.`,
  history: "`history` returns a page of an intent's `events`, newest first, also after it closes, and `next`: pass it as `before` for the next older page, until it is `null`.",
  expire: "Both take the signer, then the intent.",
};

const local = (code: string): string => Object.entries(ENTRY).reduce((text, [name, path]) => text.replaceAll(`"${name}"`, JSON.stringify(path)), code);

describe("the plan section of the client page", () => {
  afterEach(() => {
    rmSync(pageModule, { force: true });
  });

  it("states exactly the claims these tests assert, and the read sentences the other tests pin", () => {
    const bullets = [...SECTION.matchAll(/^- (.+)$/gm)].map((m) => m[1]);
    expect(bullets).toEqual(Object.values(CLAIMS));
    for (const sentence of Object.values(READS)) {
      expect(PAGE).toContain(sentence);
    }
    expect(Object.keys(checkedQuery({})).at(-1)).toBe("attestor");
  });

  it(CLAIMS.methods, async () => {
    const world = await createTestWorld();
    expect(Object.keys(world.client.plan).sort()).toEqual([...WRITES].sort());
    for (const name of WRITES) {
      expect(typeof (world.client as unknown as Record<string, unknown>)[name]).toBe("function");
    }
  });

  it(CLAIMS.shape, async () => {
    const world = await createTestWorld();
    const job = await escrow(world);
    const worker = await world.wallet();
    const plans = [
      await world.client.plan.cancel(job.owner, job.intent),
      await world.client.plan.announce({ worker, intent: job.intent, sha256: sha("shaped"), url: workUrl() }),
      await world.client.plan.unwrap(worker),
    ];
    for (const plan of plans) {
      expect(plan).toMatchObject({ lookupTables: {} });
      expect(plan.signers).toHaveLength(plan.instructions.length);
      expect(plan.setupSigners).toHaveLength(plan.setup.length);
      expect(typeof plan.payer).toBe("string");
    }
    expect(await world.client.announcements(job.intent)).toMatchObject({ announcements: [] });
    expect(await statusOf(world, job.intent)).toBe(IntentStatus.Open);
  });

  it(CLAIMS.sends, async () => {
    const world = await createTestWorld();
    await checkCase(world, {
      lane: (w) => escrow(w),
      plan: (client, { owner, intent }) => client.plan.cancel(owner, intent),
      write: (client, { owner, intent }) => client.cancel(owner, intent),
      payer: ({ owner }) => owner,
      observe: async (w, { intent }) => statusOf(w, intent),
    });
    const job = await escrow(world);
    const stranger = await world.wallet();
    await expect(world.client.cancel(stranger, job.intent)).rejects.toBeInstanceOf(InvalidInput);
  });

  it(CLAIMS.empty, async () => {
    const world = await createTestWorld();
    const worker = await world.wallet();
    for (let i = 0; i <= RECLAIM_BATCH; i++) {
      const job = await escrow(world);
      await delivered(world, job.intent, worker);
      await world.client.cancel(job.owner, job.intent);
    }
    const plan = await world.client.plan.reclaim({ worker });
    expect(plan.batches.map((batch) => batch.length)).toEqual([RECLAIM_BATCH, 1]);
    expect(plan.batches.flat()).toEqual(plan.instructions);
    expect((await world.client.reclaim({ worker })).signatures).toHaveLength(2);
    expect(await world.client.plan.unwrap(await world.wallet())).toMatchObject({ setup: [], instructions: [] });
    const payer = await world.wallet();
    const terms = { payer, members: [payer.address, worker.address], threshold: 2, feeWallet: payer.address };
    await world.client.createCommittee(terms);
    expect(await world.client.plan.createCommittee(terms)).toMatchObject({ setup: [], instructions: [] });
    expect(await world.client.createCommittee(terms)).toMatchObject({ signature: null });
    const job = await escrow(world);
    const work = { worker, intent: job.intent, sha256: sha("once"), url: workUrl() };
    await world.client.announce(work);
    expect(await world.client.plan.announce(work)).toMatchObject({ setup: [], instructions: [], existing: { worker: worker.address } });
    expect(await world.client.announce(work)).toMatchObject({ signature: null });
  });

  it(CLAIMS.ref, async () => {
    const world = await createTestWorld();
    const job = await escrow(world);
    const ref = { owner: job.owner.address, nonce: job.nonce };
    const reads = async (client: Client, named: typeof ref | typeof job.intent) =>
      Promise.all([client.intent(named), client.fillOf(named), client.claims(named), client.announcements(named), client.history(named)]);
    expect(await reads(world.client, ref)).toEqual(await reads(world.client, job.intent));
    const worker = await world.wallet();
    const made = await world.client.announce({ worker, intent: ref, sha256: sha("by ref"), url: workUrl() });
    const first = await world.client.firstOpening({ intent: ref, sha256: sha("by ref"), keypair: job.judge.keypair });
    expect(first.announcement).toBe(made.announcement);
    await world.client.settleProof({ judge: job.judge, intent: ref, announcement: first.announcement, opening: first, result: 1n });
    expect(await statusOf(world, job.intent)).toBe(IntentStatus.Filled);
    await world.client.feedback({ owner: job.owner, intent: ref, score: 70 });
    expect((await world.client.reputation(worker.address)).feedback.count).toBe(1);
  });

  it(CLAIMS.terms, async () => {
    const world = await createTestWorld();
    const owner = await world.wallet();
    const partner = (await world.wallet()).address;
    const order = { signer: owner, inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT };
    const plan = await world.client.plan.createIntent({ ...order, params: swapExactIn({ amountIn: 1_000_000n, minOut: 5n }), partner, partnerBps: MAX_PARTNER_BPS, payTo: partner });
    expect(plan.payTo).toBe(partner);
    await expect(world.client.plan.createIntent({ ...order, params: swapExactIn({ amountIn: 1_000_000n, minOut: 5n }), partner, partnerBps: MAX_PARTNER_BPS + 1 })).rejects.toMatchObject({ field: "partnerBps" });
    await expect(world.client.plan.createIntent({ ...order, params: proofParams(partner), payTo: partner })).rejects.toMatchObject({ message: PAY_TO_NOT_ATTESTED });
  });

  it(CLAIMS.amounts, async () => {
    const world = await createTestWorld();
    expect(await world.client.amount(NATIVE_MINT, "2.5")).toBe(2_500_000_000n);
    expect(await world.client.format(NATIVE_MINT, 2_500_000_000n)).toBe("2.5");
    for (const text of ["-2", "two", "0.0000000001"]) {
      await expect(world.client.amount(NATIVE_MINT, text)).rejects.toBeInstanceOf(InvalidInput);
    }
  });

  it("runs the example, which sends its plan through kit calls and no client write, and prints what it says", { timeout: 120_000 }, async () => {
    expect(BLOCKS).toHaveLength(1);
    const code = BLOCKS[0] ?? "";
    expect(code).toContain("world.client.plan.createIntent(");
    expect(code).toContain("signTransactionMessageWithSigners");
    expect(code).not.toMatch(/client\.(send|createIntent)\(/);
    expect(SECTION).toContain("kit's `sendAndConfirmTransactionFactory`");
    expect(typeof (await import("@solana/kit")).sendAndConfirmTransactionFactory).toBe("function");
    const printed: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    });
    writeFileSync(pageModule, local(code));
    try {
      await import(pathToFileURL(pageModule).href);
    } finally {
      log.mockRestore();
    }
    expect(printed).toEqual(PRINTED);
    expect(PRINTED).toEqual(["Open 0.5"]);
  });
});
