import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { type Intent, IntentCoreError, Kind } from "@intent-engine/core";
import { CLAIMS_OPEN, CLAIMS_VERSION, claimBoardAddress, getClaimBoardEncoder, getIntentSize, kindBit, PAUSE_FILL } from "@intent-engine/core/internal";
import type { AccountView, ProgramAccount, Transport } from "../src/index.js";
import { CLOCK_SYSVAR } from "../src/accounts.js";
import { type PayTerms, releaseNet } from "../src/job-pay.js";
import { createdIn, historyCovers, intentAt, openProofEscrows, proofAt } from "../src/job-proofs.js";
import { BASE, cancelledEvent, clockView, createdEvent, engineView, intentBytes, key, OWNER, proofIntent, tx } from "./kill-client-jobs-ledger-kit.js";

const TERMS: PayTerms = { feeBps: 0, kindFeeMask: 0, kindFeeBps: [], paused: 0, fillDisabledKinds: 0n };
const NONE = "11111111111111111111111111111111" as Address;
const NOW = 500n;

describe("the net a proof escrow pays on release", () => {
  it("pays what is left when nothing stops a release", () => {
    expect(releaseNet(proofIntent(), TERMS)).toBe(100n);
  });

  it("pays nothing while fills are paused, proof fills are off or the escrow carries an agent fee, each on its own", () => {
    expect(releaseNet(proofIntent(), { ...TERMS, paused: PAUSE_FILL })).toBeNull();
    expect(releaseNet(proofIntent(), { ...TERMS, fillDisabledKinds: kindBit(Kind.AttestedResult) })).toBeNull();
    expect(releaseNet(proofIntent({ agentFee: 1n }), TERMS)).toBeNull();
  });

  it("reads the terms of an escrow filled to the brim, refusing terms that do not decode, and skips one filled past it", () => {
    expect(releaseNet(proofIntent({ escrowed: 100n, filled: 100n }), TERMS)).toBeNull();
    expect(() => releaseNet(proofIntent({ escrowed: 100n, filled: 100n }, { amountIn: 0n }), TERMS)).toThrow(new IntentCoreError("InvalidParams"));
    expect(releaseNet(proofIntent({ escrowed: 100n, filled: 101n }, { amountIn: 0n }), TERMS)).toBeNull();
  });

  it("pays the escrowed amount less what was filled", () => {
    expect(releaseNet(proofIntent({ escrowed: 100n, filled: 10n }, { amountIn: 90n }), TERMS)).toBe(90n);
  });

  it("pays what the judge fee leaves", () => {
    expect(releaseNet(proofIntent({}, { judgeFee: 99n }), TERMS)).toBe(1n);
  });

  it("pays nothing when the release terms disagree with what is escrowed", () => {
    expect(releaseNet(proofIntent({ escrowed: 100n }, { amountIn: 99n }), TERMS)).toBeNull();
  });
});

const viewing = (views: Map<Address, AccountView>) =>
  ({
    getAccount: async (address: Address) => views.get(address) ?? null,
    getAccounts: async (addresses: readonly Address[]) => addresses.map((address) => views.get(address) ?? null),
  }) as unknown as Transport;

describe("an intent read at an address", () => {
  const AT = key(21);
  const good = intentBytes(proofIntent());
  const read = (view: AccountView | null) => intentAt(viewing(new Map(view === null ? [] : [[AT, view]])), AT);

  it("reads an engine intent of the right size and tag", async () => {
    expect(await read(engineView(good))).toMatchObject({ owner: OWNER, kind: Kind.AttestedResult });
    expect((await proofAt(viewing(new Map([[AT, engineView(good)]])), AT))?.address).toBe(AT);
  });

  it("reads nothing at a missing account, another program's account, a wrong size or a wrong tag, each on its own", async () => {
    expect(await read(null)).toBeNull();
    expect(await read({ ...engineView(good), owner: OWNER })).toBeNull();
    expect(await read(engineView(Uint8Array.from([...good, 0])))).toBeNull();
    expect(await read(engineView(Uint8Array.from(good, (b, i) => (i === 0 ? b ^ 0xff : b))))).toBeNull();
    expect(good.length).toBe(getIntentSize());
  });
});

type Board = { intent: Address; worker?: Address; until?: bigint; head?: number; tail?: number };

