import {
  appendTransactionMessageInstructions,
  type Base64EncodedWireTransaction,
  getBase64Encoder,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  type Instruction,
  type KeyPairSigner,
  pipe,
  setTransactionMessageFeePayerSigner,
  signBytes,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { buildEd25519Instruction } from "@intent-engine/core/internal";
import { budgeted, budgetShape, packed, PACKET_DATA_SIZE } from "@intent-engine/client/internal";
import { COMPUTE_BUDGET_ADDRESS, computeUnitLimit, computeUnitPrice } from "@intent-engine/core/internal";
import type { Transport } from "@intent-engine/client";
import type { AgentContext } from "../src/agent/actions.js";
import { prepare, transactionSize } from "../src/agent/prepare.js";
import { fitted } from "../src/agent/wallet/release-size.js";
import { funded, h, PACKET_LIMIT, send, tooLarge, transport, world } from "./harness.js";

const PROBE = 900;

async function verify(payer: KeyPairSigner, length: number): Promise<Instruction> {
  const message = new Uint8Array(length).fill(7);
  return buildEd25519Instruction({ publicKey: payer.address, signature: await signBytes(payer.keyPair.privateKey, message), message });
}

async function sized(payer: KeyPairSigner, bytes: number, after: readonly Instruction[] = []): Promise<Instruction> {
  const base = await transactionSize(transport, [await verify(payer, PROBE), ...after], payer.address);
  const ix = await verify(payer, PROBE + bytes - base);
  expect(await transactionSize(transport, [ix, ...after], payer.address)).toBe(bytes);
  return ix;
}

async function wireOf(payer: KeyPairSigner, ix: Instruction): Promise<Base64EncodedWireTransaction> {
  h.svm.expireBlockhash();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => h.svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
    (m) => appendTransactionMessageInstructions([ix], m),
  );
  return getBase64EncodedWireTransaction(await signTransactionMessageWithSigners(message));
}

const context = { transport } as AgentContext;

describe("the packet limit at its exact edge", () => {
  let payer: KeyPairSigner;

  beforeEach(async () => {
    await world();
    payer = await funded();
  });

  it("pins the limit every check uses to the cluster's 1232 bytes", () => {
    expect([PACKET_LIMIT, PACKET_DATA_SIZE]).toEqual([1_232, 1_232]);
    expect(h.packetLimit).toBe(true);
  });

  it("lands a 1232-byte transaction through the harness send and refuses a 1233-byte one", async () => {
    const at = await sized(payer, 1_232);
    const over = await sized(payer, 1_233);
    await expect(send(payer, [over])).rejects.toThrow(tooLarge(1_233));
    await expect(send(payer, [at])).resolves.toEqual(expect.any(String));
  });

  it("refuses a 1233-byte wire on sendWire, submitWire, simulate and the svm itself, and lets 1232 bytes through", async () => {
    const at = await sized(payer, 1_232);
    const over = await sized(payer, 1_233);
    const latest = await transport.latestBlockhash();
    await expect(transport.sendWire(await wireOf(payer, over), latest)).rejects.toThrow(tooLarge(1_233));
    await expect(transport.submitWire(await wireOf(payer, over))).rejects.toThrow(tooLarge(1_233));
    await expect(transport.simulate(await wireOf(payer, over))).rejects.toThrow(tooLarge(1_233));
    h.dropSubmits = true;
    await expect(transport.submitWire(await wireOf(payer, over))).rejects.toThrow(tooLarge(1_233));
    expect(h.submitted).toEqual([]);
    h.dropSubmits = false;
    h.sendFails = { error: new Error("dropped"), landed: false };
    await expect(transport.sendWire(await wireOf(payer, over), latest)).rejects.toThrow(tooLarge(1_233));
    expect(h.sendFails).not.toBeNull();
    h.sendFails = null;
    const wires = h.wires.length;
    await expect(transport.simulate(await wireOf(payer, at))).resolves.toMatchObject({ err: null });
    await expect(transport.sendWire(await wireOf(payer, at), latest)).resolves.toEqual(expect.any(String));
    await expect(transport.submitWire(await wireOf(payer, at))).resolves.toEqual(expect.any(String));
    expect(h.wires.length - wires).toBe(2);
  });

  it("lands a 1233-byte transaction only in a test that turns the limit off by name", async () => {
    const over = await sized(payer, 1_233);
    h.packetLimit = false;
    await expect(send(payer, [over])).resolves.toEqual(expect.any(String));
  });

  it("a release of exactly 1232 bytes passes the wallet size check and 1233 bytes is refused as too large", async () => {
    const at = await sized(payer, 1_232);
    const over = await sized(payer, 1_233);
    await expect(fitted(context, [at], payer.address, undefined, (size) => `size ${size}`)).resolves.toEqual([at]);
    await expect(fitted(context, [over], payer.address, undefined, (size) => `size ${size}`)).rejects.toMatchObject({ problem: { code: "ReleaseTooLarge", hint: "size 1233" } });
  });

  it("keeps setup in the release transaction up to 1232 bytes and sends it first from 1233 bytes", async () => {
    const [setup, ed, settle] = [await verify(payer, 1), await verify(payer, 2), await verify(payer, 3)];
    const measuring = (bytes: number) => async (instructions: readonly Instruction[]) => (instructions.length === 3 ? bytes : 0);
    expect(await packed(measuring(1_231), [setup], [ed, settle])).toEqual({ setup: [], instructions: [setup, ed, settle] });
    expect(await packed(measuring(1_232), [setup], [ed, settle])).toEqual({ setup: [], instructions: [setup, ed, settle] });
    expect(await packed(measuring(1_233), [setup], [ed, settle])).toEqual({ setup: [setup], instructions: [ed, settle] });
    expect(await packed(measuring(5_000), [], [ed, settle])).toEqual({ setup: [], instructions: [ed, settle] });
  });

  it("sends the very budget it measured, so a priority price that changes between the two cannot grow the release past the limit", async () => {
    let asked = 0;
    const flaky: Transport = {
      ...transport,
      budget: async (instructions: readonly Instruction[]) => {
        if (instructions.some((ix) => ix.programAddress === COMPUTE_BUDGET_ADDRESS)) {
          return [...instructions];
        }
        asked += 1;
        return [...instructions, computeUnitLimit(200_000), ...(asked > 1 ? [computeUnitPrice(5n)] : [])];
      },
    };
    const at = await sized(payer, 1_232, [computeUnitLimit(200_000)]);
    const measured = await fitted({ transport: flaky } as AgentContext, [at], payer.address, undefined, (size) => `size ${size}`);
    const prepared = await prepare(flaky, measured, payer.address, undefined, false);
    expect(getBase64Encoder().encode(prepared.transaction).length).toBe(1_232);
    expect(asked).toBe(1);
  });

  it("measures an auto priority with its price instruction, so the client's measure is never smaller than what it sends", async () => {
    const at = await sized(payer, 1_000);
    const sizeWith = (instructions: readonly Instruction[]) => transactionSize(transport, instructions, payer.address);
    const auto = await sizeWith(budgetShape("auto", [at]));
    expect(auto).toBe(await sizeWith([at, computeUnitLimit(1), computeUnitPrice(1n)]));
    expect(await sizeWith(budgetShape(7n, [at]))).toBe(auto);
    expect(await sizeWith(budgetShape(0n, [at]))).toBe(await sizeWith([at, computeUnitLimit(1)]));
    expect(await sizeWith(await budgeted(transport, "auto", [at], payer.address))).toBeLessThanOrEqual(auto);
  });
});
