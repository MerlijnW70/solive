import { type Address, generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { IntentStatus, Kind } from "@intent-engine/core";
import { CORE_ERROR_CODES, checkAdvance, checkClaimant, checkStandBy } from "@intent-engine/core/internal";
import type { Client, ClaimsView } from "@intent-engine/client";
import { advanceStep, claimBoard, lineWaitingHere, refusedBy, standbyStep } from "../src/agent/claim-line.js";
import { tool } from "../src/agent/names.js";
import { AgentRefusal, ENGINE_ERROR_NAMES } from "../src/agent/problems.js";
import { takeStep } from "../src/agent/work-claims.js";
import { coolingDown, heldBy } from "../src/claim-commands.js";

type Taker = Parameters<typeof takeStep>[3] & Parameters<typeof standbyStep>[4];

const NONE = "11111111111111111111111111111111" as Address;
const UNTIL = 1_600n;

const clientAt = (now: bigint, status: number = IntentStatus.Open) =>
  ({
    intent: async () => ({ intent: { status, kind: Kind.AttestedResult, expiresAt: 10_000n } }),
    chainTime: async () => now,
    config: async () => ({ paused: 0, fillDisabledKinds: 0n }),
  }) as unknown as Client;

const viewOf = (over: Partial<ClaimsView>): ClaimsView =>
  ({
    board: "11111111111111111111111111111112",
    state: "free",
    worker: null,
    until: 0n,
    secondsLeft: 0n,
    stake: 50_000_000n,
    maxSecs: 3_600,
    owner: "11111111111111111111111111111112",
    cooldown: null,
    line: { head: 0, tail: 0, waiting: 0 },
    list: null,
    ...over,
  }) as ClaimsView;

const heldView = (worker: Address, over: Partial<ClaimsView> = {}) => viewOf({ state: "held", worker, until: UNTIL, secondsLeft: 600n, ...over });

async function actors() {
  const [owner, holder, worker] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
  const intent = (await generateKeyPairSigner()).address;
  return { escrow: { owner: owner.address, nonce: 0n, intent }, holder: holder.address, worker: worker as unknown as Taker };
}

const RENT = "SysvarRent111111111111111111111111111111111" as Address;

const rented = {
  getAccount: async (address: Address) => {
    const data = new Uint8Array(24);
    const view = new DataView(data.buffer);
    view.setBigUint64(0, 3_480n, true);
    view.setFloat64(8, 2, true);
    return { owner: NONE, data: address === RENT ? data : new Uint8Array(0), lamports: 1n, executable: false };
  },
} as never;

const refusal = async (run: Promise<unknown>) => run.then(() => null, (error: unknown) => (error as { problem: { code: string; hint: string } }).problem);

describe("the claim board of a view", () => {
  it("rebuilds the stored board, so the core checks decide on it", async () => {
    const { holder, worker } = await actors();
    expect(claimBoard(heldView(holder, { line: { head: 2, tail: 5, waiting: 3 } }))).toMatchObject({ worker: holder, until: UNTIL, head: 2, tail: 5 });
    const cooling = claimBoard(viewOf({ cooldown: { worker: worker.address, until: UNTIL } }));
    expect(cooling).toMatchObject({ worker: NONE, until: UNTIL, droppedBy: worker.address });
    expect(refusedBy(() => checkClaimant(cooling, worker.address, UNTIL - 1n))).toBe("ClaimCooldown");
    expect(refusedBy(() => checkClaimant(cooling, holder, UNTIL - 1n))).toBeUndefined();
    expect(claimBoard(viewOf({}))).toMatchObject({ worker: NONE, until: 0n });
    expect(refusedBy(() => checkStandBy(claimBoard(viewOf({})), 5n))).toBe("JobNotHeld");
    expect(refusedBy(() => checkAdvance(claimBoard(heldView(holder)), UNTIL - 1n))).toBe("ClaimHeld");
  });

  it("lets an error that is not the program's through", () => {
    expect(() =>
      refusedBy(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
  });
});

describe("a claim taken through the core checks", () => {
  it("names the program's error for a held job, a waiting line and a cooldown", async () => {
    const { escrow, holder, worker } = await actors();
    const open = clientAt(UNTIL - 600n);
    const held = await refusal(takeStep(open, escrow, heldView(holder), worker, 60));
    expect(held).toMatchObject({ code: "ClaimHeld", hint: `${heldBy(escrow.intent, holder, 600n)}; join the line with ${tool("wallet_claim")} action standby` });
    const own = await refusal(takeStep(open, escrow, heldView(worker.address), worker, 60));
    expect(own).toMatchObject({ code: "ClaimHeld", hint: heldBy(escrow.intent, worker.address, 600n) });
    const waiting = await refusal(takeStep(open, escrow, viewOf({ line: { head: 0, tail: 2, waiting: 2 } }), worker, 60));
    expect(waiting).toMatchObject({ code: "LineWaiting", hint: lineWaitingHere(escrow.intent, 2) });
    const cooling = await refusal(takeStep(open, escrow, viewOf({ cooldown: { worker: worker.address, until: UNTIL } }), worker, 60));
    expect(cooling).toMatchObject({ code: "ClaimCooldown", hint: coolingDown(escrow.intent, worker.address, UNTIL) });
    const other = await takeStep(open, escrow, viewOf({ cooldown: { worker: holder, until: UNTIL } }), worker, 60);
    expect(other.key).toBe("60:50000000");
  });

  it("decides on the clock it reads now, as the program does", async () => {
    const { escrow, holder, worker } = await actors();
    const late = clientAt(UNTIL);
    const lapsed = await takeStep(late, escrow, heldView(holder), worker, 60);
    expect(lapsed.key).toBe("60:50000000");
    const cooled = await takeStep(late, escrow, viewOf({ cooldown: { worker: worker.address, until: UNTIL } }), worker, 60);
    expect(cooled.key).toBe("60:50000000");
  });

  it("names only errors the program has", () => {
    for (const code of ["ClaimHeld", "LineWaiting", "ClaimCooldown", "JobNotHeld", "LineEmpty"] as const) {
      expect(CORE_ERROR_CODES).toContain(code);
      expect(ENGINE_ERROR_NAMES).toContain(code);
    }
  });
});

describe("a stand-by and an advance through the core checks", () => {
  const transport = {} as never;

  it("refuses a stand-by for a job nobody holds on the clock read now", async () => {
    const { escrow, holder, worker } = await actors();
    const stale = heldView(holder);
    const live = await refusal(standbyStep(clientAt(UNTIL), transport, escrow, stale, worker, 60));
    expect(live).toMatchObject({ code: "JobNotHeld" });
    const free = await refusal(standbyStep(clientAt(5n), transport, escrow, viewOf({}), worker, 60));
    expect(free).toMatchObject({ code: "JobNotHeld" });
  });

  it("names a held claim before an empty line, in the program's order", async () => {
    const { escrow, holder, worker } = await actors();
    const held = await refusal(advanceStep(clientAt(UNTIL - 600n), transport, escrow, heldView(holder), worker.address));
    expect(held).toMatchObject({ code: "ClaimHeld" });
    const lapsed = await refusal(advanceStep(clientAt(UNTIL), transport, escrow, viewOf({ state: "lapsed", worker: holder, until: UNTIL }), worker.address));
    expect(lapsed).toMatchObject({ code: "LineEmpty" });
  });
});

describe("the order the program refuses in", () => {
  const closed = (now: bigint) => clientAt(now, IntentStatus.Cancelled);
  const refuses = (code: string) => async () => {
    throw new AgentRefusal(code as never, code);
  };

  it("names a closed escrow before anything on the board, for a take, a stand-by and an advance", async () => {
    const { escrow, holder, worker } = await actors();
    const held = heldView(holder, { line: { head: 0, tail: 1, waiting: 1 } });
    expect(await refusal(takeStep(closed(1_000n), escrow, held, worker, 60))).toMatchObject({ code: "InvalidTransition" });
    expect(await refusal(standbyStep(closed(1_000n), rented, escrow, held, worker, 99_999))).toMatchObject({ code: "InvalidTransition" });
    expect(await refusal(advanceStep(closed(1_000n), rented, escrow, heldView(holder), worker.address))).toMatchObject({ code: "InvalidTransition" });
  });

  it("asks the invite and list gates after the escrow and before the board", async () => {
    const { escrow, holder, worker } = await actors();
    const held = heldView(holder);
    expect(await refusal(takeStep(clientAt(1_000n), escrow, held, worker, 60, refuses("NotListed")))).toMatchObject({ code: "NotListed" });
    expect(await refusal(takeStep(closed(1_000n), escrow, held, worker, 60, refuses("NotListed")))).toMatchObject({ code: "InvalidTransition" });
    expect(await refusal(standbyStep(clientAt(1_000n), rented, escrow, held, worker, 99_999, refuses("NotInvited")))).toMatchObject({ code: "NotInvited" });
  });

  it("names a waiting line before a held claim, and a held claim before terms that are out of range", async () => {
    const { escrow, holder, worker } = await actors();
    const open = clientAt(UNTIL - 600n);
    const queued = heldView(holder, { line: { head: 0, tail: 1, waiting: 1 } });
    expect(await refusal(takeStep(open, escrow, queued, worker, 60))).toMatchObject({ code: "LineWaiting", hint: lineWaitingHere(escrow.intent, 1) });
    expect(await refusal(takeStep(open, escrow, heldView(holder), worker, 99_999))).toMatchObject({ code: "ClaimHeld" });
    expect(await refusal(takeStep(open, escrow, viewOf({}), worker, 99_999))).toMatchObject({ code: "ClaimTerms" });
    expect(await refusal(takeStep(clientAt(9_990n), escrow, viewOf({}), worker, 60))).toMatchObject({ code: "ClaimTerms" });
  });

  it("names the stand-by terms, then the holder, then a job nobody holds", async () => {
    const { escrow, holder, worker } = await actors();
    const open = clientAt(UNTIL - 600n);
    const own = heldView(worker.address);
    expect(await refusal(standbyStep(open, rented, escrow, own, worker, 99_999))).toMatchObject({ code: "ClaimTerms" });
    expect(await refusal(standbyStep(open, rented, escrow, own, worker, 60))).toMatchObject({ code: "HolderStandsBy" });
    expect(await refusal(standbyStep(open, rented, escrow, viewOf({}), worker, 60))).toMatchObject({ code: "JobNotHeld" });
    expect(await refusal(standbyStep(open, rented, escrow, viewOf({}), worker, 99_999))).toMatchObject({ code: "ClaimTerms" });
    const other = await standbyStep(open, rented, escrow, heldView(holder), worker, 60);
    expect(other.key).toContain("standby:60:");
  });

  it("lets the wallet whose claim has lapsed stand by behind a line, whatever the view said", async () => {
    const { escrow, worker } = await actors();
    const stale = heldView(worker.address, { line: { head: 0, tail: 1, waiting: 1 } });
    const step = await standbyStep(clientAt(UNTIL), rented, escrow, stale, worker, 60);
    expect(step.key).toContain("standby:60:1:");
    expect(await refusal(standbyStep(clientAt(UNTIL - 1n), rented, escrow, stale, worker, 60))).toMatchObject({ code: "HolderStandsBy" });
  });
});
