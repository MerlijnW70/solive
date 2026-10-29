import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner } from "@solana/kit";
import type { Client } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it } from "vitest";
import { formatAmount } from "@intent-engine/core";
import { MAX_CLAIM_STAKE, MIN_CLAIM_STAKE, seal } from "@intent-engine/core/internal";
import { MAX_SPEC_BYTES } from "@intent-engine/client/internal";
import { NO_SPEC_HASH, SPEC_ANSWER_OUT, SPEC_NO_ANSWER, STAKE_BELOW_RENT } from "../src/agent/wallet/escrow.js";
import { sealedTooLarge } from "../src/agent/wallet/seal.js";
import { call, fresh, ok } from "./agent-wallet-kit.js";
import { approved } from "./approved.js";
import { h } from "./harness.js";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

const SPEC_URL = "https://" + "example.org/jobs/spec.md";
const SPEC = "# A spec\n\nDeliver the parser.\n";

describe("the claim stake of an escrow", () => {
  let client: Client;
  let wallet: Address;

  beforeEach(async () => {
    client = await fresh();
    wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    h.watched.push(wallet);
  });

  const withStake = (stake: string) => call(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: wallet, spec_hash: "5c".repeat(32), claim_stake: stake, claim_secs: 600 });

  it("takes no stake, the smallest stake and the largest stake, and refuses one lamport either side", async () => {
    expect((await withStake("0")).error).toBe(false);
    expect((await withStake(formatAmount(MIN_CLAIM_STAKE, 9))).error).toBe(false);
    expect((await withStake(formatAmount(MIN_CLAIM_STAKE - 1n, 9))).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "claim_stake", message: STAKE_BELOW_RENT }] });
    expect((await withStake(formatAmount(MAX_CLAIM_STAKE, 9))).error).toBe(false);
    expect((await withStake(formatAmount(MAX_CLAIM_STAKE + 1n, 9))).value).toMatchObject({
      code: "InvalidInput",
      issues: [{ path: "claim_stake", message: `must be at most ${formatAmount(MAX_CLAIM_STAKE, 9)}` }],
    });
  });
});

describe("what an escrow warns about before and after it is sent", () => {
  let client: Client;
  let wallet: Address;

  beforeEach(async () => {
    client = await fresh();
    wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    h.watched.push(wallet);
  });

  it("warns about the answer in a spec in the preview and leaves the warning out of the send", async () => {
    const terms = { sell: "SOL", amount: "0.05", attestor: wallet, spec_hash: "5c".repeat(32) };
    expect((await ok(client, "wallet_escrow", terms))["warnings"]).toContain(SPEC_NO_ANSWER);
    expect(JSON.stringify((await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", terms)))["warnings"])).not.toContain("the earliest announcer is paid");
    const claimed = { ...terms, claim_stake: "0.01", claim_secs: 600 };
    expect((await ok(client, "wallet_escrow", claimed))["warnings"]).toContain(SPEC_ANSWER_OUT);
    expect(JSON.stringify((await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", claimed)))["warnings"])).not.toContain("the earliest announcer is paid");
    const unlisted = { sell: "SOL", amount: "0.05", attestor: wallet };
    expect((await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", unlisted)))["warnings"]).toContain(NO_SPEC_HASH);
  });

  it("names a spec_url whose bytes hash to something else, plain or sealed, in the preview only", async () => {
    const wrong = "7a".repeat(32);
    h.specPages.set(SPEC_URL, new TextEncoder().encode(SPEC));
    const plain = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: wallet, spec_hash: wrong, spec_url: SPEC_URL });
    expect(plain["warnings"]).toContain(`spec_url hashes to ${sha(SPEC)}, not spec_hash ${wrong}; publish the exact bytes, or fix spec_hash`);
    const sealed = await ok(client, "wallet_seal_spec", { text: SPEC, invite: [(await generateKeyPairSigner()).address] });
    h.specPages.set(SPEC_URL, new TextEncoder().encode(sealed["sealed"] as string));
    const opened = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: wallet, spec_hash: wrong, spec_url: SPEC_URL });
    expect(opened["warnings"]).toContain(`spec_url opens to a spec that hashes to ${sha(SPEC)}, not spec_hash ${wrong}; publish the exact bytes, or fix spec_hash`);
  });

  it("names a mismatched spec_url of a plan piece in the preview and not in the send", async () => {
    h.specPages.set(SPEC_URL, new TextEncoder().encode(SPEC));
    const wrong = "7b".repeat(32);
    const plan = { sell: "SOL", attestor: wallet, pieces: [{ name: "a", amount: "0.01", spec_hash: wrong, spec_url: SPEC_URL }, { name: "b", amount: "0.01", spec_hash: wrong }] };
    const line = `Piece 1 (a): spec_url hashes to ${sha(SPEC)}, not spec_hash ${wrong}; publish the exact bytes, or fix spec_hash`;
    expect((await ok(client, "wallet_escrow_plan", plan))["warnings"]).toContain(line);
    const sent = await ok(client, "wallet_escrow_plan", await approved(client, "wallet_escrow_plan", plan));
    expect(sent).toMatchObject({ sent: true });
    expect(sent["warnings"]).not.toContain(line);
  });
});

describe("sealing a spec at the size the tools read", () => {
  it("seals a spec that is exactly as large as the tools read and refuses one byte more", async () => {
    const client = await fresh();
    const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    const other = (await generateKeyPairSigner()).address;
    const lengthAt = async (size: number) => (await seal(new Uint8Array(size).fill(97), [other, wallet])).length;
    let size = Math.floor(((MAX_SPEC_BYTES - (await lengthAt(0))) * 3) / 4);
    while ((await lengthAt(size)) > MAX_SPEC_BYTES) {
      size -= 1;
    }
    while ((await lengthAt(size + 1)) <= MAX_SPEC_BYTES) {
      size += 1;
    }
    expect(await lengthAt(size)).toBeLessThanOrEqual(MAX_SPEC_BYTES);
    expect(await lengthAt(size + 1)).toBeGreaterThan(MAX_SPEC_BYTES);
    const fits = await ok(client, "wallet_seal_spec", { text: "a".repeat(size), invite: [other] });
    expect((fits["sealed"] as string).length).toBe(await lengthAt(size));
    const over = await call(client, "wallet_seal_spec", { text: "a".repeat(size + 1), invite: [other] });
    expect(over.value).toMatchObject({ code: "InvalidInput", issues: [{ path: "text", message: sealedTooLarge(await lengthAt(size + 1)) }] });
  });
});
