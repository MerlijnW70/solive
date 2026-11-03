import { type Address, lamports } from "@solana/kit";
import { getTokenDecoder, getTokenEncoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { findVaultPda } from "@intent-engine/core/internal";
import { h, type World } from "./harness.js";
import { createIntentOf, execute, ok, served } from "./agent-kit.js";
import { fresh, ok as walletOk } from "./agent-wallet-kit.js";
import { approved } from "./approved.js";

const SIGNATURE_FEE = 5_000n;

const returned = (summary: readonly string[]): bigint => {
  const line = summary.find((entry) => entry.startsWith("Closes the intent")) ?? "";
  return BigInt(/returns their (\d+) lamports/.exec(line)?.[1] ?? "-1");
};

describe("what a closing cancel says it returns", () => {
  it("counts a wrapped SOL escrow's rent and bounty once, as the transaction returns them", async () => {
    const client = await fresh();
    const owner = (await walletOk(client, "wallet_setup"))["address"] as Address;
    const made = await walletOk(client, "wallet_escrow", await approved(client, "wallet_escrow", { sell: "SOL", amount: "0.01", attestor: owner }));
    const kept = await walletOk(client, "wallet_cancel", { nonce: made["nonce"], close: false });
    expect(kept["summary"].at(-1)).toContain("hold 6159600 lamports (0.0061596 SOL) of rent and bounty that are yours");
    const preview = await walletOk(client, "wallet_cancel", { nonce: made["nonce"] });
    const before = h.svm.getBalance(owner) ?? 0n;
    await walletOk(client, "wallet_cancel", { nonce: made["nonce"], send: true });
    const gained = (h.svm.getBalance(owner) ?? 0n) - before + SIGNATURE_FEE;
    expect(returned(preview["summary"])).toBe(6_159_600n);
    expect(gained).toBe(6_159_600n);
  });

  it("states the same figure for a token that is not wrapped SOL", async () => {
    const { w, client } = await served();
    const made = await createIntentOf(client, w, {}, w.owner);
    const preview = await ok(client, "prepare_cancel", { owner: w.owner.address, nonce: made["nonce"], close: true });
    const before = h.svm.getBalance(w.owner.address) ?? 0n;
    await execute(preview["prepared"], w.owner);
    const gained = (h.svm.getBalance(w.owner.address) ?? 0n) - before + SIGNATURE_FEE;
    expect(returned(preview["summary"])).toBe(6_159_600n);
    expect(gained).toBe(6_159_600n);
  });

  it("counts a partly filled wrapped SOL escrow's rent once, with only what is left escrowed", async () => {
    const client = await fresh();
    const owner = (await walletOk(client, "wallet_setup"))["address"] as Address;
    const made = await walletOk(client, "wallet_escrow", await approved(client, "wallet_escrow", { sell: "SOL", amount: "0.01", attestor: owner }));
    const [vault] = await findVaultPda({ intent: made["intent"] as Address });
    const held = h.svm.getAccount(vault);
    if (!held.exists) {
      throw new Error("the vault was not created");
    }
    const taken = 6_000_000n;
    const token = getTokenDecoder().decode(held.data);
    h.svm.setAccount({ ...held, data: Uint8Array.from(getTokenEncoder().encode({ ...token, amount: token.amount - taken })), lamports: lamports(held.lamports - taken) });
    const preview = await walletOk(client, "wallet_cancel", { nonce: made["nonce"] });
    expect(preview["refund"]).toBe("4000000");
    const before = h.svm.getBalance(owner) ?? 0n;
    await walletOk(client, "wallet_cancel", { nonce: made["nonce"], send: true });
    const gained = (h.svm.getBalance(owner) ?? 0n) - before + SIGNATURE_FEE;
    expect(returned(preview["summary"])).toBe(6_159_600n);
    expect(gained).toBe(6_159_600n);
  });

  it("reads the vault's own wrapped state, not the mint", async () => {
    const { w, client } = await served();
    const made = await createIntentOf(client, w, {}, w.owner);
    const [vault] = await findVaultPda({ intent: made["intent"] as Address });
    const plain = await ok(client, "prepare_cancel", { owner: w.owner.address, nonce: made["nonce"], close: true });
    const held = h.svm.getAccount(vault);
    if (!held.exists) {
      throw new Error("the vault was not created");
    }
    const token = getTokenDecoder().decode(held.data);
    const reserve = held.lamports;
    h.svm.setAccount({
      ...held,
      programAddress: TOKEN_PROGRAM_ADDRESS,
      data: Uint8Array.from(getTokenEncoder().encode({ ...token, isNative: { __option: "Some", value: reserve } })),
      lamports: lamports(held.lamports + token.amount),
    });
    const wrapped = await ok(client, "prepare_cancel", { owner: w.owner.address, nonce: made["nonce"], close: true });
    expect(returned(wrapped["summary"])).toBe(returned(plain["summary"]));
    expect(returned(plain["summary"])).toBe(6_159_600n);
  });
});
