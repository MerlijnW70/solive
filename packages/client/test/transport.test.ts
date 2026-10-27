import {
  type Address,
  type Base64EncodedWireTransaction,
  generateKeyPairSigner,
  getBase64Encoder,
  getTransactionDecoder,
} from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import {
  MaybeSent,
  heardSlot,
  CONFIRM_POLLS,
  confirm,
  confirmSent,
  POLL_MS,
  rateLimited,
  rpcTransport,
  FailedOnChain,
  BlockhashExpired,
  neverLanded,
} from "../src/transport.js";
import { isolateMocks, OTHER, OWNER, SIG, signatureOfWire, stub, TOKEN_PROGRAM } from "./transport-stub.js";

isolateMocks();

describe("confirm", () => {
  it("returns at confirmed or finalized and polls in between", async () => {
    const s = stub([null, { err: null, confirmationStatus: "processed" }, { err: null, confirmationStatus: "confirmed" }]);
    await confirm(s.rpc, SIG, 10n, s.wait);
    expect(s.waits).toEqual([POLL_MS, POLL_MS]);
    expect(POLL_MS).toBe(500);
    expect(s.calls.filter((c) => c === `status:${SIG}`)).toHaveLength(3);
    const f = stub([{ err: null, confirmationStatus: "finalized" }]);
    await confirm(f.rpc, SIG, 10n, f.wait);
    expect(f.waits).toEqual([]);
  });

  it("surfaces a failed transaction", async () => {
    const s = stub([{ err: { InstructionError: [0, { Custom: 6008 }] }, confirmationStatus: "confirmed" }]);
    await expect(confirm(s.rpc, SIG, 10n, s.wait)).rejects.toThrow(`transaction ${SIG} failed: { InstructionError: [ 0, { Custom: 6008 } ] }`);
    const again = stub([{ err: { InstructionError: [0, { Custom: 6008 }] }, confirmationStatus: "confirmed" }]);
    const failed = await confirm(again.rpc, SIG, 10n, again.wait).catch((e: unknown) => e);
    expect(failed).not.toBeInstanceOf(MaybeSent);
    expect(failed).toBeInstanceOf(FailedOnChain);
    expect(neverLanded(failed)).toBe(true);
  });

  it("gives up only once the blockhash is past its last valid height", async () => {
    const at = stub([null, null], [10n, 11n]);
    await expect(confirm(at.rpc, SIG, 10n, at.wait)).rejects.toThrow(`transaction ${SIG} expired before confirmation`);
    expect(at.waits).toEqual([POLL_MS]);
    const late = stub([null, null], [10n, 11n]);
    const expired = await confirm(late.rpc, SIG, 10n, late.wait).catch((e: unknown) => e);
    expect(expired).toBeInstanceOf(Error);
    expect(expired).not.toBeInstanceOf(MaybeSent);
    expect(expired).toBeInstanceOf(BlockhashExpired);
    expect(neverLanded(expired)).toBe(true);
  });

  it("looks a transaction up once more before calling it expired, since it may have landed between the two reads", async () => {
    const landed = stub([null, { err: null, confirmationStatus: "confirmed" }], [11n]);
    await confirm(landed.rpc, SIG, 10n, landed.wait);
    expect(landed.calls).toEqual([`status:${SIG}`, "epoch", `status:${SIG}:history`]);
    const failed = await confirm(stub([null, { err: "boom", confirmationStatus: "confirmed" }], [11n]).rpc, SIG, 10n).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(FailedOnChain);
    const pending = await confirm(stub([null, { err: null, confirmationStatus: "processed" }], [11n]).rpc, SIG, 10n).catch((e: unknown) => e);
    expect(pending).toBeInstanceOf(MaybeSent);
    expect(neverLanded(pending)).toBe(false);
  });

  it("calls a transaction expired only on a status read from a node that has seen the block past its last valid height", async () => {
    const lagging = stub([null, null, null, { err: null, confirmationStatus: "confirmed" }], [11n, 11n], [1_000_000n, 50n]);
    await confirm(lagging.rpc, SIG, 10n, lagging.wait);
    expect(lagging.calls).toEqual([`status:${SIG}`, "epoch", `status:${SIG}:history`, `status:${SIG}`, "epoch", `status:${SIG}:history`]);
    const caught = stub([null, null], [11n], [1_000_000n, 111n]);
    await expect(confirm(caught.rpc, SIG, 10n, caught.wait)).rejects.toBeInstanceOf(BlockhashExpired);
    const behind = stub([null, null], [11n], [1_000_000n, 110n]);
    const unsure = await confirm(behind.rpc, SIG, 10n, behind.wait).catch((e: unknown) => e);
    expect(neverLanded(unsure)).toBe(false);
  });

  it("keeps waiting on a failure seen only as processed, since another fork may still land it", async () => {
    const s = stub([{ err: "boom", confirmationStatus: "processed" }, { err: null, confirmationStatus: "confirmed" }]);
    await confirm(s.rpc, SIG, 10n, s.wait);
    const late = await confirm(stub([null, { err: "boom", confirmationStatus: "processed" }], [11n]).rpc, SIG, 10n).catch((e: unknown) => e);
    expect(late).toBeInstanceOf(MaybeSent);
    expect(neverLanded(late)).toBe(false);
  });

  it("says a sent transaction may have landed when its confirmation cannot be read, rather than that it failed", async () => {
    const s = stub([]);
    const throttled = { ...s.rpc, getSignatureStatuses: () => ({ send: async () => Promise.reject(new Error("HTTP error (429): Too Many Requests")) }) };
    const lost = await confirmSent(throttled, SIG, 10n, s.wait).catch((e: unknown) => e);
    expect(lost).toBeInstanceOf(MaybeSent);
    expect(lost).toMatchObject({ code: "maybe-sent", signature: SIG, lastValidBlockHeight: 10n });
    expect((lost as Error).cause).toBeInstanceOf(Error);
    expect(neverLanded(lost)).toBe(false);
    expect(rateLimited(lost)).toBe(false);
    expect((lost as Error).message).toBe(
      `transaction ${SIG} was sent but its confirmation could not be read (HTTP error (429): Too Many Requests); look the signature up before sending again`,
    );
    const failed = await confirmSent(stub([{ err: "boom", confirmationStatus: "confirmed" }]).rpc, SIG, 10n).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(FailedOnChain);
    const expired = await confirmSent(stub([null, null], [11n]).rpc, SIG, 10n).catch((e: unknown) => e);
    expect(expired).toBeInstanceOf(BlockhashExpired);
  });

  it("stops waiting on a node whose block height never moves, and says to look the signature up", async () => {
    expect(CONFIRM_POLLS).toBe(360);
    const stuck = stub([], Array.from({ length: CONFIRM_POLLS + 5 }, () => 5n));
    await expect(confirm(stuck.rpc, SIG, 10n, stuck.wait)).rejects.toThrow(
      `transaction ${SIG} was neither confirmed nor expired after ${CONFIRM_POLLS} checks; the node may be stuck, so look the signature up before sending again`,
    );
    expect(stuck.waits).toHaveLength(CONFIRM_POLLS - 1);
    const still = stub([], Array.from({ length: CONFIRM_POLLS + 5 }, () => 5n));
    const unsure = await confirm(still.rpc, SIG, 10n, still.wait).catch((e: unknown) => e);
    expect(unsure).toBeInstanceOf(MaybeSent);
    expect(neverLanded(unsure)).toBe(false);
    expect(neverLanded(new Error("fetch failed"))).toBe(false);
    expect(stuck.calls.filter((c) => c === `status:${SIG}`)).toHaveLength(CONFIRM_POLLS);
    const late = stub([...Array.from({ length: CONFIRM_POLLS - 1 }, () => null), { err: null, confirmationStatus: "confirmed" }]);
    await confirm(late.rpc, SIG, 10n, late.wait);
    expect(late.waits).toHaveLength(CONFIRM_POLLS - 1);
  });

  it("returns as soon as the signature subscription confirms, and then stops polling", async () => {
    vi.useFakeTimers();
    const s = stub([]);
    const slow = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms > 0 ? 20 : 0));
    let aborted = false;
    let confirmed = false;
    const confirming = confirm(s.rpc, SIG, 10n, slow, async (signature, signal) => {
      expect(signature).toBe(SIG);
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }).then(() => {
      confirmed = true;
    });
    await vi.advanceTimersByTimeAsync(4);
    expect(confirmed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await confirming;
    expect(aborted).toBe(true);
    expect(s.calls.filter((c) => c === `status:${SIG}`)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(POLL_MS * 10);
    expect(s.calls.filter((c) => c === `status:${SIG}`)).toHaveLength(1);
  });

  it("surfaces a failure the subscription reports, and falls back to polling when the subscription breaks", async () => {
    const failed = stub([]);
    const slow = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms > 0 ? 20 : 0));
    await expect(
      confirm(failed.rpc, SIG, 10n, slow, async () => heardSlot(SIG, { context: { slot: 1n }, value: { err: { boom: 1 } } })),
    ).rejects.toThrow(`transaction ${SIG} failed: { boom: 1 }`);
    const heard = await confirm(failed.rpc, SIG, 10n, slow, async () => heardSlot(SIG, { value: { err: { boom: 1 } } })).catch((e: unknown) => e);
    expect(heard).toBeInstanceOf(FailedOnChain);
    expect(heard).toMatchObject({ code: "failed-on-chain", signature: SIG, err: { boom: 1 }, program: null });
    const broken = stub([null, { err: null, confirmationStatus: "confirmed" }]);
    await confirm(broken.rpc, SIG, 10n, broken.wait, async () => {
      throw new Error("websocket refused");
    });
    expect(broken.calls.filter((c) => c === `status:${SIG}`)).toHaveLength(2);
  });

  it("waits half a second by default", async () => {
    vi.useFakeTimers();
    const s = stub([null, { err: null, confirmationStatus: "confirmed" }]);
    let confirmed = false;
    const confirming = confirm(s.rpc, SIG, 10n).then(() => {
      confirmed = true;
    });
    await vi.advanceTimersByTimeAsync(POLL_MS - 1);
    expect(confirmed).toBe(false);
    expect(s.calls.filter((c) => c === `status:${SIG}`)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await confirming;
    expect(confirmed).toBe(true);
    expect(s.calls.filter((c) => c === `status:${SIG}`)).toHaveLength(2);
  });
});

