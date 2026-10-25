import { type Address, type Base64EncodedWireTransaction, generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, type Intent, IntentStatus, Kind, splitFees } from "@intent-engine/core";
import { encodeParams, findConfigPda, findEventAuthorityPda, INSTRUCTIONS_SYSVAR_ADDRESS, findUserStatePda } from "@intent-engine/core/internal";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  COMPUTE_BUDGET_ADDRESS,
  computeUnitLimit,
  computeUnitPrice,
  accountsOf,
  bytesFit,
  fillInstructions,
  headroom,
  JITO_TIP_ACCOUNTS,
  locksFit,
  lookupTablesOf,
  MAX_TX_ACCOUNTS,
  PACKET_DATA_SIZE,
  solverTableAccounts,
  TOKEN_PROGRAMS,
  wireSize,
  MAX_COMPUTE_UNITS,
  MAX_MICRO_LAMPORTS,
  payoutAccounts,
  type Plan,
  UNIT_HEADROOM_DIVISOR,
  UNIT_HEADROOM_FLOOR,
} from "../src/index.js";

const OWNER = "11111111111111111111111111111112" as Address;
const INPUT = "So11111111111111111111111111111111111111112" as Address;
const OUTPUT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
const PARTNER = "SysvarC1ock11111111111111111111111111111111" as Address;
const TREASURY = "SysvarRent111111111111111111111111111111111" as Address;
const AMOUNT = 100_000n;

const MANDATE = "SysvarS1otHashes111111111111111111111111111" as Address;
const NONE = "11111111111111111111111111111111" as Address;

function plan(feeBps: number, partnerBps: number, mandate: Address = NONE, agentFee = 0n): Plan {
  const intent: Intent = {
    discriminator: new Uint8Array(8),
    owner: OWNER,
    inputMint: INPUT,
    outputMint: OUTPUT,
    receiver: OWNER,
    nonce: 1n,
    escrowed: AMOUNT,
    createdAt: 0n,
    expiresAt: 60n,
    kind: Kind.SwapExactIn,
    status: IntentStatus.Open,
    bump: 255,
    vaultBump: 255,
    version: 2,
    padding: new Uint8Array(1),
    flags: 0,
    params: encodeParams({ kind: Kind.SwapExactIn, amountIn: AMOUNT, minOut: 1n }),
    rentPayer: OWNER,
    filled: 0n,
    revision: 0,
    partnerBps,
    partnerCutBps: 0,
    inFlight: 0n,
    partner: PARTNER,
    bounty: 0,
    mandate,
    feeBps,
    gap: new Uint8Array(2),
    mandateSerial: mandate === NONE ? 0n : 1n,
    agentFee,
    claims: 0,
    gap2: new Uint8Array(7),
    capped: 0n,
  };
  const fees = splitFees(AMOUNT, feeBps, partnerBps, 0);
  return {
    address: OWNER,
    intent,
    amountIn: AMOUNT,
    required: 1n,
    feeBps,
    fees,
    route: { amountIn: fees.net, amountOut: 2n, instructions: [], lookupTables: [] },
    arbitrage: null,
    profit: 1n,
  };
}

const ata = (owner: Address) =>
  findAssociatedTokenAddress({ owner, mint: INPUT, tokenProgram: TOKEN_PROGRAM_ADDRESS });

