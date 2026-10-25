import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { attestedResult, DEVNET_TEST_MINT, feeBpsFor, formatAmount, Kind, NATIVE_MINT, parseAmount, splitFees } from "@intent-engine/core";
import { connect } from "../src/index.js";
import { createTestWorld, DEVNET_FEES } from "../src/testing.js";
import { workUrl } from "./work.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const PAGE = readFileSync(`${ROOT}/docs/sdk-client.md`, "utf8");
const NET =
  "each with its `specUrl`, its `judgeFee` and its `net`: what the worker receives if paid now, after the judge fee, the protocol fee and any partner fee, as a release splits them, or `null` while the engine could not release it.";
const FILTER = "- `jobs` keeps only the escrows that match every field its filter gives of `attestor`, `mint`, `minSells`, `owner`, `excludeOwners` and `unclaimed`.";
const PARTNER_BPS = 40;
const WORK = createHash("sha256").update("the work").digest("hex");

describe("what a job listing says a worker earns", () => {
  it("jobs reports as net what the release then pays the worker, after the judge fee, the protocol fee and a partner fee", async () => {
    expect(PAGE).toContain(NET);
    const world = await createTestWorld();
    const [owner, judge, worker, partner] = [await world.wallet(), await world.wallet(), await world.wallet(), await world.wallet()];
    const amountIn = parseAmount("0.5", 9);
    const judgeFee = parseAmount("0.02", 9);
    const specHash = Uint8Array.from(createHash("sha256").update("the spec").digest());
    const params = attestedResult({ amountIn, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash, judgeFee });
    const { intent } = await world.client.createIntent({ signer: owner, inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT, params, partner: partner.address, partnerBps: PARTNER_BPS });

    const { jobs: [job] } = await world.client.jobs({ attestor: judge.address });
    const { net, partner: partnerFee, protocol } = splitFees(amountIn - judgeFee, feeBpsFor(DEVNET_FEES, Kind.AttestedResult), PARTNER_BPS, DEVNET_FEES.partnerCutBps);
    expect(job).toMatchObject({ intent, sells: amountIn, judgeFee, net });
    expect(partnerFee).toBeGreaterThan(0n);
    expect(protocol).toBeGreaterThan(0n);
    const seller = await connect({ cluster: "devnet", signer: worker, transport: world.transport });
    expect((await seller.findWork({ judge: judge.address }))[0]).toMatchObject({ intent, amount: "0.5", judgeFee: "0.02", net: formatAmount(net, 9), token: "SOL" });

    await world.client.announce({ worker, intent, sha256: WORK, url: workUrl() });
    const first = await world.client.firstOpening({ intent, sha256: WORK, keypair: judge.keypair });
    await world.client.settleProof({ judge, intent, announcement: first.announcement, opening: first, result: 1n });
    expect(await world.tokenBalance(worker.address, NATIVE_MINT)).toBe(job?.net);
    const released = (await world.client.history(intent)).events.find(({ name }) => name === "IntentAttested");
    expect(released?.name === "IntentAttested" ? released.fields.net : null).toBe(job?.net);
    expect(await world.tokenBalance(judge.address, NATIVE_MINT)).toBe(judgeFee);
  });

  it(FILTER.slice(2), async () => {
    expect(PAGE).toContain(FILTER);
    const world = await createTestWorld();
    const [owner, other, judge] = [await world.wallet(), await world.wallet(), await world.wallet()];
    const specHash = Uint8Array.from(createHash("sha256").update("the spec").digest());
    const params = attestedResult({ amountIn: parseAmount("0.5", 9), minResult: 1n, maxResult: 1n, attestor: judge.address, specHash, judgeFee: 0n });
    const { intent } = await world.client.createIntent({ signer: owner, inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT, params });
    const listed = async (filter: Parameters<typeof world.client.jobs>[0]) => (await world.client.jobs(filter)).jobs.map((job) => job.intent);
    expect(await listed({ attestor: judge.address, mint: NATIVE_MINT, minSells: parseAmount("0.5", 9), owner: owner.address, excludeOwners: [other.address], unclaimed: true })).toEqual([intent]);
    expect(await listed({ attestor: other.address })).toEqual([]);
    expect(await listed({ mint: DEVNET_TEST_MINT })).toEqual([]);
    expect(await listed({ minSells: parseAmount("0.6", 9) })).toEqual([]);
    expect(await listed({ owner: other.address })).toEqual([]);
    expect(await listed({ excludeOwners: [owner.address] })).toEqual([]);
  });
});
