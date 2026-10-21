import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { Kind } from "@intent-engine/core";
import { createClient, NoKeyAtCreation, ProfileHistoryIncomplete } from "@intent-engine/client";
import { parse } from "../src/args.js";
import { judgeDigest, type JudgeDigestCommand } from "../src/judge-digest.js";
import { JudgeRefused } from "../src/judge-errors.js";
import { historyRefused } from "../src/judge.js";
import { creation, h, NOW, transport, world } from "./harness.js";

async function escrow(): Promise<{ owner: Address; intent: Address; payTo: Address }> {
  const w = await world();
  const judge = await generateKeyPairSigner();
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 2n, maxResult: 4n, attestor: judge.address, specHash: new Uint8Array(createHash("sha256").update("spec").digest()), judgeFee: 0n } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  h.engineLog = [creation(intent)];
  return { owner: w.owner.address, intent, payTo: (await generateKeyPairSigner()).address };
}

const digestOf = (owner: Address, payTo: Address, result?: string) =>
  judgeDigest(parse(["judge", "digest", "--owner", owner, "--nonce", "0", "--pay-to", payTo, ...(result === undefined ? [] : ["--result", result])], {}) as JudgeDigestCommand, transport);

describe("judge digest results", () => {
  it("takes the escrow's lowest and highest result and refuses one outside them", async () => {
    const { owner, intent, payTo } = await escrow();
    expect(await digestOf(owner, payTo)).toMatchObject({ intent, result: 2n });
    expect(await digestOf(owner, payTo, "4")).toMatchObject({ intent, result: 4n });
    for (const result of ["1", "5"]) {
      await expect(digestOf(owner, payTo, result)).rejects.toThrow(new JudgeRefused(`--result ${result} lies outside the results intent ${intent} accepts, 2 to 4`));
    }
  });
});

describe("judge history refusals", () => {
  it("turns an unreadable profile history or a missing key at creation into a refusal, and passes other errors on", () => {
    const judge = "11111111111111111111111111111111" as Address;
    const thrown = (error: unknown): unknown => {
      try {
        return historyRefused(error);
      } catch (refused) {
        return refused;
      }
    };
    for (const error of [new ProfileHistoryIncomplete(judge), new NoKeyAtCreation(judge, judge)]) {
      const refused = thrown(error);
      expect(refused).toBeInstanceOf(JudgeRefused);
      expect(refused).toMatchObject({ message: error.message });
    }
    const other = new Error("other");
    expect(thrown(other)).toBe(other);
  });
});