describe("transaction limits", () => {
  it("names the fixed accounts a solver can keep in its own lookup table", async () => {
    const solver = (await generateKeyPairSigner()).address;
    const [config] = await findConfigPda();
    const [events] = await findEventAuthorityPda();
    const fee = await ata(TREASURY);
    const own = await findAssociatedTokenAddress({ owner: solver, mint: INPUT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const listed = await solverTableAccounts(solver, TREASURY, [
      { mint: INPUT, tokenProgram: TOKEN_PROGRAM_ADDRESS },
      { mint: INPUT, tokenProgram: TOKEN_PROGRAM_ADDRESS },
    ]);
    expect(listed).toEqual([config, events, INSTRUCTIONS_SYSVAR_ADDRESS, ...TOKEN_PROGRAMS, ...JITO_TIP_ACCOUNTS, fee, own]);
    expect(TOKEN_PROGRAMS).toEqual([TOKEN_PROGRAM_ADDRESS, "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);
    expect(await solverTableAccounts(solver, TREASURY, [])).toHaveLength(5 + JITO_TIP_ACCOUNTS.length);
  });

  it("puts the solver's own tables first and lists each table once", () => {
    const p = plan(0, 0);
    const route = { ...p, route: { ...p.route, lookupTables: [PARTNER, MANDATE] } };
    expect(lookupTablesOf(route, [MANDATE, TREASURY])).toEqual([MANDATE, TREASURY, PARTNER]);
    expect(lookupTablesOf(route)).toEqual([PARTNER, MANDATE]);
  });

  it("counts every distinct account a transaction locks and the bytes it sends", () => {
    expect([PACKET_DATA_SIZE, MAX_TX_ACCOUNTS]).toEqual([1_232, 64]);
    const ix = { programAddress: PARTNER, accounts: [{ address: OWNER, role: 0 }, { address: TREASURY, role: 1 }] };
    expect(accountsOf([ix, { ...ix, programAddress: OWNER }], TREASURY)).toBe(3);
    expect(accountsOf([], MANDATE)).toBe(1);
    expect(wireSize("AAEC" as Base64EncodedWireTransaction)).toBe(3);
    expect([locksFit(64), locksFit(65), bytesFit(1_232), bytesFit(1_233)]).toEqual([true, false, true, false]);
  });
});

describe("fill building", () => {
  it("encodes a compute unit limit little-endian and refuses one outside 1 to the maximum", () => {
    expect(computeUnitLimit(0x12_34_56)).toEqual({
      programAddress: COMPUTE_BUDGET_ADDRESS,
      data: Uint8Array.from([2, 0x56, 0x34, 0x12, 0]),
    });
    expect(Array.from(computeUnitLimit(1).data ?? [])).toEqual([2, 1, 0, 0, 0]);
    expect(computeUnitLimit(MAX_COMPUTE_UNITS).data).toHaveLength(5);
    for (const bad of [0, MAX_COMPUTE_UNITS + 1, 1.5]) {
      expect(() => computeUnitLimit(bad)).toThrow(`a compute unit limit must be 1 to ${MAX_COMPUTE_UNITS}, got ${bad}`);
    }
  });

  it("pads measured units by a tenth plus a floor and never asks for more than the maximum", () => {
    expect([UNIT_HEADROOM_DIVISOR, UNIT_HEADROOM_FLOOR]).toEqual([10n, 1_000n]);
    expect(headroom(0n)).toBe(1_000);
    expect(headroom(20_000n)).toBe(23_000);
    expect(headroom(20_009n)).toBe(23_009);
    expect(headroom(1_271_818n)).toBe(1_399_999);
    expect(headroom(1_271_819n)).toBe(MAX_COMPUTE_UNITS);
    expect(headroom(1_271_820n)).toBe(MAX_COMPUTE_UNITS);
    expect(headroom(5_000_000n)).toBe(MAX_COMPUTE_UNITS);
  });

  it("encodes a compute unit price little-endian and refuses one outside u64", () => {
    expect(computeUnitPrice(0x0102_0304_0506_0708n)).toEqual({
      programAddress: COMPUTE_BUDGET_ADDRESS,
      data: Uint8Array.from([3, 8, 7, 6, 5, 4, 3, 2, 1]),
    });
    expect(Array.from(computeUnitPrice(0n).data ?? [])).toEqual([3, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(computeUnitPrice(MAX_MICRO_LAMPORTS).data ?? [])).toEqual([3, 255, 255, 255, 255, 255, 255, 255, 255]);
    expect(MAX_MICRO_LAMPORTS).toBe(18_446_744_073_709_551_615n);
    for (const bad of [-1n, MAX_MICRO_LAMPORTS + 1n]) {
      expect(() => computeUnitPrice(bad)).toThrow(`a compute unit price must be 0 to ${MAX_MICRO_LAMPORTS} micro-lamports, got ${bad}`);
    }
  });

  it("pays into the fee and partner accounts only when each receives something", async () => {
    expect(await payoutAccounts(plan(0, 0), TREASURY, TOKEN_PROGRAM_ADDRESS)).toEqual([]);
    expect(await payoutAccounts(plan(5, 50), TREASURY, TOKEN_PROGRAM_ADDRESS)).toEqual([
      { name: "fee", address: await ata(TREASURY) },
      { name: "partner", address: await ata(PARTNER) },
    ]);
    expect(await payoutAccounts(plan(0, 50), TREASURY, TOKEN_PROGRAM_ADDRESS)).toEqual([
      { name: "partner", address: await ata(PARTNER) },
    ]);
    expect(await payoutAccounts(plan(0, 0, MANDATE, 7n), TREASURY, TOKEN_PROGRAM_ADDRESS)).toEqual([
      { name: "agent", address: await ata(OWNER) },
    ]);
  });

  it("pays the agent that created an intent only when the intent carries a fee", async () => {
    const solver = await generateKeyPairSigner();
    const accounts = async (p: Plan) =>
      (
        await fillInstructions(p, {
          solver,
          feeRecipient: TREASURY,
          inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
          outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
          computeUnits: 200_000,
          unitPrice: 0n,
          createSolverInput: false,
          createSolverOutput: false,
          tip: null,
        })
      ).flatMap((ix) => (ix.accounts ?? []).map((a) => a.address));
    const agent = await ata(OWNER);
    expect(await accounts(plan(0, 0, MANDATE))).not.toContain(agent);
    expect(await accounts(plan(0, 0, MANDATE, 7n))).toContain(agent);
  });

  it("names the fee account in the fill only when the protocol takes a fee", async () => {
    const solver = await generateKeyPairSigner();
    const accounts = async (p: Plan) =>
      (
        await fillInstructions(p, {
          solver,
          feeRecipient: TREASURY,
          inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
          outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
          computeUnits: 200_000,
          unitPrice: 0n,
          createSolverInput: false,
          createSolverOutput: false,
          tip: null,
        })
      ).flatMap((ix) => (ix.accounts ?? []).map((a) => a.address));
    const fee = await ata(TREASURY);
    expect(await accounts(plan(0, 0))).not.toContain(fee);
    expect(await accounts(plan(5, 0))).toContain(fee);
  });

  it("names the mandate and its owner's state only for an intent an agent created", async () => {
    const solver = await generateKeyPairSigner();
    const accounts = async (p: Plan) =>
      (
        await fillInstructions(p, {
          solver,
          feeRecipient: TREASURY,
          inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
          outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
          computeUnits: 200_000,
          unitPrice: 0n,
          createSolverInput: false,
          createSolverOutput: false,
          tip: null,
        })
      ).flatMap((ix) => (ix.accounts ?? []).map((a) => a.address));
    const [ownerState] = await findUserStatePda({ owner: OWNER });
    const mandated = await accounts(plan(0, 0, MANDATE));
    expect(mandated).toContain(MANDATE);
    expect(mandated).toContain(ownerState);
    const own = await accounts(plan(0, 0));
    expect(own).not.toContain(MANDATE);
    expect(own).not.toContain(ownerState);
  });
});
