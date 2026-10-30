import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner, type KeyPairSigner, lamports } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { Kind, NATIVE_MINT } from "@intent-engine/core";
import { findIntentPda } from "@intent-engine/core/internal";
import { createClient, type Transport } from "../src/index.js";
import { HISTORY_LIMIT } from "../src/client-types.js";
import { eventAuthority } from "../src/release-reads.js";
import { svmTransport } from "../src/svm.js";
import { type Announced, announcedBy, historyCut, type RecordReads, recordOf } from "../src/work-records.js";
import { comparatorsUsedBy, verdicts } from "./kill-client-trust-work-sort.js";
import { world } from "./svm.js";
import { announced, LOCAL, nativeMint } from "./work.js";

const SOL = 1_000_000_000n;
const SPEC = new Uint8Array(createHash("sha256").update("the record spec").digest());

async function setup() {
  const w = await world();
  nativeMint(w);
  const transport = svmTransport(w.chain.svm);
  const client = createClient({ url: LOCAL, transport });
  const fresh = async () => {
    const signer = await generateKeyPairSigner();
    w.chain.svm.airdrop(signer.address, lamports(10n * SOL));
    return signer;
  };
  const escrow = async (owner: KeyPairSigner, attestor: Address) => {
    const { nonce } = await client.createIntent({
      signer: owner,
      params: { kind: Kind.AttestedResult, amountIn: 1_000_000n, minResult: 1n, maxResult: 1n, attestor, specHash: SPEC, judgeFee: 0n },
      inputMint: NATIVE_MINT,
      outputMint: w.outputMint,
    });
    const [intent] = await findIntentPda({ owner: owner.address, nonce });
    return { nonce, intent };
  };
  const worksOf = async (worker: Address, of: Address): Promise<Announced[]> => {
    const by = await eventAuthority();
    const found = announcedBy(worker, await transport.engineTransactions(HISTORY_LIMIT, of), by).find(([first]) => first?.intent === of);
    if (found === undefined) {
      throw new Error("the worker announced nothing on the escrow");
    }
    return found;
  };
  const reads = async (covered: () => Promise<boolean> = async () => true): Promise<RecordReads> => ({ pages: 100, history: HISTORY_LIMIT, by: await eventAuthority(), covered });
  return { w, transport, client, fresh, escrow, worksOf, reads };
}

const blind = (base: Transport, hidden: readonly Address[], gone: readonly Address[] = []): Transport => ({
  ...base,
  signaturesOf: async (of, limit, before) => (hidden.includes(of) ? [] : (base.signaturesOf?.call(base, of, limit, before) ?? [])),
  getAccount: async (address) => (gone.includes(address) ? null : base.getAccount(address)),
});