describe("rpc transport", () => {
  it("asks the node for an airdrop and returns once it confirms", async () => {
    const s = stub([null, { err: null, confirmationStatus: "confirmed" }]);
    const t = rpcTransport(s.rpc, s.wait);
    expect(await t.airdrop(OWNER, 5n)).toBe(SIG);
    expect(s.calls.filter((c) => c.startsWith("airdrop:") || c.startsWith("status:"))).toEqual([
      `airdrop:${OWNER}:5`,
      `status:${SIG}`,
      `status:${SIG}`,
    ]);
  });

  it("simulates without signatures against the latest blockhash and reports the outcome", async () => {
    const s = stub([]);
    const t = rpcTransport(s.rpc, s.wait);
    expect(await t.simulate("ok" as Base64EncodedWireTransaction)).toEqual({
      err: null,
      logs: ["Program log: fine"],
      unitsConsumed: 1_234n,
      accounts: [],
    });
    expect(await t.simulate("bad" as Base64EncodedWireTransaction)).toEqual({
      err: "{ InstructionError: [ 1, { Custom: 6010 } ] }",
      logs: [],
      unitsConsumed: null,
      accounts: [],
    });
    const watched = await t.simulate("ok" as Base64EncodedWireTransaction, [OWNER, OTHER]);
    expect(watched.accounts).toEqual([new Uint8Array([7, 8]), null]);
    expect(s.calls).toEqual([
      "simulate:ok:base64:false:true",
      "simulate:bad:base64:false:true",
      `simulate:ok:base64:false:true:${OWNER},${OTHER}`,
    ]);
  });

  it("decodes base64 account data and reports missing accounts", async () => {
    const t = rpcTransport(stub([]).rpc);
    expect(await t.getAccount(OWNER)).toEqual({ owner: OWNER, data: new Uint8Array([1, 2, 3]), lamports: 7n, executable: true });
    expect(await t.getAccount("So11111111111111111111111111111111111111112" as Address)).toBeNull();
    expect(await t.genesisHash()).toBe("GENESIS");
  });

  it("reads recent priority fees for the named accounts and leaves budgeting to the caller", async () => {
    const s = stub([]);
    const t = rpcTransport(s.rpc, s.wait);
    expect(await t.recentFees([OWNER, TOKEN_PROGRAM])).toEqual([5n, 9n]);
    expect(s.calls).toEqual([`fees:${OWNER},${TOKEN_PROGRAM}`]);
    const ix = { programAddress: OWNER, data: new Uint8Array([1]) };
    expect(await t.budget([ix], OWNER)).toEqual([ix]);
  });

  it("signs with the payer, sends base64 and confirms before returning", async () => {
    const s = stub([{ err: null, confirmationStatus: "confirmed" }]);
    const payer = await generateKeyPairSigner();
    const signature = await rpcTransport(s.rpc, s.wait).send([], payer);
    const own = signatureOfWire(s.sent[0] ?? "");
    expect(signature).toBe(own);
    expect(s.calls).toEqual(["send:base64", `status:${own}`]);
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(s.sent[0] ?? ""));
    expect(Object.keys(tx.signatures)).toEqual([payer.address]);
    expect(tx.signatures[payer.address]).not.toBeNull();
  });
});
