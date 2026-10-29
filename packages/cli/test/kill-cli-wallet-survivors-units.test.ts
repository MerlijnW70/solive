import { type Address, createNoopSigner, generateKeyPairSigner, lamports, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { formatAmount } from "@intent-engine/core";
import { FirstOpeningRefused, type Transport } from "@intent-engine/client";
import { testSignature } from "@intent-engine/client/testing";
import type { AgentContext } from "../src/agent/actions.js";
import { AgentRefusal } from "../src/agent/problems.js";
import { stakeReturned } from "../src/agent/wallet/attest.js";
import { planOf, proofEscrow } from "../src/agent/wallet/delivery.js";
import { claimsAfter, sealedLimits } from "../src/agent/wallet/escrow-claims.js";
import { rpcRefused } from "../src/agent/wallet/guard.js";
import { GIVE_KEY_SETTING, KEY_ON_DEVICE, refused } from "../src/agent/wallet/openings.js";
import { aroundRelease } from "../src/agent/wallet/releases.js";
import { created, fresh, ok } from "./agent-wallet-kit.js";
import { h, transport } from "./harness.js";
import { approved } from "./approved.js";

const httpError = (statusCode: number) => new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers(), message: "refused", statusCode });

const failing = (code: string) => Object.assign(new Error("transport failed"), { code });

describe("which RPC failures count as refused before sending", () => {
  it("treats a client error status as a refusal and nothing else as one", () => {
    expect(rpcRefused(httpError(399))).toBe(false);
    expect(rpcRefused(httpError(400))).toBe(true);
    expect(rpcRefused(httpError(499))).toBe(true);
    expect(rpcRefused(httpError(500))).toBe(false);
    expect(rpcRefused(httpError(200))).toBe(false);
    expect(rpcRefused(httpError(700))).toBe(false);
  });

  it("treats an unreached node as a refusal, a dropped connection as unknown, and an unrelated error as neither", () => {
    expect(rpcRefused(failing("ECONNREFUSED"))).toBe(true);
    expect(rpcRefused(failing("ECONNRESET"))).toBe(false);
    expect(rpcRefused(new Error("plain"))).toBe(false);
    expect(rpcRefused("text")).toBe(false);
  });
});

describe("the stake line of a release", () => {
  it("names a returned stake only when there is a stake and someone to return it to", async () => {
    const worker = (await generateKeyPairSigner()).address;
    expect(stakeReturned(5_000_000n, undefined)).toStrictEqual([]);
    expect(stakeReturned(0n, worker)).toStrictEqual([]);
    expect(stakeReturned(5_000_000n, worker)).toStrictEqual([`Returns: the claim stake of ${formatAmount(5_000_000n, 9)} SOL to ${worker}`]);
  });
});

describe("the lines about claims and their sends", () => {
  it("counts the wallets a sealed spec invites and the transactions the claims need", async () => {
    const [a, b] = [(await generateKeyPairSigner()).address, (await generateKeyPairSigner()).address];
    expect(sealedLimits([a])).toBe(`Limits: claims to the 1 wallet the sealed spec invites, leaving out the owner and the attestor: ${a}; the program refuses a claim or stand-by from any other`);
    expect(sealedLimits([a, b])).toBe(`Limits: claims to the 2 wallets the sealed spec invites, leaving out the owner and the attestor: ${a}, ${b}; the program refuses a claim or stand-by from any other`);
    expect(claimsAfter(1)).toBe("Sends: the claims and their list in 1 more transaction once the escrow lands, since they do not fit beside it; the escrow takes no claim until they land");
    expect(claimsAfter(3)).toBe("Sends: the claims and their list in 3 more transactions once the escrow lands, since they do not fit beside it; the escrow takes no claim until they land");
  });
});

describe("the refusal a first opening explains", () => {
  const sealed = (wallet: Address, kind: "wallet" | "profile") => ({ wallet, kind, fingerprint: "ab".repeat(4), published: true });

  async function refusal(reason: "key-not-given" | "nothing-opens", slots: ReturnType<typeof sealed>[]) {
    const intent = (await generateKeyPairSigner()).address;
    return new FirstOpeningRefused(intent, "ab".repeat(32), { reason, sealedTo: slots });
  }

  it("names the Ledger limit only for a Ledger judge whose own wallet key was the one an earlier announcement was sealed to", async () => {
    const judge = (await generateKeyPairSigner()).address;
    const other = (await generateKeyPairSigner()).address;
    const own = await refusal("key-not-given", [sealed(judge, "wallet")]);
    const onDevice = refused(own, true, judge, true);
    expect(onDevice.problem.code).toBe("KeyNotGiven");
    expect(onDevice.problem.hint).toBe(`${own.message}; ${KEY_ON_DEVICE}`);
    const off = refused(own, false, judge, true);
    expect(off.problem.hint).toBe(`${own.message}; ${GIVE_KEY_SETTING}`);
    const profile = await refusal("key-not-given", [sealed(judge, "profile")]);
    expect(refused(profile, true, judge, true).problem.hint).toBe(`${profile.message}; ${GIVE_KEY_SETTING}`);
    const foreign = await refusal("key-not-given", [sealed(other, "wallet")]);
    expect(refused(foreign, true, judge, true).problem.hint).toBe(`${foreign.message}; ${GIVE_KEY_SETTING}`);
    const nothing = await refusal("nothing-opens", [sealed(judge, "wallet")]);
    expect(refused(nothing, true, judge, true).problem.code).toBe("NotAnnounced");
  });
});