async function boardView({ intent, worker = NONE, until = 0n, head = 0, tail = 0 }: Board): Promise<[Address, AccountView]> {
  const data = getClaimBoardEncoder().encode({
    intent,
    owner: OWNER,
    worker,
    until,
    stake: 0n,
    held: 0n,
    maxSecs: 60,
    version: CLAIMS_VERSION,
    bump: 0,
    listed: 0,
    padding: new Uint8Array(1),
    droppedBy: NONE,
    head,
    tail,
  });
  return [await claimBoardAddress(intent), engineView(Uint8Array.from(data))];
}

function escrows(accounts: ProgramAccount[], views: Map<Address, AccountView>): Transport {
  views.set(CLOCK_SYSVAR, clockView(NOW));
  return { ...viewing(views), intents: async () => accounts } as unknown as Transport;
}

const proofAccount = (address: Address, patch: Partial<Intent>): ProgramAccount => ({ address, data: intentBytes(proofIntent(patch)) });

describe("the open proof escrows a worker can take", () => {
  it("lists an escrow only while it has not expired, the latest expiry first", async () => {
    const [ends, later, latest] = [key(31), key(32), key(33)];
    const transport = escrows(
      [proofAccount(ends, { expiresAt: NOW }), proofAccount(later, { expiresAt: NOW + 1n }), proofAccount(latest, { expiresAt: NOW + 2n })],
      new Map(),
    );
    const { proofs } = await openProofEscrows(transport);
    expect(proofs.map(({ address }) => address)).toStrictEqual([latest, later]);
  });

  it("leaves out with unclaimed the escrows that are held or have a line, and keeps those that take no claims", async () => {
    const [held, free, waiting, closed] = [key(41), key(42), key(43), key(44)];
    const accounts = [
      proofAccount(held, { expiresAt: NOW + 4n, claims: CLAIMS_OPEN }),
      proofAccount(free, { expiresAt: NOW + 3n, claims: CLAIMS_OPEN }),
      proofAccount(waiting, { expiresAt: NOW + 2n, claims: CLAIMS_OPEN }),
      proofAccount(closed, { expiresAt: NOW + 1n, claims: 0 }),
    ];
    const views = new Map(
      await Promise.all([
        boardView({ intent: held, worker: key(50), until: NOW + 60n }),
        boardView({ intent: free }),
        boardView({ intent: waiting, head: 0, tail: 1 }),
        boardView({ intent: closed, worker: key(51), until: NOW + 60n }),
      ]),
    );
    const listed = async (unclaimed?: boolean) => (await openProofEscrows(escrows(accounts, views), { unclaimed })).proofs.map(({ address }) => address);
    expect(await listed(true)).toStrictEqual([free, closed]);
    expect(await listed(false)).toStrictEqual([held, free, waiting, closed]);
    expect(await listed()).toStrictEqual([held, free, waiting, closed]);
  });
});

describe("the event that created an intent", () => {
  const [mine, other] = [key(61), key(62)];

  it("is only an IntentCreated event for that intent", () => {
    expect(createdIn([createdEvent(mine, OWNER)], mine)).toBe(true);
    expect(createdIn([cancelledEvent(mine, OWNER)], mine)).toBe(false);
    expect(createdIn([createdEvent(other, OWNER)], mine)).toBe(false);
    expect(createdIn([], mine)).toBe(false);
  });
});

describe("whether the node still holds an intent's creation", () => {
  const AT = key(71);
  const holding = (first?: bigint) =>
    ({
      engineTransactions: async () => [tx("made", { slot: 50n, emitted: [createdEvent(AT, OWNER)] })],
      ...(first === undefined ? {} : { firstAvailableSlot: async () => first }),
    }) as unknown as Transport;

  it("says no when the node cannot tell its first slot", async () => {
    expect(await historyCovers(holding(), AT, BASE.createdAt)).toBe(false);
  });

  it("says yes when the first slot it holds is at or before the creation, and no after it", async () => {
    expect(await historyCovers(holding(50n), AT, 0n)).toBe(true);
    expect(await historyCovers(holding(10n), AT, 0n)).toBe(true);
    expect(await historyCovers(holding(51n), AT, 0n)).toBe(false);
  });

  it("dates the creation by the transaction that created the intent, not a later one", async () => {
    const transport = {
      engineTransactions: async () => [tx("later", { slot: 70n }), tx("made", { slot: 50n, emitted: [createdEvent(AT, OWNER)] })],
      firstAvailableSlot: async () => 60n,
    } as unknown as Transport;
    expect(await historyCovers(transport, AT, 0n)).toBe(false);
  });
});
