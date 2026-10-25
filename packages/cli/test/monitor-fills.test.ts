import { type Address, generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  EVENT_IX_TAG,
  getFillBegunEventEncoder,
  getFillEndedEventEncoder,
  getIntentDecoder,
  getIntentEncoder,
  getIntentSize,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  INTENT_VERSION,
} from "@intent-engine/core/internal";
import type { EngineTransaction, Transport } from "@intent-engine/client";
import { fillsIn, inputMintsOf, type SeenFill } from "../src/monitor-fills.js";

const tagged = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);

const begun = (intent: Address, amountIn: bigint) =>
  tagged(
    getFillBegunEventEncoder().encode({
      intent,
      solver: intent,
      solverInput: intent,
      endIndex: 1,
      amountIn,
      fee: 0n,
      net: amountIn,
      filled: amountIn,
      remaining: 0n,
      partnerFee: 0n,
    }),
  );

const ended = (intent: Address) =>
  tagged(getFillEndedEventEncoder().encode({ intent, owner: intent, solver: intent, receiver: intent, delivered: 7n, required: 7n }));

const tx = (signature: string, emitted: Uint8Array[]): EngineTransaction => ({ signature, slot: 3n, blockTime: null, failed: false, emitted });

const address = async () => (await generateKeyPairSigner()).address;

const intentData = (inputMint: Address, version = INTENT_VERSION) =>
  Uint8Array.from(getIntentEncoder().encode({ ...getIntentDecoder().decode(new Uint8Array(getIntentSize())), inputMint, version }));

describe("fills the monitor reads from engine transactions", () => {
  it("pays a two-step fill the amount its begin step drew", async () => {
    const intent = await address();
    expect(fillsIn([tx("two-step", [begun(intent, 42n), ended(intent)])]).fills).toEqual([
      { signature: "two-step", slot: 3n, intent, amountIn: 42n },
    ]);
  });

  it("looks up the input mint of every fill whose creation it did not see", async () => {
    const addresses = await Promise.all(Array.from({ length: 7 }, address));
    const [seen, engineOwned, foreign, missing, mint, other, newer] = addresses as [Address, Address, Address, Address, Address, Address, Address];
    const asked: Address[][] = [];
    const accounts: Record<string, { owner: Address; data: Uint8Array; lamports: bigint } | null> = {
      [engineOwned]: { owner: INTENT_ENGINE_PROGRAM_ADDRESS, data: intentData(mint), lamports: 1n },
      [foreign]: { owner: other, data: intentData(mint), lamports: 1n },
      [missing]: null,
      [newer]: { owner: INTENT_ENGINE_PROGRAM_ADDRESS, data: intentData(mint, INTENT_VERSION + 1), lamports: 1n },
    };
    const transport = {
      getAccounts: async (addresses: Address[]) => {
        asked.push(addresses);
        return addresses.map((a) => accounts[a] ?? null);
      },
    } as unknown as Transport;
    const fill = (intent: Address): SeenFill => ({ signature: intent, slot: 1n, intent, amountIn: 1n });
    const mints = await inputMintsOf(transport, [fill(seen), fill(engineOwned), fill(foreign), fill(missing), fill(engineOwned), fill(newer)], new Map([[seen, other]]));
    expect(asked).toEqual([[engineOwned, foreign, missing, newer]]);
    expect([...mints.entries()]).toEqual([
      [seen, other],
      [engineOwned, mint],
    ]);
    expect(await inputMintsOf(transport, [fill(seen)], new Map([[seen, other]]))).toEqual(new Map([[seen, other]]));
    expect(asked).toHaveLength(1);
  });
});