describe("the release lookup around a transport without paged history", () => {
  it("reads the creation after the release and calls the history complete when the release is the newest entry", async () => {
    const owner = (await generateKeyPairSigner()).address;
    const intent = (await generateKeyPairSigner()).address;
    const release = { signature: testSignature("release"), slot: 9n, blockTime: null, failed: false, emitted: [] };
    const creation = { signature: testSignature("creation"), slot: 3n, blockTime: null, failed: false, emitted: [created(intent, owner, 0n)] };
    const via = (found: unknown[]) => ({ engineTransactions: async () => found }) as unknown as Transport;
    expect(await aroundRelease(via([release, creation]), intent, release)).toStrictEqual({ creation, later: false, complete: true });
    expect(await aroundRelease(via([creation, release]), intent, release)).toStrictEqual({ creation: null, later: true, complete: true });
    expect(await aroundRelease(via([creation]), intent, release)).toStrictEqual({ creation: null, later: true, complete: false });
    expect(await aroundRelease(via([]), intent, release)).toStrictEqual({ creation: null, later: false, complete: false });
  });
});

describe("the proof escrow a delivery names", () => {
  async function escrow() {
    const client = await fresh();
    const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    h.watched.push(wallet);
    h.engineLog = [];
    const made = await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: wallet, spec_hash: "5c".repeat(32) }));
    return { wallet, intent: made["intent"] as Address };
  }

  const context = () => ({ transport, url: "http://cluster" }) as unknown as AgentContext;

  function planted(at: Address, from: Address, owner: Address, extra = 0) {
    const held = h.svm.getAccount(from);
    if (!held.exists) {
      throw new Error("the escrow was not created");
    }
    h.svm.setAccount({ ...held, address: at, programAddress: owner, lamports: lamports(5_000_000n), data: Uint8Array.from([...held.data, ...new Uint8Array(extra)]) });
  }

  it("reads an intent account and refuses every account that is not one", async () => {
    const { intent } = await escrow();
    expect((await proofEscrow(context(), intent, "wallet_receipt")).held.status).toBeDefined();
    const none = (await generateKeyPairSigner()).address;
    await expect(proofEscrow(context(), none, "wallet_receipt")).rejects.toBeInstanceOf(AgentRefusal);
    await expect(proofEscrow(context(), none, "wallet_receipt")).rejects.toMatchObject({ problem: { code: "NotFound" } });
    const foreign = (await generateKeyPairSigner()).address;
    planted(foreign, intent, "11111111111111111111111111111111" as Address);
    await expect(proofEscrow(context(), foreign, "wallet_receipt")).rejects.toMatchObject({ problem: { code: "NotFound" } });
    const longer = (await generateKeyPairSigner()).address;
    const program = h.svm.getAccount(intent);
    if (!program.exists) {
      throw new Error("the escrow was not created");
    }
    planted(longer, intent, program.programAddress, 1);
    await expect(proofEscrow(context(), longer, "wallet_receipt")).rejects.toMatchObject({ problem: { code: "NotFound" } });
  });

  it("adds the salt signature hint to a missing message signer only when the caller asks for it", async () => {
    const { intent } = await escrow();
    const worker = createNoopSigner((await generateKeyPairSigner()).address);
    const input = { worker, intent, sha256: "e7".repeat(32), url: "https://" + "example.org/work.tar" };
    const plain = await planOf(context(), input).catch((error: unknown) => error);
    expect(plain).toBeInstanceOf(AgentRefusal);
    expect((plain as AgentRefusal).problem.code).toBe("NoMessageSigner");
    expect((plain as AgentRefusal).problem.hint).not.toContain("salt_signature");
    const hinted = await planOf(context(), input, true).catch((error: unknown) => error);
    expect((hinted as AgentRefusal).problem.hint).toContain(`${(plain as AgentRefusal).problem.hint}; or pass salt_signature: the worker's ed25519 signature of the message `);
    const signed = await planOf(context(), { ...input, saltSignature: new Uint8Array(64) }, true).catch((error: unknown) => error);
    expect((signed as Error).message).not.toContain("or pass salt_signature");
  });
});