describe("announcedBy", () => {
  it("groups a wallet's announcements by escrow and orders each group by sequence, whatever order the history came in", async () => {
    const { client, transport, fresh, escrow } = await setup();
    const [owner, judge, worker] = await Promise.all([fresh(), fresh(), fresh()]);
    const { intent } = await escrow(owner, judge.address);
    const { intent: other } = await escrow(owner, judge.address);
    await announced(client, worker, intent, "a1".repeat(32));
    await announced(client, worker, other, "b2".repeat(32));
    await announced(client, worker, intent, "c3".repeat(32));
    await announced(client, worker, intent, "d4".repeat(32));
    const by = await eventAuthority();
    const history = await transport.engineTransactions(HISTORY_LIMIT, worker.address);
    for (const transactions of [history, [...history].reverse()]) {
      const groups = announcedBy(worker.address, transactions, by);
      expect(groups).toHaveLength(2);
      const mine = groups.find(([first]) => first?.intent === intent) ?? [];
      expect(mine).toHaveLength(3);
      expect(mine.map(({ seq }) => seq)).toEqual([...mine.map(({ seq }) => seq)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    }
  });

  it("orders announcements by sequence with a comparator that says less, greater and equal", async () => {
    const { client, transport, fresh, escrow } = await setup();
    const [owner, judge, worker] = await Promise.all([fresh(), fresh(), fresh()]);
    const { intent } = await escrow(owner, judge.address);
    await announced(client, worker, intent, "a1".repeat(32));
    await announced(client, worker, intent, "b2".repeat(32));
    const by = await eventAuthority();
    const history = await transport.engineTransactions(HISTORY_LIMIT, worker.address);
    const used = await comparatorsUsedBy(() => announcedBy(worker.address, history, by), "seq");
    expect(verdicts(used[0], (seq) => ({ seq }))).toEqual([-1, 1, 0]);
  });
});

describe("recordOf", () => {
  it("reads an escrow that is still open as open, and not as self-dealt", async () => {
    const { client, fresh, escrow, transport, worksOf, reads } = await setup();
    const [owner, judge, worker] = await Promise.all([fresh(), fresh(), fresh()]);
    const { intent } = await escrow(owner, judge.address);
    await announced(client, worker, intent, "a1".repeat(32));
    const { record, reasons } = await recordOf(transport, worker.address, await worksOf(worker.address, intent), await reads());
    expect(record).toMatchObject({ outcome: "open", selfDealt: false, role: "announcer", intent });
    expect(reasons).toEqual([]);
  });

  it("reads a release of another announcement of the same wallet, that the given works leave out, as paid to someone else", async () => {
    const { client, fresh, escrow, transport, worksOf, reads } = await setup();
    const [owner, judge, worker] = await Promise.all([fresh(), fresh(), fresh()]);
    const { nonce, intent } = await escrow(owner, judge.address);
    const first = await announced(client, worker, intent, "a1".repeat(32));
    const second = await announced(client, worker, intent, "b2".repeat(32));
    await client.settleProof({ judge, intent: { owner: owner.address, nonce }, ...second, result: 1n });
    const works = await worksOf(worker.address, intent);
    expect(works).toHaveLength(2);
    const left = works.filter(({ announcement }) => announcement === first.announcement);
    const { record } = await recordOf(transport, worker.address, left, await reads());
    expect(record).toMatchObject({ outcome: "paid-other", role: "announcer", announcement: first.announcement, selfDealt: false });
    expect(record.earned).toBeUndefined();
    const whole = await recordOf(transport, worker.address, works, await reads());
    expect(whole.record).toMatchObject({ outcome: "paid", role: "announcer", announcement: second.announcement });
    expect(whole.record.earned).toBeGreaterThan(0n);
  });

  it("says what it could not find when the node shows neither the release nor the announcement's history", async () => {
    const { client, fresh, escrow, transport, worksOf, reads } = await setup();
    const [owner, judge, worker] = await Promise.all([fresh(), fresh(), fresh()]);
    const { nonce, intent } = await escrow(owner, judge.address);
    const delivered = await announced(client, worker, intent, "a1".repeat(32));
    await client.settleProof({ judge, intent: { owner: owner.address, nonce }, ...delivered, result: 1n });
    const works = await worksOf(worker.address, intent);
    const noRelease = `escrow ${intent} shows no release, cancel or expiry`;
    const run = (gone: Address[], covered: () => Promise<boolean>) => reads(covered).then((read) => recordOf(blind(transport, [delivered.announcement, intent], gone), worker.address, works, read));
    const kept = await run([], async () => true);
    expect(kept.reasons).toEqual([historyCut(delivered.announcement), noRelease]);
    expect(kept.record).toMatchObject({ outcome: "unknown", selfDealt: false });
    expect((await run([delivered.announcement], async () => true)).reasons).toEqual([noRelease]);
    expect((await run([delivered.announcement], async () => false)).reasons).toEqual([historyCut(delivered.announcement), noRelease]);
  });

  it("reads a cancelled escrow whose account is gone as refunded, and one with no cancel, expiry or release as unknown", async () => {
    const { client, fresh, escrow, transport, worksOf, reads } = await setup();
    const [owner, judge, worker] = await Promise.all([fresh(), fresh(), fresh()]);
    const { nonce, intent } = await escrow(owner, judge.address);
    await announced(client, worker, intent, "a1".repeat(32));
    const works = await worksOf(worker.address, intent);
    const gone = blind(transport, [], [intent]);
    const open = await recordOf(gone, worker.address, works, await reads());
    expect(open.record).toMatchObject({ outcome: "unknown", selfDealt: false });
    expect(open.reasons).toEqual([`escrow ${intent} shows no release, cancel or expiry`]);
    await client.cancel(owner, { owner: owner.address, nonce });
    const cancelled = await recordOf(gone, worker.address, works, await reads());
    expect(cancelled.record).toMatchObject({ outcome: "refunded", selfDealt: false });
    expect(cancelled.reasons).toEqual([]);
  });
});
