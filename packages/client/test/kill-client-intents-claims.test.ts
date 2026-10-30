import { type Address, getAddressDecoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { NotAnEngineAccount } from "@intent-engine/core";
import {
  CLAIM_BOARD_DISCRIMINATOR,
  CLAIM_LIST_DISCRIMINATOR,
  CLAIM_LIST_VERSION,
  claimBoardAddress,
  claimListAddress,
  CLAIMS_VERSION,
  getClaimBoardDecoder,
  getClaimBoardEncoder,
  getClaimBoardSize,
  getClaimListDecoder,
  getClaimListEncoder,
  getClaimListSize,
  getStandbyDecoder,
  getStandbyEncoder,
  getStandbySize,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  STANDBY_DISCRIMINATOR,
  STANDBY_VERSION,
  standbyAddress,
} from "@intent-engine/core/internal";
import { lineHandover, loadClaimsOf } from "../src/client-claims.js";
import { CLOCK_SYSVAR } from "../src/accounts.js";
import type { AccountView, Transport } from "../src/transport.js";

const key = (byte: number) => getAddressDecoder().decode(new Uint8Array(32).fill(byte));
const NONE = "11111111111111111111111111111111" as Address;
const INTENT = key(1);
const OWNER = key(2);
const DROPPER = key(3);
const NOW = 5_000n;

const clock = (now: bigint): AccountView => {
  const data = new Uint8Array(40);
  new DataView(data.buffer).setBigInt64(32, now, true);
  return { owner: key(99), data, lamports: 1n };
};

const board = (patch: object = {}) => ({
  ...getClaimBoardDecoder().decode(new Uint8Array(getClaimBoardSize())),
  intent: INTENT,
  owner: OWNER,
  worker: NONE,
  droppedBy: NONE,
  until: 0n,
  version: CLAIMS_VERSION,
  ...patch,
});

const boardView = (patch: object = {}, owner: Address = INTENT_ENGINE_PROGRAM_ADDRESS): AccountView => ({
  owner,
  data: Uint8Array.from(getClaimBoardEncoder().encode(board(patch))),
  lamports: 1n,
});

function serving(held: Map<Address, AccountView>, now: bigint): Transport {
  return {
    getAccounts: async (addresses: Address[]) => addresses.map((address) => (address === CLOCK_SYSVAR ? clock(now) : (held.get(address) ?? null))),
    getAccount: async (address: Address) => held.get(address) ?? null,
  } as unknown as Transport;
}

async function claimsWith(view: AccountView, now = NOW, extra: [Address, AccountView][] = []) {
  const held = new Map<Address, AccountView>([[await claimBoardAddress(INTENT), view], ...extra]);
  return (await loadClaimsOf(serving(held, now), [INTENT]))[0];
}

describe("reading a claim board", () => {
  it("refuses an account owned by another program even when it carries the board discriminator", async () => {
    const view = boardView({}, key(50));
    expect(Array.from(view.data.subarray(0, 8))).toStrictEqual(Array.from(CLAIM_BOARD_DISCRIMINATOR));
    await expect(claimsWith(view)).rejects.toBeInstanceOf(NotAnEngineAccount);
  });

  it("refuses an engine account that carries another discriminator", async () => {
    const view = boardView();
    view.data.set(STANDBY_DISCRIMINATOR);
    await expect(claimsWith(view)).rejects.toBeInstanceOf(NotAnEngineAccount);
  });

  it("reads the board of the engine with the board discriminator", async () => {
    expect(await claimsWith(boardView())).toMatchObject({ state: "free", worker: null, owner: OWNER, until: 0n, cooldown: null, list: null });
  });
});

describe("the cooldown a dropped claim leaves", () => {
  it("lasts until the second its board names, and is gone at that second", async () => {
    const dropped = { droppedBy: DROPPER, until: NOW };
    expect((await claimsWith(boardView(dropped), NOW - 1n))?.cooldown).toStrictEqual({ worker: DROPPER, until: NOW });
    expect((await claimsWith(boardView(dropped), NOW))?.cooldown).toBeNull();
    expect((await claimsWith(boardView(dropped), NOW + 1n))?.cooldown).toBeNull();
    expect((await claimsWith(boardView({ droppedBy: NONE, until: NOW }), NOW - 1n))?.cooldown).toBeNull();
  });
});

describe("the claim list of a listed board", () => {
  const listed = async (count: number, size: number) => {
    const workers = [key(11), key(12), key(13)];
    const stored = getClaimListDecoder().decode(new Uint8Array(getClaimListSize()));
    const data = Uint8Array.from(
      getClaimListEncoder().encode({ ...stored, intent: INTENT, owner: OWNER, size, count, version: CLAIM_LIST_VERSION, workers: stored.workers.map((worker, i) => workers[i] ?? worker) }),
    );
    const address = await claimListAddress(INTENT);
    expect(Array.from(data.subarray(0, 8))).toStrictEqual(Array.from(CLAIM_LIST_DISCRIMINATOR));
    return (await claimsWith(boardView({ listed: 1 }), NOW, [[address, { owner: INTENT_ENGINE_PROGRAM_ADDRESS, data, lamports: 1n }]]))?.list;
  };

  it("is complete only when every seat is filled, and lists the filled seats", async () => {
    const address = await claimListAddress(INTENT);
    expect(await listed(3, 3)).toStrictEqual({ address, size: 3, workers: [key(11), key(12), key(13)], complete: true });
    expect(await listed(2, 3)).toStrictEqual({ address, size: 3, workers: [key(11), key(12)], complete: false });
    expect(await listed(0, 3)).toStrictEqual({ address, size: 3, workers: [], complete: false });
  });
});

describe("the hand-over of a waiting line", () => {
  const entry = (worker: Address) => {
    const stored = getStandbyDecoder().decode(new Uint8Array(getStandbySize()));
    return { owner: INTENT_ENGINE_PROGRAM_ADDRESS, data: Uint8Array.from(getStandbyEncoder().encode({ ...stored, worker, intent: INTENT, version: STANDBY_VERSION })), lamports: 1n };
  };
  const handover = async (workers: (Address | null)[], barred: Address | null) => {
    const held = new Map<Address, AccountView>();
    const addresses = await Promise.all(workers.map((_, seq) => standbyAddress(INTENT, seq)));
    workers.forEach((worker, seq) => {
      if (worker !== null) {
        held.set(addresses[seq] as Address, entry(worker));
      }
    });
    return { addresses, result: await lineHandover(serving(held, NOW), INTENT, { head: 0, tail: workers.length }, barred) };
  };

  it("passes every entry when none is live, and stops after the first live one when there is one", async () => {
    const none = await handover([DROPPER, null, DROPPER], DROPPER);
    expect(none.result).toStrictEqual({ entries: none.addresses, dropper: DROPPER, refunded: 2 });
    const middle = await handover([DROPPER, key(21), key(22), DROPPER], DROPPER);
    expect(middle.result).toStrictEqual({ entries: middle.addresses.slice(0, 2), nextWorker: key(21), dropper: DROPPER, refunded: 1 });
    const unbarred = await handover([DROPPER, key(21), key(22), key(23)], null);
    expect(unbarred.result).toStrictEqual({ entries: unbarred.addresses.slice(0, 1), nextWorker: DROPPER });
  });
});
