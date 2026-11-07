import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, generateKeyPairSigner } from "@solana/kit";
import { Rent } from "litesvm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Kind } from "@intent-engine/core";
import { buildOpenClaims, claimBoardAddress, findIntentPda, MIN_CLAIM_STAKE } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { RENT_TTL_MS } from "../src/agent/budget.js";
import { claimTerms } from "../src/agent/wallet/escrow-terms.js";
import { claimFloor, stakeBelowRent } from "../src/stake-floor.js";
import { ENGINE_PROBLEMS } from "../src/agent/problems.js";
import { formatAmount } from "@intent-engine/core";
import { EXIT_FAILED, EXIT_OK } from "../src/main.js";
import { cli, h, NOW, send, transport, world } from "./harness.js";

const RATES = { low: 696n, mid: 3_480n, default: 6_960n };
const SPEC = new Uint8Array(createHash("sha256").update("a job with a stake floor").digest());

let clock = 1_000_000;

const rented = (rate: bigint) => {
  h.svm.setRent(new Rent(rate, 1, 50));
  clock += RENT_TTL_MS;
  vi.setSystemTime(clock);
};

const stakeOf = (lamports: bigint) => formatAmount(lamports, 9);

const intentOf = async (owner: Address) => (await findIntentPda({ owner, nonce: 0n }))[0];

describe("the claim stake floor follows the cluster rent", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    vi.setSystemTime(clock);
    await world();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("follows a rent change after the lifetime of the rate it read, not before", async () => {
    rented(RATES.default);
    expect(await claimFloor(transport)).toBe(128n * RATES.default);
    h.svm.setRent(new Rent(RATES.low, 1, 50));
    expect(await claimFloor(transport)).toBe(128n * RATES.default);
    vi.setSystemTime(clock + RENT_TTL_MS - 1);
    expect(await claimFloor(transport)).toBe(128n * RATES.default);
    vi.setSystemTime(clock + RENT_TTL_MS);
    expect(await claimFloor(transport)).toBe(128n * RATES.low);
  });

  it("is the rent-exempt minimum of an empty account at whatever rate the rent sysvar holds", async () => {
    const floors = new Set<bigint>();
    for (const rate of Object.values(RATES)) {
      rented(rate);
      const floor = await claimFloor(transport);
      expect(floor).toBe(h.svm.minimumBalanceForRentExemption(0n));
      expect(floor).toBe(128n * rate);
      floors.add(floor);
    }
    expect(floors.size).toBe(3);
    rented(RATES.default);
    expect(await claimFloor(transport)).toBe(MIN_CLAIM_STAKE);
  });

  it("decides a stake of the escrow tools on that floor", async () => {
    for (const rate of Object.values(RATES)) {
      rented(rate);
      const floor = 128n * rate;
      const terms = (stake: bigint) => claimTerms({ claim_stake: stakeOf(stake), claim_secs: 60, review_secs: 0 }, false, transport);
      await expect(terms(floor)).resolves.toMatchObject({ stake: floor, floor });
      await expect(terms(floor - 1n)).rejects.toMatchObject({ issues: [{ path: "claim_stake", message: stakeBelowRent(floor) }] });
    }
    await expect(claimTerms({ claim_stake: "0", claim_secs: 60, review_secs: 0 }, false, transport)).resolves.toMatchObject({ stake: 0n });
  });

  it("says what the program says about a stake below it", () => {
    expect(stakeBelowRent(MIN_CLAIM_STAKE)).toContain(`0 or at least ${stakeOf(MIN_CLAIM_STAKE)} SOL`);
    expect(ENGINE_PROBLEMS.StakeBelowRent.hint.startsWith(stakeBelowRent(MIN_CLAIM_STAKE).replace(/^StakeBelowRent: /, "").split(",")[0]?.slice(0, 22) ?? "")).toBe(true);
  });

  it("opens claims on the chain at the floor the cluster has, and not below it", async () => {
    const w = await world();
    const judge = (await generateKeyPairSigner()).address;
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge, specHash: SPEC, judgeFee: 0n } as const;
    const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
    rented(RATES.low);
    const low = await claimFloor(transport);
    expect(low).toBeLessThan(MIN_CLAIM_STAKE);
    await expect(buildOpenClaims({ owner: w.owner, intent, maxSecs: 60, stake: low })).rejects.toMatchObject({ code: "invalid-input" });
    await send(w.owner, [await buildOpenClaims({ owner: w.owner, intent, maxSecs: 60, stake: low, floor: low })]);
    expect(h.svm.getAccount(await claimBoardAddress(intent)).exists).toBe(true);
  });

  it("refuses on the chain a stake below the floor the cluster has, as the builder does", async () => {
    const w = await world();
    const judge = (await generateKeyPairSigner()).address;
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge, specHash: SPEC, judgeFee: 0n } as const;
    const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
    rented(RATES.mid);
    const mid = await claimFloor(transport);
    const unsound = await buildOpenClaims({ owner: w.owner, intent, maxSecs: 60, stake: mid - 1n, floor: 1n });
    await expect(send(w.owner, [unsound])).rejects.toThrow();
    expect(h.svm.getAccount(await claimBoardAddress(intent)).exists).toBe(false);
    await expect(buildOpenClaims({ owner: w.owner, intent, maxSecs: 60, stake: mid - 1n, floor: mid })).rejects.toMatchObject({ code: "invalid-input" });
    await send(w.owner, [await buildOpenClaims({ owner: w.owner, intent, maxSecs: 60, stake: mid, floor: mid })]);
    expect(h.svm.getAccount(await claimBoardAddress(intent)).exists).toBe(true);
  });

  it("checks claims open --stake against the cluster rent before it sends", async () => {
    const w = await world();
    const judge = (await generateKeyPairSigner()).address;
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge, specHash: SPEC, judgeFee: 0n } as const;
    await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
    const open = (stake: bigint) => cli(["claims", "open", "--review-secs", "0", "--keypair", "owner.json", "--nonce", "0", "--max-secs", "60", "--stake", stakeOf(stake), "--yes"], { "owner.json": w.owner });
    rented(RATES.low);
    const low = 128n * RATES.low;
    const below = await open(low - 1n);
    expect([below.code, below.err]).toEqual([EXIT_FAILED, stakeBelowRent(low)]);
    expect(h.svm.getAccount(await claimBoardAddress(await intentOf(w.owner.address))).exists).toBe(false);
    const sent = await open(low);
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    expect(h.svm.getAccount(await claimBoardAddress(await intentOf(w.owner.address))).exists).toBe(true);
  });
});

describe("the guide quotes the stake rule the program has", () => {
  const guide = readFileSync(join(process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url)), "docs", "judge.md"), "utf8");

  it("says 0 or the rent-exempt minimum of an empty account on the cluster, not a fixed amount", () => {
    const rule = guide.split("\n").find((line) => line.includes("A stake is 0 or at least")) ?? "";
    expect(rule).toContain("A stake is 0 or at least the rent-exempt minimum of an empty account on this cluster");
    expect(rule).not.toContain(stakeOf(MIN_CLAIM_STAKE));
    expect(guide).not.toMatch(/at least 0\.\d+ SOL, the rent-exempt/);
  });
});
