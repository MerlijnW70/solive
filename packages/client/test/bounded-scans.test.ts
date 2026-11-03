import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Address, generateKeyPairSigner, getAddressDecoder, getAddressEncoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { Kind, NATIVE_MINT } from "@intent-engine/core";
import { refutationAddress, signMessageBytes } from "@intent-engine/core/internal";
import { createClient, InvalidInput, NotRefutable } from "../src/index.js";
import { loadAnnouncement } from "../src/announcement-reads.js";
import { confirmOnBoth } from "../src/confirm-release.js";
import { earliestFunder, FUNDING_TOTAL } from "../src/funding.js";
import { HELD_ANNOUNCEMENTS, HELD_CONCURRENCY, HELD_READS, heldPastLimit, heldReadsSpent, releaseUnread } from "../src/held-shares.js";
import { SIGNATURE_PAGE } from "../src/job-scan.js";
import { testSignature } from "../src/testing.js";
import type { EngineTransaction, ListedSignature, Transport } from "../src/transport.js";
import { heldWorld, SHARES } from "./held.js";
import { world } from "./svm.js";
import { announced, fundedSigner, keyed, LOCAL, nativeMint, sha, specHash, workUrl } from "./work.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const PAID_AT = 264;
const WORKER_AT = 40;
const COUNTS = ["none", "one", "two", "three", "four", "five", "six", "seven", "eight"];
const CLONES = HELD_ANNOUNCEMENTS + 36;
const RUNAWAY = 50_000;

const key = (byte: number): Address => getAddressDecoder().decode(new Uint8Array(32).fill(byte));
const STRANGER = key(70);

const shifted = (data: Uint8Array, by: bigint): Uint8Array => {
  const copy = Uint8Array.from(data);
  const view = new DataView(copy.buffer);
  view.setBigInt64(PAID_AT, view.getBigInt64(PAID_AT, true) + by, true);
  copy.set(getAddressEncoder().encode(STRANGER), WORKER_AT);
  return copy;
};

