import { type Address, generateKeyPairSigner, none, some } from "@solana/kit";
import { AccountState, getTokenEncoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatAmount, IntentStatus, Kind } from "@intent-engine/core";
import { claimBoardAddress, claimListAddress, findDelegatePda, getClaimBoardSize, getClaimListSize, kindBit, type Mandate } from "@intent-engine/core/internal";
import type { Client, ClaimsView, Transport } from "@intent-engine/client";
import { rentFor } from "../src/agent/budget.js";
import { boardLeft, closedEscrow, escrowState, lineWaitingHere, settleCall, standbyStep } from "../src/agent/claim-line.js";
import { mandateRefusal } from "../src/agent/mandate-state.js";
import { lowerAllowance } from "../src/agent/owner.js";
import { AgentRefusal } from "../src/agent/problems.js";
import { heldLine } from "../src/agent/shapes.js";
import { specSealedHint } from "../src/agent/spec.js";
import { tool } from "../src/agent/names.js";

const RATE = { perByteYear: 3_480n, threshold: 2 };
const RENT_SYSVAR = "SysvarRent111111111111111111111111111111111" as Address;
const SOME = { owner: TOKEN_PROGRAM_ADDRESS, data: new Uint8Array(0), lamports: 1n, executable: false };

const rentData = () => {
  const data = new Uint8Array(24);
  const view = new DataView(data.buffer);
  view.setBigUint64(0, RATE.perByteYear, true);
  view.setFloat64(8, RATE.threshold, true);
  return data;
};

const rentTransport = (missing: ReadonlySet<Address> = new Set()): Transport =>
  ({
    getAccount: async (address: Address) => (address === RENT_SYSVAR ? { ...SOME, data: rentData() } : missing.has(address) ? null : SOME),
  }) as unknown as Transport;

const sol = (lamports: bigint) => `${formatAmount(lamports, 9)} SOL`;

describe("the claim line texts", () => {
  it("count one waiting worker in the singular and others in the plural", async () => {
    const intent = (await generateKeyPairSigner()).address;
    const tail = `for escrow ${intent}, so it is handed over in line order; nothing was sent; join the line with ${tool("wallet_claim")} action standby`;
    expect(lineWaitingHere(intent, 1)).toBe(`1 worker stands by ${tail}`);
    expect(lineWaitingHere(intent, 2)).toBe(`2 workers stand by ${tail}`);
    expect(lineWaitingHere(intent, 0)).toBe(`0 workers stand by ${tail}`);
  });

  it("name a released escrow differently from a cancelled one", async () => {
    const intent = (await generateKeyPairSigner()).address;
    expect(closedEscrow(intent, "released")).toBe(`escrow ${intent} was released, so its job can no longer be paid; stop working on it`);
    expect(closedEscrow(intent, "gone")).toBe(`escrow ${intent} was cancelled, expired or closed, so its job can no longer be paid; stop working on it`);
  });
});

describe("escrowState", () => {
  const owner = "11111111111111111111111111111112" as Address;
  const clientOf = (found: { status: number; expiresAt: bigint } | null, now: bigint): Client =>
    ({ intent: async () => (found === null ? null : { intent: found }), chainTime: async () => now }) as unknown as Client;

  it("is open only while the escrow is open and before its expiry", async () => {
    expect(await escrowState(clientOf(null, 5n), owner, 0n)).toBe("gone");
    expect(await escrowState(clientOf({ status: IntentStatus.Filled, expiresAt: 10n }, 5n), owner, 0n)).toBe("released");
    expect(await escrowState(clientOf({ status: IntentStatus.Open, expiresAt: 10n }, 9n), owner, 0n)).toBe("open");
    expect(await escrowState(clientOf({ status: IntentStatus.Open, expiresAt: 10n }, 10n), owner, 0n)).toBe("gone");
    expect(await escrowState(clientOf({ status: IntentStatus.Open, expiresAt: 10n }, 11n), owner, 0n)).toBe("gone");
    expect(await escrowState(clientOf({ status: IntentStatus.Cancelled, expiresAt: 10n }, 5n), owner, 0n)).toBe("gone");
    expect(await escrowState(clientOf({ status: IntentStatus.Expired, expiresAt: 10n }, 5n), owner, 0n)).toBe("gone");
  });
});

describe("boardLeft", () => {
  it("adds the rent of the claim list to the rent of the board", async () => {
    const intent = (await generateKeyPairSigner()).address;
    const owner = (await generateKeyPairSigner()).address;
    const board = await claimBoardAddress(intent);
    const list = await claimListAddress(intent);
    const boardRent = rentFor(getClaimBoardSize(), RATE);
    const listRent = rentFor(getClaimListSize(), RATE);
    expect(boardRent).not.toBe(listRent);
    expect(await boardLeft(rentTransport(new Set([board])), owner, 3n, intent)).toBeUndefined();
    expect(await boardLeft(rentTransport(new Set([list])), owner, 3n, intent)).toBe(
      `the claims board ${board} stays open afterwards, holding ${sol(boardRent)} of rent that ${owner} paid; ${settleCall(owner, 3n)} closes it and returns that rent to ${owner}`,
    );
    expect(await boardLeft(rentTransport(), owner, 3n, intent)).toBe(
      `the claims board ${board} and its claim list ${list} stay open afterwards, holding ${sol(boardRent + listRent)} of rent that ${owner} paid; ${settleCall(owner, 3n)} closes them and returns that rent to ${owner}`,
    );
  });
});

