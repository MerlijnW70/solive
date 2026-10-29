import { type Address, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { Kind } from "@intent-engine/core";
import { claimBoardAddress, claimListAddress } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { EXIT_FAILED, EXIT_OK } from "../src/main.js";
import { cli, funded, NOW, setNow, transport, world } from "./harness.js";

async function escrows() {
  const w = await world();
  const judge = (await generateKeyPairSigner()).address;
  const holder = await funded();
  const other = await funded();
  const keys: Record<string, KeyPairSigner> = { "owner.json": w.owner, "holder.json": holder, "other.json": other };
  const made: Address[] = [];
  for (const nonce of [0n, 1n]) {
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge, specHash: new Uint8Array(32).fill(7), judgeFee: 0n } as const;
    const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce, expiresAt: NOW + 3_600n });
    made.push(intent);
  }
  const run = async (args: string[]) => {
    const done = await cli(args, keys);
    expect([done.code, done.err]).toStrictEqual([EXIT_OK, ""]);
    return done;
  };
  return { w, holder, other, keys, intents: made, run, owner: w.owner.address };
}

const open = (nonce: string, extra: string[] = []) => ["claims", "open", "--keypair", "owner.json", "--nonce", nonce, "--max-secs", "3600", "--stake", "0.05", ...extra, "--yes"];

describe("claims standby", () => {
  it("keeps the holder out of its own line and lets any other wallet join it", async () => {
    const e = await escrows();
    await e.run(open("0"));
    await e.run(["claims", "take", "--keypair", "holder.json", "--owner", e.owner, "--nonce", "0", "--secs", "600", "--yes"]);
    const standby = (who: string) => cli(["claims", "standby", "--keypair", who, "--owner", e.owner, "--nonce", "0", "--secs", "600"], e.keys);
    const holding = await standby("holder.json");
    expect(holding.code).toBe(EXIT_FAILED);
    expect(holding.err).toBe(`${e.holder.address} holds the claim on escrow ${e.intents[0]}, and the holder cannot stand by for its own job; nothing was sent`);
    const joining = await standby("other.json");
    expect([joining.code, joining.err, joining.json()["sent"]]).toStrictEqual([EXIT_OK, "", false]);
  });
});

describe("claims settle", () => {
  it("names the claim list only when the board has one, and its rent in the singular or plural", async () => {
    const e = await escrows();
    await e.run(open("0"));
    await e.run(open("1", ["--workers", e.other.address]));
    setNow(NOW + 3_700n);
    const settle = (nonce: string) => e.run(["claims", "settle", "--keypair", "holder.json", "--owner", e.owner, "--nonce", nonce]);
    const plain = (await settle("0")).json()["summary"] as string[];
    expect(plain[1]).toBe(`Closes: the claims board ${await claimBoardAddress(e.intents[0] as Address)}, returning its rent to the owner ${e.owner}`);
    const listed = (await settle("1")).json()["summary"] as string[];
    expect(listed[1]).toBe(
      `Closes: the claims board ${await claimBoardAddress(e.intents[1] as Address)} and its claim list ${await claimListAddress(e.intents[1] as Address)}, returning their rent to the owner ${e.owner}`,
    );
  });
});
