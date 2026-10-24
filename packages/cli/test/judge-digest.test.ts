import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { Kind } from "@intent-engine/core";
import { createClient, NoKeyAtCreation, ProfileHistoryIncomplete } from "@intent-engine/client";
import { parse } from "../src/args.js";
import { judgeDigest, type JudgeDigestCommand } from "../src/judge-digest.js";
import { JudgeRefused } from "../src/judge-errors.js";
import { historyRefused } from "../src/judge.js";
import { announced, keyed } from "./announce.js";
import { NOW, transport, world } from "./harness.js";

type Escrow = { owner: Address; intent: Address; announcement: Address; sha256: string; salt: string };

const WORK = createHash("sha256").update("work").digest("hex");

async function escrow(): Promise<Escrow> {
  const w = await world();
  const judge = await generateKeyPairSigner();
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 2n, maxResult: 4n, attestor: judge.address, specHash: new Uint8Array(createHash("sha256").update("spec").digest()), judgeFee: 0n } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  const made = await announced(intent, await keyed(), WORK);
  return { owner: w.owner.address, intent, announcement: made.announcement, sha256: WORK, salt: made.salt };
}

const digestOf = (e: Escrow, result?: string, salt = e.salt) =>
  judgeDigest(
    parse(["judge", "digest", "--owner", e.owner, "--nonce", "0", "--announcement", e.announcement, "--sha256", e.sha256, "--salt", salt, ...(result === undefined ? [] : ["--result", result])], {}) as JudgeDigestCommand,
    transport,
  );

describe("judge digest results", () => {
  it("takes the escrow's lowest and highest result and refuses one outside them", async () => {
    const e = await escrow();
    const ballot = await createClient({ url: "http://cluster", transport }).proofBallot({ owner: e.owner, nonce: 0n, announcement: e.announcement, opening: { sha256: e.sha256, salt: e.salt }, result: 2n });
    expect(await digestOf(e)).toMatchObject({ intent: e.intent, announcement: e.announcement, payee: ballot.payee, result: 2n, digest: Buffer.from(ballot.digest).toString("hex") });
    expect(await digestOf(e, "4")).toMatchObject({ intent: e.intent, result: 4n });
    for (const result of ["1", "5"]) {
      await expect(digestOf(e, result)).rejects.toThrow(new JudgeRefused(`--result ${result} lies outside the results intent ${e.intent} accepts, 2 to 4`));
    }
    await expect(digestOf(e, undefined, "00".repeat(16))).rejects.toThrow("which this salt does not open");
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