describe("standbyStep", () => {
  const escrowAt = async () => {
    const owner = (await generateKeyPairSigner()).address;
    return { owner, nonce: 0n, intent: (await generateKeyPairSigner()).address };
  };
  const open = { intent: async () => ({ intent: { status: IntentStatus.Open, expiresAt: 10_000n } }), chainTime: async () => 1_000n } as unknown as Client;
  const viewOf = (over: Partial<ClaimsView>): ClaimsView =>
    ({
      board: "11111111111111111111111111111112",
      state: "held",
      worker: null,
      until: 1_600n,
      secondsLeft: 600n,
      stake: 50_000_000n,
      maxSecs: 3_600,
      owner: "11111111111111111111111111111112",
      cooldown: null,
      line: { head: 0, tail: 1, waiting: 1 },
      list: null,
      ...over,
    }) as ClaimsView;

  it("lets another wallet stand by behind a held claim, with the next place and the entry number", async () => {
    const escrow = await escrowAt();
    const holder = (await generateKeyPairSigner()).address;
    const worker = await generateKeyPairSigner();
    const step = await standbyStep(open, rentTransport(), escrow, viewOf({ worker: holder }), worker, 600);
    expect(step.summary[0]).toBe(
      `Stands by: for escrow ${escrow.intent} as entry 1, place 2 in its line; when the job reaches this wallet ${worker.address} it holds the claim for 600 seconds`,
    );
    expect(step.key).toBe("standby:600:1:50000000");
  });

  it("refuses the holder of a live claim, but not a wallet whose claim lapsed", async () => {
    const escrow = await escrowAt();
    const worker = await generateKeyPairSigner();
    const held = viewOf({ worker: worker.address });
    await expect(standbyStep(open, rentTransport(), escrow, held, worker, 600)).rejects.toMatchObject({ problem: { code: "HolderStandsBy" } });
    const lapsed = await standbyStep(open, rentTransport(), escrow, viewOf({ worker: worker.address, state: "lapsed" }), worker, 600);
    expect(lapsed.key).toBe("standby:600:1:50000000");
  });

  it("accepts exactly the longest claim and refuses one second more", async () => {
    const escrow = await escrowAt();
    const holder = (await generateKeyPairSigner()).address;
    const worker = await generateKeyPairSigner();
    const view = viewOf({ worker: holder, maxSecs: 900 });
    expect((await standbyStep(open, rentTransport(), escrow, view, worker, 900)).key).toBe("standby:900:1:50000000");
    const refused = await standbyStep(open, rentTransport(), escrow, view, worker, 901).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AgentRefusal);
    expect(refused).toMatchObject({ problem: { code: "ClaimTerms" } });
  });
});

describe("the mandate limits at the edge of the i64 range", () => {
  const mandate = (maxTtl: bigint) =>
    ({
      epoch: 1n,
      validUntil: 1n << 80n,
      kinds: Number(kindBit(Kind.SwapExactIn)),
      maxTtl,
      agentFee: 0n,
      perIntent: 100n,
      spent: 0n,
      total: 100n,
      intents: 0,
      maxIntents: 5,
      floorIn: 0n,
      floorOut: 0n,
    }) as unknown as Mandate;
  const admission = (expiresAt: bigint, now: bigint) => ({ params: { kind: Kind.SwapExactIn, amountIn: 10n, minOut: 1n } as never, expiresAt, now, ownerEpoch: null });

  it("saturates a lifetime far below the range to the lowest i64", () => {
    expect(mandateRefusal(mandate(-1n), admission(0n, 1n << 70n))).toBeNull();
  });

  it("saturates a lifetime far above the range to the highest i64", () => {
    expect(mandateRefusal(mandate((1n << 63n) - 1n), admission(1n << 70n, 0n))).toBeNull();
    expect(mandateRefusal(mandate((1n << 63n) - 2n), admission(1n << 70n, 0n))).toBe("MandateTtl");
  });
});

describe("the shapes and hints", () => {
  it("prints the day a held share can be claimed until", () => {
    expect(heldLine(1_700_000_000n)).toContain("or 2023-11-14T22:13:20.000Z");
  });

  it("counts invited wallets in the singular and the plural", () => {
    expect(specSealedHint(1, true)).toBe(
      "the spec is sealed to 1 invited wallet; this wallet is not one of them; the untrusted detail names its url",
    );
    expect(specSealedHint(2, false)).toBe(
      "the spec is sealed to 2 invited wallets; read it with the key of an invited wallet; the untrusted detail names its url",
    );
  });
});

describe("lowerAllowance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("subtracts the amount and stops at zero whatever order the sort compares in", async () => {
    const owner = (await generateKeyPairSigner()).address;
    const account = (await generateKeyPairSigner()).address;
    const [engine] = await findDelegatePda({ owner });
    const data = Uint8Array.from(
      getTokenEncoder().encode({ mint: account, owner, amount: 0n, delegate: some(engine), state: AccountState.Initialized, isNative: none(), delegatedAmount: 10n, closeAuthority: none() }),
    );
    const transport = { getAccount: async (address: Address) => (address === account ? { owner: TOKEN_PROGRAM_ADDRESS, data, lamports: 1n } : null) } as unknown as Transport;
    const sort = Array.prototype.sort;
    vi.spyOn(Array.prototype, "sort").mockImplementation(function (this: unknown[], compare?: (a: never, b: never) => number) {
      if (compare === undefined || this.length !== 2 || typeof this[0] !== "bigint") {
        return sort.call(this, compare as never);
      }
      if (compare(this[0] as never, this[1] as never) > 0) {
        [this[0], this[1]] = [this[1], this[0]];
      }
      return this;
    });
    for (const [by, after] of [
      [3n, 7n],
      [10n, 0n],
      [11n, 0n],
    ] as const) {
      expect(await lowerAllowance(transport, owner, account, by)).toEqual({ account, before: 10n, after, replaces: null });
    }
  });
});