async function paddedCluster(clones: number, shift: bigint, padding: number, drift = 0n, older = 0) {
  const held = await heldWorld();
  const paid = await held.release(held.memoRequired);
  const base = held.w.chain.transport;
  const real = (await base.getAccount(paid.announcement)) ?? undefined;
  const paidAt = (await loadAnnouncement(base, paid.announcement))?.paidAt ?? 0n;
  expect(real).toBeDefined();
  const fakes = await Promise.all(Array.from({ length: clones }, async () => (await generateKeyPairSigner()).address));
  const padded = new Set(fakes);
  const newer = Array.from({ length: padding }, (_, i): ListedSignature => ({ signature: testSignature(`newer ${i}`), slot: 1n, blockTime: paidAt + 1n + BigInt(i % 7), failed: false, memo: null }));
  const earlier = Array.from({ length: older }, (_, i): ListedSignature => ({ signature: testSignature(`older ${i}`), slot: 1n, blockTime: paidAt - 2n, failed: false, memo: null }));  const counts = { reads: 0, inFlight: 0, most: 0, read: new Set<Address>() };
  const spend = (count: number) => {
    counts.reads += count;
    if (counts.reads > RUNAWAY) {
      throw new Error("the held share listing read past any bound");
    }
  };
  const listing = base.engineAccounts as NonNullable<Transport["engineAccounts"]>;
  const signatures = base.signaturesOf as NonNullable<Transport["signaturesOf"]>;
  const transport: Transport = {
    ...base,
    engineAccounts: async (filter) => [
      ...(await listing.call(base, filter)),
      ...fakes.map((address) => ({ address, lamports: real?.lamports ?? 0n, data: shifted(real?.data ?? new Uint8Array(), shift) })),
    ],
    signaturesOf: async (of, limit, before, until) => {
      spend(1);
      counts.read.add(of);
      counts.inFlight++;
      counts.most = Math.max(counts.most, counts.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      counts.inFlight--;
      if (padded.has(of)) {
        return Array.from({ length: SIGNATURE_PAGE }, (_, i): ListedSignature => ({ signature: testSignature(`${of} ${before ?? ""} ${i}`), slot: 1n, blockTime: null, failed: false, memo: null }));
      }
      if (of !== paid.announcement) {
        return signatures.call(base, of, limit, before, until);
      }
      const own = (await signatures.call(base, of, SIGNATURE_PAGE)).map((entry) => ({ ...entry, blockTime: entry.blockTime === null ? null : entry.blockTime + drift }));
      const all = [...newer, ...own, ...earlier];
      const from = before === undefined ? 0 : all.findIndex(({ signature }) => signature === before) + 1;
      return all.slice(from, from + limit);
    },
    transactionsOf: async (listed) => {
      spend(listed.length);
      const known = await (base.transactionsOf as NonNullable<Transport["transactionsOf"]>).call(base, listed);
      const found = new Set(known.map(({ signature }) => signature));
      return [...known, ...listed.filter(({ signature }) => !found.has(signature)).map(({ signature }): EngineTransaction => ({ signature, slot: 1n, blockTime: null, failed: false, emitted: [] }))];
    },
  };
  return { ...held, paid, fakes, counts, client: createClient({ url: LOCAL, transport }) };
}

describe("heldShares on a cluster padded with held announcements", () => {
  it("reads a bounded history in a few lanes, still lists the newest share and says it is incomplete", async () => {
    const { blocked, paid, fakes: clones, counts, client } = await paddedCluster(CLONES, -1n, 0);
    const listed = await client.heldShares(blocked.address);
    expect(counts.reads).toBeLessThanOrEqual(HELD_ANNOUNCEMENTS * HELD_READS);
    expect(counts.most).toBeGreaterThan(1);
    expect(counts.most).toBeLessThanOrEqual(HELD_CONCURRENCY);
    expect(listed.complete).toBe(false);
    expect(listed.shares).toEqual([expect.objectContaining({ announcement: paid.announcement, index: 1, amount: SHARES[1] })]);
    expect(listed.reasons).toContain(heldPastLimit(CLONES + 1 - HELD_ANNOUNCEMENTS, HELD_ANNOUNCEMENTS));
    expect(listed.reasons.filter((reason) => clones.some((clone) => reason === heldReadsSpent(clone, HELD_READS)))).toHaveLength(HELD_ANNOUNCEMENTS - 1);
  });

  it("finds the release of an announcement padded with many newer transactions within its read budget", async () => {
    const padding = 3 * SIGNATURE_PAGE + 17;
    const { blocked, paid, counts, client } = await paddedCluster(0, 0n, padding);
    const listed = await client.heldShares(blocked.address);
    expect(listed).toMatchObject({ complete: true, reasons: [] });
    expect(listed.shares).toEqual([expect.objectContaining({ announcement: paid.announcement, index: 1, amount: SHARES[1] })]);
    expect(counts.reads).toBeLessThanOrEqual(HELD_READS);
  });

  it("stops at the first signature older than the paid time and says the release was not found", async () => {
    const { blocked, paid, counts, client } = await paddedCluster(0, 0n, 0, -1n, 3 * SIGNATURE_PAGE);
    const listed = await client.heldShares(blocked.address);
    expect(listed).toMatchObject({ complete: false, shares: [], reasons: [releaseUnread(paid.announcement)] });
    expect(counts.reads).toBe(1);
  });

  it("reads the announcements the wallet made itself before newer ones past the limit", async () => {
    const { announcer, paid, counts, client } = await paddedCluster(CLONES, 1n, 0);
    const listed = await client.heldShares(announcer.address);
    expect(counts.read.has(paid.announcement)).toBe(true);
    expect(listed.shares).toEqual([]);
    expect(listed.reasons).toContain(heldPastLimit(CLONES + 1 - HELD_ANNOUNCEMENTS, HELD_ANNOUNCEMENTS));
    expect(listed.reasons.some((reason) => reason.includes(paid.announcement))).toBe(false);
  });
});

describe("the funder of a padded payer", () => {
  it("stops at a hard total of reads when every transaction carries a zero-lamport transfer in", async () => {
    const wallet = key(50);
    const funder = key(51);
    const padder = key(52);
    const length = FUNDING_TOTAL + 40;
    const newestFirst = Array.from({ length }, (_, i): ListedSignature => ({ signature: testSignature(`padded ${length - i}`), slot: BigInt(length - i), blockTime: null, failed: false, memo: null }));
    const fundedAt = newestFirst[0]?.signature;
    let reads = 0;
    const transport = {
      signaturesOf: async (_of: Address, limit: number, before?: string) => {
        const from = before === undefined ? 0 : newestFirst.findIndex((entry) => entry.signature === before) + 1;
        return newestFirst.slice(from, from + limit);
      },
      transactionsOf: async (batch: readonly ListedSignature[]) => {
        reads += batch.length;
        return batch.map(({ signature }): EngineTransaction => ({
          signature,
          slot: 1n,
          blockTime: null,
          failed: false,
          emitted: [],
          transfers: [signature === fundedAt ? { from: funder, to: wallet, lamports: 5n } : { from: padder, to: wallet, lamports: 0n }],
        }));
      },
    } as unknown as Transport;
    expect(await earliestFunder(transport, wallet, async () => true)).toStrictEqual({ funder: null, complete: false });
    expect(reads).toBe(FUNDING_TOTAL);
  });
});

describe("refute of a split release", () => {
  it("refuses a claim whose recipients and weights are not the release's split, and sends nothing", async () => {
    const w = await world();
    nativeMint(w);
    let sends = 0;
    const base = w.chain.transport;
    const transport: Transport = {
      ...base,
      send: async (instructions, payer) => {
        sends++;
        return base.send(instructions, payer);
      },
      sendWire: async (wire, latest) => {
        sends++;
        return base.sendWire(wire, latest);
      },
      submitWire: async (wire) => {
        sends++;
        return base.submitWire(wire);
      },
    };
    const client = createClient({ url: LOCAL, transport });
    const judge = await keyed(w);
    const owner = await fundedSigner(w);
    const work = sha("the split work refuted with a wrong claim");
    const params = { kind: Kind.AttestedResult, amountIn: 1_000_000n, minResult: 1n, maxResult: 1n, attestor: judge.signer.address, specHash: specHash("the wrong claim spec"), judgeFee: 0n } as const;
    const { nonce, intent } = await client.createIntent({ signer: owner, params, inputMint: NATIVE_MINT, outputMint: w.outputMint });
    const [early, front, ring] = [await fundedSigner(w), await fundedSigner(w), await fundedSigner(w)];
    const earlier = await announced(client, early, intent, work, workUrl("first.tar"));
    const paid = await announced(client, front, intent, work, workUrl("copied.tar"));
    const claim = { recipients: [front.address, ring.address], weights: [100, 9_900] };
    const target = { intent: { owner: owner.address, nonce }, ...paid, result: 1n, recipients: claim.recipients.map((wallet, i) => ({ wallet, weight: claim.weights[i] ?? 0 })) };
    const ballot = await client.splitBallot(target);
    const signatures = await Promise.all([front, ring].map(async (signer) => ({ wallet: signer.address, signature: await signMessageBytes(signer, ballot.message) })));
    await client.settleSplit({ ...target, judge: judge.signer, signatures, payer: owner });
    const input = { worker: early, earlier: earlier.announcement, paid: paid.announcement, sha256: work, url: workUrl("first.tar") };
    const wrong = [
      { recipients: claim.recipients, weights: [9_900, 100] },
      { recipients: [ring.address, front.address], weights: claim.weights },
      { recipients: [front.address], weights: claim.weights },
    ];
    for (const mismatched of wrong) {
      const before = sends;
      await expect(client.refute({ ...input, claim: mismatched })).rejects.toBeInstanceOf(NotRefutable);
      expect(sends).toBe(before);
    }
    expect(await base.getAccount(await refutationAddress(earlier.announcement))).toBeNull();
    const { refutation } = await client.refute({ ...input, claim });
    expect(refutation).toBe(await refutationAddress(earlier.announcement));
  });
});

describe("confirmOnBoth with payees", () => {
  it("refuses payees without the sha256 or the attestor that find the earliest announcer, before reading either node", async () => {
    const intent = key(60);
    let reads = 0;
    const node = new Proxy({} as Transport, {
      get: () => async () => {
        reads++;
        throw new Error("a refused target reads no node");
      },
    });
    for (const target of [
      { intent, payees: [key(61)] },
      { intent, attestor: key(62), payees: [key(61)] },
      { intent, sha256: "ab".repeat(32), payees: [key(61)] },
    ]) {
      await expect(confirmOnBoth(node, node, target)).rejects.toBeInstanceOf(InvalidInput);
    }
    expect(reads).toBe(0);
  });
});

describe("the bounds docs/sdk-client.md names", () => {
  it("are the bounds the held share listing uses", () => {
    const page = readFileSync(`${ROOT}/docs/sdk-client.md`, "utf8");
    expect(page).toContain(
      `It reads at most ${HELD_ANNOUNCEMENTS} announcements holding shares, the wallet's own and the newest first, ${COUNTS[HELD_CONCURRENCY]} at a time, with at most ${HELD_READS} history reads each.`,
    );
    expect(page).toContain(`newer transactions cost one read per ${SIGNATURE_PAGE} signatures`);
  });
});
